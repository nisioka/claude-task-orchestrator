import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Which of the human's open pull requests can be merged right now.
 *
 * Judged from GitHub's own state only: draft, mergeability, the checks on the
 * head commit, and a merge-order line in the body. Whatever cannot be proven
 * ready is held back, so the judgement errs towards calling less ready.
 * Read-only: it never merges, labels or comments.
 *
 * Merge order is read from one line in the body and from nothing else:
 *
 *     merge-after: owner/repo#123
 *
 * The line names the pull requests that must be merged first, separated by
 * spaces or commas, as `owner/repo#N`, `#N` (same repository) or a pull request
 * URL. A pull request with such a line is held back until every one it names
 * is merged. Lines inside fenced code blocks are ignored, so a body can
 * show the format without being bound by it.
 */

const execFileAsync = promisify(execFile);

export const MERGE_AFTER_KEY = "merge-after";

/** The open pull requests the list is drawn from: the same set as `gh search prs --author @me --state open`. */
const SEARCH_QUERY = "is:pr is:open author:@me";
const SEARCH_LIMIT = 100;
const CHECK_SUITE_LIMIT = 100;
const CHECK_RUN_LIMIT = 100;
const CONCURRENCY = 4;
/** GitHub computes mergeability lazily; the first read of a pull request often answers UNKNOWN. */
const MERGEABLE_RETRY_MS = 2000;

// ─── Merge order ────────────────────────────────────────────────────

export interface PullRequestRef {
  repo: string;
  number: number;
}

export function refKey(ref: PullRequestRef): string {
  return `${ref.repo.toLowerCase()}#${ref.number}`;
}

export interface MergeAfter {
  refs: PullRequestRef[];
  /** Tokens on a merge-after line that name no pull request. */
  invalid: string[];
}

const MERGE_AFTER_LINE = new RegExp(`^\\s*(?:[-*+]\\s+)?${MERGE_AFTER_KEY}\\s*:(.*)$`, "i");
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
/** A closing fence carries nothing after the marker; a line like ```js inside a block is content. */
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const REPO = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
const SAME_REPO_REF = /^#(\d+)$/;
const FULL_REF = new RegExp(`^(${REPO})#(\\d+)$`);
const URL_REF = new RegExp(`^https://github\\.com/(${REPO})/pull/(\\d+)/?$`);

function parseRef(token: string, ownRepo: string): PullRequestRef | null {
  const same = token.match(SAME_REPO_REF);
  if (same) return { repo: ownRepo, number: Number(same[1]) };
  const full = token.match(FULL_REF) ?? token.match(URL_REF);
  if (full) return { repo: full[1], number: Number(full[2]) };
  return null;
}

/** The pull requests a body says must be merged before it. */
export function parseMergeAfter(body: string, ownRepo: string): MergeAfter {
  const refs = new Map<string, PullRequestRef>();
  const invalid: string[] = [];
  let fence: string | null = null;

  for (const line of body.split(/\r?\n/)) {
    if (fence !== null) {
      const close = line.match(FENCE_CLOSE)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(FENCE_OPEN)?.[1];
    if (open) {
      fence = open;
      continue;
    }

    const value = line.match(MERGE_AFTER_LINE)?.[1];
    if (value === undefined) continue;
    const tokens = value.split(/[\s,]+/).filter((t) => t !== "");
    if (tokens.length === 0) invalid.push(line.trim());
    for (const token of tokens) {
      const ref = parseRef(token, ownRepo);
      if (ref) refs.set(refKey(ref), ref);
      else invalid.push(token);
    }
  }
  return { refs: [...refs.values()], invalid };
}

// ─── Checks ─────────────────────────────────────────────────────────

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface CheckSuite {
  app: string | null;
  status: string;
  conclusion: string | null;
  /** Set for GitHub Actions: the workflow run behind the suite. */
  workflowRun: { workflowId: string; workflowName: string; event: string; runNumber: number } | null;
  /** The latest attempt of each check, as GitHub lists them by default. */
  checkRuns: CheckRun[];
  /** More runs than were read: the rest cannot be judged. */
  checkRunsTruncated: boolean;
}

export interface StatusContext {
  context: string;
  state: string;
}

export interface HeadChecks {
  suites: CheckSuite[];
  suitesTruncated: boolean;
  statuses: StatusContext[];
}

export type ChecksVerdict =
  | { state: "passed" }
  | { state: "pending" | "failed" | "unknown"; detail: string };

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const PENDING_STATUS_STATES = new Set(["PENDING", "EXPECTED"]);
/** Nightly runs check the default branch, not the pull request, and nothing makes them required. */
const IGNORED_EVENTS = new Set(["schedule"]);

/**
 * The suites that speak for the head commit now.
 *
 * - A workflow that ran more than once for the same event keeps only its newest
 *   run. The older ones were superseded, typically cancelled when the next one
 *   started, and would otherwise read as failures forever.
 * - Scheduled runs are dropped.
 * - A suite with no check runs from an app other than Actions is an app that
 *   never reports (GitHub opens a suite for every installed app). An Actions
 *   suite with no runs yet is a queued workflow, and stays.
 */
function currentSuites(suites: CheckSuite[]): CheckSuite[] {
  const newest = new Map<string, CheckSuite>();
  const others: CheckSuite[] = [];
  for (const suite of suites) {
    const run = suite.workflowRun;
    if (run === null) {
      if (suite.checkRuns.length > 0 || suite.checkRunsTruncated) others.push(suite);
      continue;
    }
    if (IGNORED_EVENTS.has(run.event)) continue;
    const key = `${run.workflowId}\n${run.event}`;
    const seen = newest.get(key);
    if (!seen || seen.workflowRun!.runNumber < run.runNumber) newest.set(key, suite);
  }
  return [...others, ...newest.values()];
}

function listed(names: string[]): string {
  const unique = [...new Set(names)];
  return unique.length > 3 ? `${unique.slice(0, 3).join(", ")} ほか${unique.length - 3}件` : unique.join(", ");
}

/** Whether every check on the head commit has passed. */
export function assessChecks(head: HeadChecks): ChecksVerdict {
  if (head.suitesTruncated) return { state: "unknown", detail: "チェックが多すぎて読み切れない" };

  const failed: string[] = [];
  const pending: string[] = [];
  const unread: string[] = [];
  for (const suite of currentSuites(head.suites)) {
    const label = suite.workflowRun?.workflowName ?? suite.app ?? "不明なアプリ";
    if (suite.checkRunsTruncated) unread.push(label);
    if (suite.workflowRun) {
      if (suite.status !== "COMPLETED") pending.push(label);
      else if (!PASSING_CONCLUSIONS.has(suite.conclusion ?? "")) failed.push(label);
    }
    for (const run of suite.checkRuns) {
      if (run.status !== "COMPLETED") pending.push(run.name);
      else if (!PASSING_CONCLUSIONS.has(run.conclusion ?? "")) failed.push(run.name);
    }
  }
  for (const status of head.statuses) {
    if (status.state === "SUCCESS") continue;
    if (PENDING_STATUS_STATES.has(status.state)) pending.push(status.context);
    else failed.push(status.context);
  }

  if (failed.length > 0) return { state: "failed", detail: listed(failed) };
  if (pending.length > 0) return { state: "pending", detail: listed(pending) };
  if (unread.length > 0) return { state: "unknown", detail: `読み切れない: ${listed(unread)}` };
  return { state: "passed" };
}

// ─── Judgement ──────────────────────────────────────────────────────

export interface OpenPullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  /** MERGEABLE, CONFLICTING or UNKNOWN, as GitHub reports it. */
  mergeable: string;
  /** GitHub's mergeStateStatus. Null when it was not read. */
  mergeStateStatus: string | null;
  body: string;
  /** Null when the checks were not read. */
  checks: ChecksVerdict | null;
}

/** A pull request named in a merge-after line that is not one of the open ones. */
export type PrerequisiteState = "MERGED" | "OPEN" | "CLOSED" | "UNKNOWN";

export interface WaitingPullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Nothing else holds it: once this one is merged, it may be merged next. */
  nextUp: boolean;
}

export interface MergeablePullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Open pull requests whose merge-after line names this one. */
  waiting: WaitingPullRequest[];
}

export interface HeldPullRequest extends MergeablePullRequest {
  reasons: string[];
}

export interface MergeableView {
  ready: MergeablePullRequest[];
  held: HeldPullRequest[];
}

/**
 * GitHub merge states that let a pull request through; any other, including one GitHub adds later, holds it.
 * UNSTABLE is GitHub's verdict on the checks, which also counts the runs `assessChecks` deliberately
 * ignores, such as scheduled ones. The checks are judged there instead.
 */
const PASSING_MERGE_STATES = new Set(["CLEAN", "UNSTABLE", "HAS_HOOKS"]);

function refLabel(ref: PullRequestRef): string {
  return `${ref.repo}#${ref.number}`;
}

function ownReasons(pr: OpenPullRequest): string[] {
  const reasons: string[] = [];
  if (pr.isDraft) reasons.push("draft");
  if (pr.mergeable === "CONFLICTING") reasons.push("コンフリクトしている");
  else if (pr.mergeable !== "MERGEABLE") reasons.push("マージできるかを確かめられない");
  if (pr.mergeStateStatus === null || !PASSING_MERGE_STATES.has(pr.mergeStateStatus)) {
    reasons.push(`GitHub のマージ状態が ${pr.mergeStateStatus ?? "不明"}`);
  }
  const checks = pr.checks;
  if (checks === null) reasons.push("チェックを読んでいない");
  else if (checks.state === "failed") reasons.push(`チェックが失敗: ${checks.detail}`);
  else if (checks.state === "pending") reasons.push(`チェックが終わっていない: ${checks.detail}`);
  else if (checks.state === "unknown") reasons.push(`チェックを確かめられない: ${checks.detail}`);
  return reasons;
}

/** The pull requests named in merge-after lines that are not among the open ones, to be looked up. */
export function prerequisitesToLookUp(prs: OpenPullRequest[]): PullRequestRef[] {
  const open = new Set(prs.map(refKey));
  const wanted = new Map<string, PullRequestRef>();
  for (const pr of prs) {
    for (const ref of parseMergeAfter(pr.body, pr.repo).refs) {
      if (!open.has(refKey(ref))) wanted.set(refKey(ref), ref);
    }
  }
  return [...wanted.values()];
}

/**
 * Splits the open pull requests into those that may be merged now and those held back.
 *
 * `prerequisites` gives the state of each pull request named in a merge-after
 * line that is not itself open here; one missing from it counts as unknown.
 */
export function judgeMergeable(
  prs: OpenPullRequest[],
  prerequisites: Map<string, PrerequisiteState>,
): MergeableView {
  const open = new Map(prs.map((pr) => [refKey(pr), pr]));

  const judged = prs.map((pr) => {
    const own = ownReasons(pr);
    const order: string[] = [];
    const waitingOn: string[] = [];
    const mergeAfter = parseMergeAfter(pr.body, pr.repo);
    for (const token of mergeAfter.invalid) order.push(`${MERGE_AFTER_KEY} を読めない: ${token}`);
    for (const ref of mergeAfter.refs) {
      const key = refKey(ref);
      const state = open.has(key) ? "OPEN" : (prerequisites.get(key) ?? "UNKNOWN");
      if (state === "MERGED") continue;
      if (open.has(key)) waitingOn.push(key);
      order.push(
        state === "OPEN"
          ? `先に ${refLabel(ref)} のマージが要る`
          : state === "CLOSED"
            ? `${refLabel(ref)} はマージされずに閉じた`
            : `${refLabel(ref)} の状態を確かめられない`,
      );
    }
    return { pr, own, order, waitingOn };
  });

  const ready: MergeablePullRequest[] = [];
  const held: HeldPullRequest[] = [];
  for (const { pr, own, order } of judged) {
    const key = refKey(pr);
    const entry: MergeablePullRequest = {
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      waiting: judged
        .filter((other) => other.waitingOn.includes(key))
        .map((other) => ({
          repo: other.pr.repo,
          number: other.pr.number,
          title: other.pr.title,
          url: other.pr.url,
          nextUp: other.own.length === 0 && other.order.length === 1,
        })),
    };
    if (own.length === 0 && order.length === 0) ready.push(entry);
    else held.push({ ...entry, reasons: [...own, ...order] });
  }
  return { ready, held };
}

// ─── Reading GitHub ─────────────────────────────────────────────────

export type GraphqlRunner = (query: string, variables: Record<string, string | number>) => Promise<unknown>;

const SEARCH_GRAPHQL = `query($q: String!) {
  search(query: $q, type: ISSUE, first: ${SEARCH_LIMIT}) {
    nodes { ... on PullRequest { number title url isDraft mergeable body repository { nameWithOwner } } }
  }
}`;

const DETAIL_GRAPHQL = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      isDraft mergeable mergeStateStatus
      commits(last: 1) { nodes { commit {
        checkSuites(first: ${CHECK_SUITE_LIMIT}) {
          totalCount
          nodes {
            status conclusion
            app { slug }
            workflowRun { event runNumber workflow { databaseId name } }
            checkRuns(first: ${CHECK_RUN_LIMIT}) { totalCount nodes { name status conclusion } }
          }
        }
        status { contexts { context state } }
      } } }
    }
  }
}`;

const STATE_GRAPHQL = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { state } }
}`;

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {};
}

function nodes(value: unknown): Json[] {
  const list = obj(value).nodes;
  return Array.isArray(list) ? list.map(obj) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The search result, without checks. Rows that are not pull requests are skipped. */
export function parseSearch(data: unknown): Omit<OpenPullRequest, "checks" | "mergeStateStatus">[] {
  return nodes(obj(data).search).flatMap((node) => {
    const repo = str(obj(node.repository).nameWithOwner);
    const url = str(node.url);
    if (repo === null || url === null || typeof node.number !== "number") return [];
    return [{
      repo,
      number: node.number,
      title: str(node.title) ?? "",
      url,
      isDraft: node.isDraft === true,
      mergeable: str(node.mergeable) ?? "UNKNOWN",
      body: str(node.body) ?? "",
    }];
  });
}

export interface PullRequestDetail {
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string | null;
  head: HeadChecks;
}

export function parseDetail(data: unknown): PullRequestDetail {
  const pr = obj(obj(obj(data).repository).pullRequest);
  if (Object.keys(pr).length === 0) throw new Error("pull request not found");
  const commit = obj(nodes(pr.commits)[0]?.commit);
  const suites = obj(commit.checkSuites);
  const suiteNodes = nodes(suites);
  const contexts = obj(commit.status).contexts;
  return {
    isDraft: pr.isDraft === true,
    mergeable: str(pr.mergeable) ?? "UNKNOWN",
    mergeStateStatus: str(pr.mergeStateStatus),
    head: {
      suitesTruncated: typeof suites.totalCount === "number" && suites.totalCount > suiteNodes.length,
      suites: suiteNodes.map((suite) => {
        const runs = obj(suite.checkRuns);
        const runNodes = nodes(runs);
        const workflowRun = suite.workflowRun ? obj(suite.workflowRun) : null;
        const workflow = obj(workflowRun?.workflow);
        return {
          app: str(obj(suite.app).slug),
          status: str(suite.status) ?? "UNKNOWN",
          conclusion: str(suite.conclusion),
          workflowRun: workflowRun
            ? {
                workflowId: String(workflow.databaseId ?? workflow.name ?? ""),
                workflowName: str(workflow.name) ?? "",
                event: str(workflowRun.event) ?? "",
                runNumber: typeof workflowRun.runNumber === "number" ? workflowRun.runNumber : 0,
              }
            : null,
          checkRuns: runNodes.map((run) => ({
            name: str(run.name) ?? "",
            status: str(run.status) ?? "UNKNOWN",
            conclusion: str(run.conclusion),
          })),
          checkRunsTruncated: typeof runs.totalCount === "number" && runs.totalCount > runNodes.length,
        };
      }),
      statuses: (Array.isArray(contexts) ? contexts.map(obj) : []).map((c) => ({
        context: str(c.context) ?? "",
        state: str(c.state) ?? "UNKNOWN",
      })),
    },
  };
}

export function parsePrerequisiteState(data: unknown): PrerequisiteState {
  const state = str(obj(obj(obj(data).repository).pullRequest).state);
  return state === "MERGED" || state === "OPEN" || state === "CLOSED" ? state : "UNKNOWN";
}

async function ghGraphql(query: string, variables: Record<string, string | number>): Promise<unknown> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    // -F would turn a string like "123" into a number; only numbers go through it.
    args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
  }
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 20 * 1024 * 1024, timeout: 60 * 1000 });
  const parsed = obj(JSON.parse(stdout));
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((e) => str(obj(e).message) ?? "GraphQL error").join("; "));
  }
  return parsed.data;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function repoVariables(ref: PullRequestRef): { owner: string; name: string; number: number } {
  const [owner, name] = ref.repo.split("/");
  return { owner, name, number: ref.number };
}

export interface CollectOptions {
  run?: GraphqlRunner;
  /** How long to wait before asking again for a mergeability GitHub has not computed yet. */
  retryDelayMs?: number;
}

/**
 * Reads the human's open pull requests and judges which may be merged now.
 *
 * The search failing fails the whole panel. Any one pull request or
 * prerequisite that cannot be read only holds that pull request back.
 */
export async function collectMergeablePrs(options: CollectOptions = {}): Promise<MergeableView> {
  const run = options.run ?? ghGraphql;
  const retryDelayMs = options.retryDelayMs ?? MERGEABLE_RETRY_MS;
  const found = parseSearch(await run(SEARCH_GRAPHQL, { q: SEARCH_QUERY }));

  const readDetail = async (ref: PullRequestRef): Promise<PullRequestDetail> => {
    let detail = parseDetail(await run(DETAIL_GRAPHQL, repoVariables(ref)));
    if (detail.mergeable === "UNKNOWN") {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      detail = parseDetail(await run(DETAIL_GRAPHQL, repoVariables(ref)));
    }
    return detail;
  };

  const prs = await mapLimit(found, CONCURRENCY, async (pr): Promise<OpenPullRequest> => {
    // Neither a draft nor a conflict can be ready, so their checks are not worth a request.
    if (pr.isDraft || pr.mergeable === "CONFLICTING") return { ...pr, mergeStateStatus: null, checks: null };
    try {
      const detail = await readDetail(pr);
      return {
        ...pr,
        isDraft: detail.isDraft,
        mergeable: detail.mergeable,
        mergeStateStatus: detail.mergeStateStatus,
        checks: assessChecks(detail.head),
      };
    } catch {
      return { ...pr, mergeStateStatus: null, checks: null };
    }
  });

  const lookups = prerequisitesToLookUp(prs);
  const states = await mapLimit(lookups, CONCURRENCY, async (ref): Promise<PrerequisiteState> => {
    try {
      return parsePrerequisiteState(await run(STATE_GRAPHQL, repoVariables(ref)));
    } catch {
      return "UNKNOWN";
    }
  });
  return judgeMergeable(prs, new Map(lookups.map((ref, i) => [refKey(ref), states[i]])));
}

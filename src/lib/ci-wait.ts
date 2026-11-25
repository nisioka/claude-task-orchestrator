import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Wait for the CI of a pull request or a branch to settle, then describe it once.
 *
 * The verdict is taken from workflow runs, not from the check list a pull
 * request shows. A queued run has no check runs yet, and a job created later in
 * a running workflow appears only after the earlier ones finish, so the check
 * list can momentarily read as all done while work is still to come. A run
 * stays in progress across both.
 *
 * Pure decisions live here and take a snapshot; reading GitHub is a separate
 * layer so the decisions can be tested without it.
 */

const execFileAsync = promisify(execFile);

// ─── Shapes ─────────────────────────────────────────────────────────

export interface WorkflowRun {
  id: number;
  name: string;
  workflowId: number;
  event: string;
  status: string;
  conclusion: string | null;
  runNumber: number;
  runAttempt: number;
}

/** A check run reported by an app other than GitHub Actions. */
export interface AppCheck {
  app: string;
  name: string;
  status: string;
  conclusion: string | null;
  title: string | null;
}

export interface CommitStatus {
  context: string;
  state: string;
  description: string | null;
}

export interface PullRequestState {
  /** OPEN, MERGED or CLOSED. */
  state: string;
  /** MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string;
}

export interface Snapshot {
  head: string;
  /** Who made the head commit. Read only when the head moves. */
  headAuthor: string | null;
  /** Null when waiting on a branch rather than a pull request. */
  pullRequest: PullRequestState | null;
  runs: WorkflowRun[];
  appChecks: AppCheck[];
  statuses: CommitStatus[];
}

export type Outcome = "success" | "failure" | "cancelled" | "timeout" | "conflict" | "no-runs" | "closed";

export interface HeadChange {
  from: string;
  to: string;
  author: string | null;
}

export interface WaitOptions {
  timeoutMs: number;
  /** How long a head may go without a single workflow run before the wait gives up on it. */
  noRunsMs: number;
  reviewBots: RegExp;
}

export interface WaitState {
  startedAt: number;
  head: string | null;
  /** When the current head was first seen. The no-runs limit counts from here. */
  headSince: number;
  headChanges: HeadChange[];
  /** Fingerprint of the last read that looked settled. Two equal ones in a row end the wait. */
  settled: string | null;
}

export type Step =
  | { done: false; state: WaitState }
  | { done: true; state: WaitState; outcome: Outcome; snapshot: Snapshot };

export const DEFAULT_TIMEOUT_MINUTES = 90;
export const NO_RUNS_MINUTES = 10;
export const POLL_SECONDS = 60;
/** Apps that review code. Their checks do not gate the wait; their state is reported in one line. */
export const DEFAULT_REVIEW_BOTS = /coderabbit|gemini|copilot/i;

const PASSING = new Set(["success", "skipped", "neutral"]);
const CANCELLED = new Set(["cancelled", "stale"]);
/** Runs that check something other than the commit under review. */
const IGNORED_EVENTS = new Set(["schedule"]);
const PENDING_STATUS = new Set(["pending", "expected"]);

export function initialState(now: number): WaitState {
  return { startedAt: now, head: null, headSince: now, headChanges: [], settled: null };
}

// ─── Decisions ──────────────────────────────────────────────────────

/**
 * The runs that speak for the commit now: the newest of each workflow and event.
 * An older run of the same workflow was superseded, usually cancelled when the
 * newer one started, and would otherwise read as a cancellation forever.
 */
export function currentRuns(runs: WorkflowRun[]): WorkflowRun[] {
  const newest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    if (IGNORED_EVENTS.has(run.event)) continue;
    const key = `${run.workflowId}\n${run.event}`;
    const seen = newest.get(key);
    if (!seen || seen.runNumber < run.runNumber) newest.set(key, run);
  }
  return [...newest.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

function isReviewBotCheck(check: AppCheck, reviewBots: RegExp): boolean {
  return reviewBots.test(check.app) || reviewBots.test(check.name);
}

function gatingChecks(snapshot: Snapshot, reviewBots: RegExp): AppCheck[] {
  return snapshot.appChecks.filter((c) => !isReviewBotCheck(c, reviewBots));
}

function gatingStatuses(snapshot: Snapshot, reviewBots: RegExp): CommitStatus[] {
  return snapshot.statuses.filter((s) => !reviewBots.test(s.context));
}

/** Every run, gating check and gating status on the head has finished, and there is at least one run. */
export function isSettled(snapshot: Snapshot, reviewBots: RegExp): boolean {
  const runs = currentRuns(snapshot.runs);
  if (runs.length === 0) return false;
  if (runs.some((r) => r.status !== "completed")) return false;
  if (gatingChecks(snapshot, reviewBots).some((c) => c.status !== "completed")) return false;
  if (gatingStatuses(snapshot, reviewBots).some((s) => PENDING_STATUS.has(s.state))) return false;
  return true;
}

/** What a settled read is compared by. A run created between two reads changes it. */
export function fingerprint(snapshot: Snapshot, reviewBots: RegExp): string {
  const runs = currentRuns(snapshot.runs).map((r) => `${r.id}.${r.runAttempt}:${r.status}:${r.conclusion ?? ""}`);
  const checks = gatingChecks(snapshot, reviewBots).map((c) => `${c.app}/${c.name}:${c.status}:${c.conclusion ?? ""}`);
  const statuses = gatingStatuses(snapshot, reviewBots).map((s) => `${s.context}:${s.state}`);
  return [snapshot.head, ...runs.sort(), ...checks.sort(), ...statuses.sort()].join("\n");
}

export interface TallyEntry {
  name: string;
  conclusion: string;
  /** Set for a workflow run, so the summary can replace it with its jobs. Null for checks and statuses. */
  runId: number | null;
}

export interface Tally {
  failed: TallyEntry[];
  cancelled: TallyEntry[];
  pending: string[];
}

/** Gating results by kind, at run level. Failed jobs inside a run are named by the summary. */
export function tally(snapshot: Snapshot, reviewBots: RegExp): Tally {
  const out: Tally = { failed: [], cancelled: [], pending: [] };
  const judge = (name: string, finished: boolean, conclusion: string | null, runId: number | null) => {
    const entry = { name, conclusion: conclusion ?? "結論なし", runId };
    if (!finished) out.pending.push(name);
    else if (CANCELLED.has(conclusion ?? "")) out.cancelled.push(entry);
    else if (!PASSING.has(conclusion ?? "")) out.failed.push(entry);
  };
  for (const run of currentRuns(snapshot.runs)) judge(run.name, run.status === "completed", run.conclusion, run.id);
  for (const check of gatingChecks(snapshot, reviewBots)) judge(check.name, check.status === "completed", check.conclusion, null);
  for (const status of gatingStatuses(snapshot, reviewBots)) {
    if (PENDING_STATUS.has(status.state)) out.pending.push(status.context);
    else if (status.state !== "success") out.failed.push({ name: status.context, conclusion: status.state, runId: null });
  }
  return out;
}

export function settledOutcome(snapshot: Snapshot, reviewBots: RegExp): "success" | "failure" | "cancelled" {
  const t = tally(snapshot, reviewBots);
  if (t.failed.length > 0) return "failure";
  if (t.cancelled.length > 0) return "cancelled";
  return "success";
}

/**
 * One read's worth of progress.
 *
 * A moved head is followed before the read is compared with the previous one,
 * so a settled read of the old head can never pair with a read of the new one.
 */
export function step(previous: WaitState, snapshot: Snapshot, now: number, options: WaitOptions): Step {
  const state: WaitState = { ...previous, headChanges: [...previous.headChanges] };
  const finish = (outcome: Outcome): Step => ({ done: true, state, outcome, snapshot });

  if (state.head === null) {
    state.head = snapshot.head;
    state.headSince = now;
  } else if (state.head !== snapshot.head) {
    state.headChanges.push({ from: state.head, to: snapshot.head, author: snapshot.headAuthor });
    state.head = snapshot.head;
    state.headSince = now;
    state.settled = null;
  }

  const pr = snapshot.pullRequest;
  if (pr && pr.state !== "OPEN") return finish("closed");
  if (pr && pr.mergeable === "CONFLICTING") return finish("conflict");

  if (isSettled(snapshot, options.reviewBots)) {
    const print = fingerprint(snapshot, options.reviewBots);
    if (state.settled === print) return finish(settledOutcome(snapshot, options.reviewBots));
    state.settled = print;
  } else {
    state.settled = null;
  }

  if (currentRuns(snapshot.runs).length === 0 && now - state.headSince >= options.noRunsMs) return finish("no-runs");
  if (now - state.startedAt >= options.timeoutMs) return finish("timeout");
  return { done: false, state };
}

// ─── Summary ────────────────────────────────────────────────────────

export interface JobDetail {
  /** `<workflow> / <job>` */
  name: string;
  conclusion: string;
  annotations: string[];
  logTail: string[];
}

export interface JobDetails {
  /** Failed jobs given in full: annotations and the end of the failed step's log. */
  failedJobs: JobDetail[];
  /** Failed jobs past the ones given in full, by name and conclusion only. */
  omittedJobs: string[];
  cancelledJobs: string[];
  /** Ids of the runs whose jobs were read. Their run-level entry is replaced by the jobs. */
  readRuns: number[];
}

export const NO_JOB_DETAILS: JobDetails = { failedJobs: [], omittedJobs: [], cancelledJobs: [], readRuns: [] };

export interface SummaryInput {
  target: string;
  outcome: Outcome;
  state: WaitState;
  snapshot: Snapshot;
  now: number;
  reviewBots: RegExp;
  noRunsMinutes: number;
  jobs: JobDetails;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function listOrNone(items: string[]): string {
  return items.length > 0 ? [...new Set(items)].join(", ") : "なし";
}

export function reviewBotLine(snapshot: Snapshot, reviewBots: RegExp): string {
  const parts: string[] = [];
  for (const c of snapshot.appChecks) {
    if (!isReviewBotCheck(c, reviewBots)) continue;
    const state = c.status === "completed" ? (c.conclusion ?? "結論なし") : c.status;
    parts.push([c.name, state, c.title].filter(Boolean).join(" "));
  }
  for (const s of snapshot.statuses) {
    if (!reviewBots.test(s.context)) continue;
    parts.push([s.context, s.state, s.description].filter(Boolean).join(" "));
  }
  return `レビューボット: ${parts.length > 0 ? parts.join(" / ") : "なし"}`;
}

export function renderSummary(input: SummaryInput): string {
  const { snapshot, state, outcome, jobs } = input;
  const lines = [`結果: ${outcome}`, `対象: ${input.target} head ${short(snapshot.head)}`];

  for (const change of state.headChanges) {
    lines.push(`head が変わった: ${short(change.from)} → ${short(change.to)}、${change.author ?? "作者不明"} が push`);
  }

  if (outcome === "conflict") {
    lines.push("PR がコンフリクトしている。pull_request の CI は走らない");
  } else if (outcome === "closed") {
    lines.push(`PR は ${snapshot.pullRequest?.state ?? "閉じている"}`);
  } else if (outcome === "no-runs") {
    lines.push(`head ${short(snapshot.head)} に workflow run が ${input.noRunsMinutes} 分たっても1本も無い`);
  } else {
    const t = tally(snapshot, input.reviewBots);
    const read = new Set(jobs.readRuns);
    const unread = (e: TallyEntry) => e.runId === null || !read.has(e.runId);
    const failed = [
      ...jobs.failedJobs.map((j) => `${j.name}: ${j.conclusion}`),
      ...jobs.omittedJobs,
      ...t.failed.filter(unread).map((f) => `${f.name}: ${f.conclusion}`),
    ];
    const cancelled = [...jobs.cancelledJobs, ...t.cancelled.filter(unread).map((c) => c.name)];
    lines.push(`失敗: ${listOrNone(failed)}`);
    lines.push(`取消: ${listOrNone(cancelled)}`);
    if (outcome === "timeout") lines.push(`終わっていない: ${listOrNone(t.pending)}`);
  }

  lines.push(reviewBotLine(snapshot, input.reviewBots));
  lines.push(`待った時間: ${Math.round((input.now - state.startedAt) / 60_000)} 分`);

  for (const job of jobs.failedJobs) {
    lines.push("", `--- ${job.name}: ${job.conclusion}`);
    if (job.annotations.length > 0) lines.push("annotations:", ...job.annotations.map((a) => `  ${a}`));
    if (job.logTail.length > 0) lines.push(`失敗したステップのログの末尾 ${job.logTail.length} 行:`, ...job.logTail);
    else lines.push("失敗したステップのログを読めなかった");
  }
  return lines.join("\n");
}

// ─── Log helpers ────────────────────────────────────────────────────

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
/** Every failed step ends with this annotation; it says nothing the conclusion does not. */
const EXIT_CODE_ANNOTATION = /^Process completed with exit code \d+\.?$/;

/** `gh run view --log-failed` prefixes each line with the job and step name; keep the text only. */
export function tailFailedLog(raw: string, lines: number): string[] {
  const text = raw.split("\n").map((line) => {
    const parts = line.split("\t");
    const body = parts.length >= 3 ? parts.slice(2).join("\t") : line;
    return body.replace(ANSI, "").replace(TIMESTAMP, "").trimEnd();
  });
  while (text.length > 0 && text[text.length - 1] === "") text.pop();
  return text.slice(-lines);
}

export interface Annotation {
  path: string;
  line: number | null;
  level: string;
  message: string;
}

export function formatAnnotations(annotations: Annotation[], limit: number): string[] {
  return annotations
    .filter((a) => !EXIT_CODE_ANNOTATION.test(a.message.trim()))
    .slice(0, limit)
    .map((a) => {
      const where = a.path && a.path !== ".github" ? `${a.path}${a.line ? `:${a.line}` : ""} ` : "";
      return `${a.level} ${where}${a.message.split("\n")[0]}`;
    });
}

// ─── Reading GitHub ─────────────────────────────────────────────────

export type GhRunner = (args: string[]) => Promise<string>;

export const runGh: GhRunner = async (args) => {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
};

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(obj) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

export function parseRuns(data: unknown): WorkflowRun[] {
  return list(obj(data).workflow_runs).map((r) => ({
    id: num(r.id),
    name: str(r.name) ?? "名前なし",
    workflowId: num(r.workflow_id),
    event: str(r.event) ?? "",
    status: str(r.status) ?? "",
    conclusion: str(r.conclusion),
    runNumber: num(r.run_number),
    runAttempt: num(r.run_attempt),
  }));
}

export function parseAppChecks(data: unknown): AppCheck[] {
  return list(obj(data).check_runs)
    .filter((c) => str(obj(c.app).slug) !== "github-actions")
    .map((c) => ({
      app: str(obj(c.app).slug) ?? "",
      name: str(c.name) ?? "",
      status: str(c.status) ?? "",
      conclusion: str(c.conclusion),
      title: str(obj(c.output).title),
    }));
}

export function parseStatuses(data: unknown): CommitStatus[] {
  return list(obj(data).statuses).map((s) => ({
    context: str(s.context) ?? "",
    state: str(s.state) ?? "",
    description: str(s.description),
  }));
}

export type Target = { repo: string; pr: number } | { repo: string; branch: string };

export function describeTarget(target: Target): string {
  return "pr" in target ? `${target.repo}#${target.pr}` : `${target.repo} ${target.branch}`;
}

async function ghJson(gh: GhRunner, args: string[]): Promise<unknown> {
  return JSON.parse(await gh(args));
}

/** Every page of a list endpoint, merged under `key`. A verdict drawn from the first page alone could miss a pending entry. */
async function ghAllPages(gh: GhRunner, path: string, key: string): Promise<Json> {
  const pages = list(await ghJson(gh, ["api", "--paginate", "--slurp", path]));
  return { [key]: pages.flatMap((page) => list(page[key])) };
}

async function readPullRequest(gh: GhRunner, target: { repo: string; pr: number }): Promise<{ head: string; state: PullRequestState }> {
  const pr = obj(await ghJson(gh, ["pr", "view", String(target.pr), "--repo", target.repo, "--json", "state,mergeable,headRefOid"]));
  const head = str(pr.headRefOid) ?? "";
  if (!head) throw new Error(`${describeTarget(target)} の head を読めませんでした`);
  return { head, state: { state: str(pr.state) ?? "", mergeable: str(pr.mergeable) ?? "UNKNOWN" } };
}

async function readAuthor(gh: GhRunner, repo: string, head: string, knownHead: string | null): Promise<string | null> {
  if (knownHead === null || knownHead === head) return null;
  try {
    const commit = obj(await ghJson(gh, ["api", `repos/${repo}/commits/${head}`]));
    return str(obj(commit.author).login) ?? str(obj(obj(commit.commit).author).name);
  } catch {
    // The author only labels the change in the summary.
    return null;
  }
}

/**
 * Reads the head, the pull request and everything reporting on the head commit.
 *
 * A pull request that is closed or conflicting is returned before anything
 * else is read: the wait ends on it, and a failing read further on must not
 * turn that answer into an error. The pull request is read again at the end;
 * if the head moved meanwhile, what was read belongs to the old head and is
 * dropped, so the next read starts on the new one.
 *
 * On a branch the runs are the branch's newest hundred, not the head commit's:
 * a head that skipped CI would otherwise hide runs still going on the commits
 * before it. Paging through a branch's whole history is not worth it.
 */
export async function readSnapshot(gh: GhRunner, target: Target, knownHead: string | null): Promise<Snapshot> {
  const nothingRead = { runs: [], appChecks: [], statuses: [] };
  let head: string;
  let pullRequest: PullRequestState | null = null;
  let runs: WorkflowRun[];

  if ("pr" in target) {
    const pr = await readPullRequest(gh, target);
    head = pr.head;
    pullRequest = pr.state;
    if (pullRequest.state !== "OPEN" || pullRequest.mergeable === "CONFLICTING") {
      return { head, headAuthor: await readAuthor(gh, target.repo, head, knownHead), pullRequest, ...nothingRead };
    }
    runs = parseRuns(await ghAllPages(gh, `repos/${target.repo}/actions/runs?head_sha=${head}&per_page=100`, "workflow_runs"));
  } else {
    const branch = encodeURIComponent(target.branch);
    head = str(obj(obj(await ghJson(gh, ["api", `repos/${target.repo}/branches/${branch}`])).commit).sha) ?? "";
    if (!head) throw new Error(`${describeTarget(target)} の head を読めませんでした`);
    runs = parseRuns(await ghJson(gh, ["api", `repos/${target.repo}/actions/runs?branch=${branch}&per_page=100`]));
  }

  const [checks, statuses] = await Promise.all([
    ghAllPages(gh, `repos/${target.repo}/commits/${head}/check-runs?per_page=100`, "check_runs"),
    ghAllPages(gh, `repos/${target.repo}/commits/${head}/status?per_page=100`, "statuses"),
  ]);

  if ("pr" in target) {
    const again = await readPullRequest(gh, target);
    if (again.head !== head) {
      return { head: again.head, headAuthor: await readAuthor(gh, target.repo, again.head, knownHead), pullRequest: again.state, ...nothingRead };
    }
  }

  return {
    head,
    headAuthor: await readAuthor(gh, target.repo, head, knownHead),
    pullRequest,
    runs,
    appChecks: parseAppChecks(checks),
    statuses: parseStatuses(statuses),
  };
}

// ─── The wait ───────────────────────────────────────────────────────

export interface WaitDeps {
  gh: GhRunner;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface WaitConfig extends WaitOptions {
  intervalMs: number;
  /** Reads that may fail in a row before the wait gives up. A single failure is usually the network. */
  maxReadFailures: number;
}

export interface WaitResult {
  outcome: Outcome;
  summary: string;
}

/** Reads until the CI settles or a limit is hit, then describes it once. Nothing is printed on the way. */
export async function waitForCi(target: Target, config: WaitConfig, deps: WaitDeps): Promise<WaitResult> {
  let state = initialState(deps.now());
  let failures = 0;
  for (;;) {
    let snapshot: Snapshot | null = null;
    try {
      snapshot = await readSnapshot(deps.gh, target, state.head);
      failures = 0;
    } catch (error) {
      failures++;
      if (failures >= config.maxReadFailures) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${describeTarget(target)} の CI を ${failures} 回続けて読めませんでした: ${reason}`);
      }
    }

    if (snapshot) {
      const next = step(state, snapshot, deps.now(), config);
      state = next.state;
      if (next.done) {
        const settled = next.outcome === "failure" || next.outcome === "cancelled" || next.outcome === "timeout";
        const jobs = settled ? await readJobDetails(deps.gh, target.repo, next.snapshot) : NO_JOB_DETAILS;
        const summary = renderSummary({
          target: describeTarget(target),
          outcome: next.outcome,
          state,
          snapshot: next.snapshot,
          now: deps.now(),
          reviewBots: config.reviewBots,
          noRunsMinutes: Math.round(config.noRunsMs / 60_000),
          jobs,
        });
        return { outcome: next.outcome, summary };
      }
    }

    const remaining = state.startedAt + config.timeoutMs - deps.now();
    await deps.sleep(Math.max(0, Math.min(config.intervalMs, remaining)));
  }
}

export const MAX_JOBS_IN_FULL = 3;
export const LOG_TAIL_LINES = 40;
export const MAX_ANNOTATIONS = 10;

/** Names the failed and cancelled jobs of the runs that did not pass, and gives the first few failed ones in full. */
export async function readJobDetails(gh: GhRunner, repo: string, snapshot: Snapshot): Promise<JobDetails> {
  const out: JobDetails = { failedJobs: [], omittedJobs: [], cancelledJobs: [], readRuns: [] };

  const runs = currentRuns(snapshot.runs).filter((r) => r.status === "completed" && !PASSING.has(r.conclusion ?? ""));
  for (const run of runs) {
    let jobs: Json[];
    try {
      jobs = list(obj(await ghJson(gh, ["api", `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`])).jobs);
    } catch {
      continue;
    }
    const named = jobs.filter((job) => !PASSING.has(str(job.conclusion) ?? ""));
    // A run that failed before creating any job is reported at run level.
    if (named.length === 0) continue;
    out.readRuns.push(run.id);
    for (const job of named) {
      const conclusion = str(job.conclusion) ?? "結論なし";
      const name = `${run.name} / ${str(job.name) ?? "名前なし"}`;
      if (CANCELLED.has(conclusion)) {
        out.cancelledJobs.push(name);
        continue;
      }
      if (out.failedJobs.length >= MAX_JOBS_IN_FULL) {
        out.omittedJobs.push(`${name}: ${conclusion}`);
        continue;
      }
      const id = num(job.id);
      let annotations: string[] = [];
      let logTail: string[] = [];
      try {
        const raw = list(await ghJson(gh, ["api", `repos/${repo}/check-runs/${id}/annotations?per_page=50`]));
        annotations = formatAnnotations(
          raw.map((a) => ({
            path: str(a.path) ?? "",
            line: typeof a.start_line === "number" ? a.start_line : null,
            level: str(a.annotation_level) ?? "",
            message: str(a.message) ?? "",
          })),
          MAX_ANNOTATIONS,
        );
      } catch {
        // The job is still named; the annotations are a convenience.
      }
      try {
        logTail = tailFailedLog(await gh(["run", "view", "--repo", repo, "--job", String(id), "--log-failed"]), LOG_TAIL_LINES);
      } catch {
        // A job that never started, or whose log expired, has nothing to read.
      }
      out.failedJobs.push({ name, conclusion, annotations, logTail });
    }
  }
  return out;
}

/**
 * Reclaim verification containers that outlived the work they were started for.
 *
 * The obvious design — "whoever starts a container tears it down when the PR
 * merges" — leaks, and the leak is structural rather than careless. Four ways
 * it fails, all four observed on this machine at once (11 compose projects,
 * 30 containers, up for 7–12 days):
 *
 * 1. The session that started the container is almost never the session that
 *    sees the merge. Sessions are recycled at a context ceiling measured in
 *    hours; a PR sits in review for days. Ownership lives in the session's
 *    context, so it dies with the session, and the successor — correctly
 *    forbidden from stopping containers it cannot prove are its own — can only
 *    stand there and ask a human.
 * 2. Plenty of branches never merge. Two of the eleven projects belonged to PRs
 *    closed unmerged; no merge event was ever going to arrive for them.
 * 3. A port collision makes one worktree hold several compose projects
 *    (`-300`, `-400`, and the path-hash one). `make down` inside the worktree
 *    drops only the name the Makefile derives today, so the retry residue
 *    survives even a perfectly executed merge teardown.
 * 4. Teardown by `make down` needs the worktree to still exist. Fold the
 *    worktree first and the command has nowhere to run.
 *
 * So this does not listen for an event and does not rely on remembering who
 * started what. It reads the state of the world on a timer and converges: any
 * run that misses something is corrected by the next one.
 *
 * Attribution comes from Docker itself. Every compose container carries
 * `com.docker.compose.project.working_dir`, which points into the worktree it
 * was started from. Worktree → branch → pull request is then a chain of plain
 * queries, and it answers for containers started by sessions that no longer
 * exist, by a human, or by anyone else.
 *
 * The safety rule the session-level version enforced by memory ("stop only
 * what you started") is replaced by one enforced by evidence: a project is
 * torn down only when its branch's pull request is finished, or when its
 * working directory is gone. A container running in a main checkout is never
 * touched — that is where a person keeps their everyday stack.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────

/** One container, reduced to what the sweep needs. */
export interface ContainerRow {
  name: string;
  project: string;
  workingDir: string;
  /** `running`, `exited`, `created`, ... */
  state: string;
  createdAt: Date | null;
}

/** Containers grouped by their compose project, which is what gets torn down. */
export interface ComposeProject {
  project: string;
  workingDir: string;
  containers: number;
  running: number;
  /** Creation time of the oldest container in the project. */
  startedAt: Date | null;
}

/** Where a working directory sits in git terms. */
export interface GitLocation {
  /** Root of the work tree the directory belongs to. */
  toplevel: string;
  /** The main checkout backing it — the same path when it *is* the checkout. */
  mainCheckout: string;
  isWorktree: boolean;
  /** `null` on a detached HEAD. */
  branch: string | null;
}

/** A pull request for the branch, reduced to what the decision needs. */
export interface PullRequestState {
  number: number;
  /** `OPEN` | `MERGED` | `CLOSED` */
  state: string;
  url: string;
  mergedAt: string | null;
  closedAt: string | null;
}

export type SweepAction =
  /** Tear the project down. */
  | "reap"
  /** The work is still live; leave it alone and say nothing. */
  | "keep"
  /** Cannot be decided from evidence; leave it alone and tell the human. */
  | "report"
  /** Out of scope by construction. Never counted, never mentioned. */
  | "skip";

export interface SweepDecision {
  project: ComposeProject;
  action: SweepAction;
  /** Japanese, shown to a human in the log and the notification. */
  reason: string;
  worktree?: string;
  branch?: string;
  pr?: PullRequestState;
}

/** Everything gathered about one compose project before deciding. */
export interface ProjectContext {
  project: ComposeProject;
  workingDirExists: boolean;
  /** `null` when the directory is gone or is not inside a git work tree. */
  git: GitLocation | null;
  /** `null` when no lookup was possible (no branch, or `gh` failed). */
  prs: PullRequestState[] | null;
  /** Why the pull request lookup produced nothing, when it failed. */
  prLookupError?: string;
}

export interface SweepOptions {
  /**
   * How long after a pull request closes the containers are still spared.
   *
   * A merge can land while a child agent is mid-verification on that branch —
   * rebase-and-merge, then a test run that is still going. Waiting a little
   * costs nothing, because nothing else competes for the decision.
   */
  graceHours: number;
  /**
   * How old an undecidable project has to be before it is worth mentioning.
   *
   * A stack started an hour ago with no pull request yet is the normal middle
   * of a task. The same stack after days is residue someone should look at.
   */
  reportAfterDays: number;
}

export const DEFAULT_SWEEP_OPTIONS: SweepOptions = {
  graceHours: 3,
  reportAfterDays: 3,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─── Decision ───────────────────────────────────────────────────────

/**
 * Decide one compose project's fate. Pure: everything it reads was gathered
 * beforehand, so the rules can be tested without a Docker daemon.
 *
 * The order of the gates is the safety argument. Anything that cannot be
 * proven finished falls through to `keep` or `report`, never to `reap`.
 */
export function decideProject(
  ctx: ProjectContext,
  now: Date,
  opts: SweepOptions = DEFAULT_SWEEP_OPTIONS,
): SweepDecision {
  const { project, git } = ctx;
  const base = { project };

  // A container started outside compose has no project label and no working
  // directory to reason from. Not ours to think about.
  if (!project.project || !project.workingDir) {
    return { ...base, action: "skip", reason: "compose プロジェクトではない" };
  }

  // The working directory is gone. Nobody can bring this project up or down
  // through its compose files any more, and no worktree is waiting on it — it
  // is unreachable residue whatever started it.
  if (!ctx.workingDirExists) {
    return {
      ...base,
      action: "reap",
      reason: "worktree が既に無い（compose ファイルごと消えている）",
    };
  }

  if (!git) {
    return {
      ...base,
      action: "report",
      reason: "git の作業ツリーの外で動いている",
    };
  }

  // The main checkout is where a person keeps the stack they use every day.
  // Its branch merging says nothing about whether they are done with it.
  if (!git.isWorktree) {
    return {
      ...base,
      action: "skip",
      reason: "本体チェックアウトのスタック",
      worktree: git.toplevel,
    };
  }

  if (!git.branch) {
    return {
      ...base,
      action: "report",
      reason: "detached HEAD でブランチが引けない",
      worktree: git.toplevel,
    };
  }

  const common = { ...base, worktree: git.toplevel, branch: git.branch };

  if (ctx.prs === null) {
    return {
      ...common,
      action: "report",
      reason: `PRの状態を引けなかった: ${ctx.prLookupError ?? "原因不明"}`,
    };
  }

  if (ctx.prs.length === 0) {
    // No pull request yet. Either the work is still going or it was abandoned
    // before it ever produced one; the two look identical from here, so the
    // only honest move is to wait and then say so.
    return isOlderThan(project.startedAt, now, opts.reportAfterDays * DAY_MS)
      ? {
          ...common,
          action: "report",
          reason: `PRが無いまま ${opts.reportAfterDays} 日以上起動している`,
        }
      : { ...common, action: "keep", reason: "PRがまだ無い（作業中）" };
  }

  // A branch can carry more than one pull request when it is reused. One still
  // open is enough to mean the work is live.
  const open = ctx.prs.find((pr) => pr.state === "OPEN");
  if (open) {
    return {
      ...common,
      action: "keep",
      reason: `PR #${open.number} がレビュー中`,
      pr: open,
    };
  }

  // Everything left is finished — merged, or closed without merging. Both end
  // the reason to keep the environment; only the wording differs.
  const finished = pickLatestFinished(ctx.prs);
  if (!finished) {
    return { ...common, action: "report", reason: "PRの状態を解釈できない" };
  }

  const closedAt = finished.mergedAt ?? finished.closedAt;
  if (closedAt && now.getTime() - new Date(closedAt).getTime() < opts.graceHours * HOUR_MS) {
    return {
      ...common,
      action: "keep",
      reason: `PR #${finished.number} は完了済みだが猶予 ${opts.graceHours} 時間内`,
      pr: finished,
    };
  }

  const verb = finished.state === "MERGED" ? "マージ済み" : "未マージのままクローズ";
  return {
    ...common,
    action: "reap",
    reason: `PR #${finished.number} が${verb}`,
    pr: finished,
  };
}

function isOlderThan(at: Date | null, now: Date, ms: number): boolean {
  // An unknown start time is not evidence of age. Treat it as young so it does
  // not generate a report every run forever.
  if (!at) return false;
  return now.getTime() - at.getTime() >= ms;
}

/** The most recently closed pull request, which is the one that ended the work. */
function pickLatestFinished(prs: PullRequestState[]): PullRequestState | null {
  const withTime = prs
    .map((pr) => ({ pr, at: pr.mergedAt ?? pr.closedAt }))
    .filter((x): x is { pr: PullRequestState; at: string } => x.at !== null);
  if (withTime.length === 0) return prs[0] ?? null;
  withTime.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return withTime[0].pr;
}

// ─── Grouping ───────────────────────────────────────────────────────

/**
 * Group containers into compose projects.
 *
 * The project, not the worktree, is the unit of teardown. One worktree can own
 * several projects — that is what a `PORT_OFFSET` retry leaves behind — and
 * tearing down "the worktree" silently misses all but one of them.
 */
export function groupByProject(rows: ContainerRow[]): ComposeProject[] {
  const byProject = new Map<string, ComposeProject>();
  for (const row of rows) {
    if (!row.project) continue;
    const existing = byProject.get(row.project);
    if (!existing) {
      byProject.set(row.project, {
        project: row.project,
        workingDir: row.workingDir,
        containers: 1,
        running: row.state === "running" ? 1 : 0,
        startedAt: row.createdAt,
      });
      continue;
    }
    existing.containers += 1;
    if (row.state === "running") existing.running += 1;
    if (row.createdAt && (!existing.startedAt || row.createdAt < existing.startedAt)) {
      existing.startedAt = row.createdAt;
    }
  }
  return [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
}

// ─── Docker ─────────────────────────────────────────────────────────

const DOCKER_FORMAT = [
  "{{.Names}}",
  '{{.Label "com.docker.compose.project"}}',
  '{{.Label "com.docker.compose.project.working_dir"}}',
  "{{.State}}",
  "{{.CreatedAt}}",
].join("\t");

/** Every container on the machine, running or not, with its compose labels. */
export async function listContainers(): Promise<ContainerRow[]> {
  const { stdout } = await execFileAsync(
    "docker",
    ["ps", "--all", "--no-trunc", "--format", DOCKER_FORMAT],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return parseContainerRows(stdout);
}

export function parseContainerRows(stdout: string): ContainerRow[] {
  const rows: ContainerRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name, project, workingDir, state, createdAt] = line.split("\t");
    rows.push({
      name: name ?? "",
      project: project ?? "",
      // Compose keeps the directory holding the compose files, which is often
      // a subdirectory of the worktree (`deployments/local` here). Resolving it
      // to the work tree root is git's job, not string surgery's.
      workingDir: workingDir ?? "",
      state: state ?? "",
      createdAt: parseDockerDate(createdAt ?? ""),
    });
  }
  return rows;
}

/**
 * `docker ps` prints `2026-08-13 21:03:12 +0900 JST`. The offset is what makes
 * it unambiguous; the trailing abbreviation is decoration `Date` chokes on.
 */
export function parseDockerDate(raw: string): Date | null {
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})/);
  if (!m) return null;
  // `+0900` is legal for V8 but not for the spec; the colon makes it portable.
  const normalized = m[1].replace(" ", "T").replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Tear a compose project down by name.
 *
 * Deliberately not `make down` in the worktree: this has to work when the
 * worktree is gone, and it has to address the project the containers actually
 * belong to rather than the one the Makefile would derive today. `docker
 * compose -p <name> down` finds its resources by label, so it needs neither a
 * compose file nor a particular working directory.
 *
 * Volumes go too, matching what the repositories' own `make down` does. The
 * local database is a scratch copy, and leaving it behind turns a memory leak
 * into a disk leak.
 */
export async function tearDownProject(
  project: string,
  opts: { dryRun: boolean },
): Promise<void> {
  const args = ["compose", "-p", project, "down", "--volumes"];
  if (opts.dryRun) args.push("--dry-run");
  await execFileAsync("docker", args, { maxBuffer: 10 * 1024 * 1024 });

  if (opts.dryRun) return;

  // `down --volumes` leaves behind volumes compose considers external — the
  // pip/pipx caches the BE Makefile removes by hand after its own `down`. The
  // label keeps this scoped to the project just torn down.
  const { stdout } = await execFileAsync("docker", [
    "volume", "ls", "--quiet",
    "--filter", `label=com.docker.compose.project=${project}`,
  ]);
  const leftovers = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const volume of leftovers) {
    try {
      await execFileAsync("docker", ["volume", "rm", volume]);
    } catch {
      // A volume still referenced by something outside the project is not this
      // job's business, and failing the whole sweep over it would be worse.
    }
  }
}

// ─── git / gh ───────────────────────────────────────────────────────

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Place a working directory in git terms.
 *
 * `--git-common-dir` is what separates a worktree from the checkout it hangs
 * off: for a worktree it points back at the main checkout's `.git`. Path
 * conventions are not used anywhere — worktrees on this machine live under at
 * least three different roots, decided by scripts that are free to change.
 */
export async function inspectGitLocation(dir: string): Promise<GitLocation | null> {
  const toplevel = await gitOutput(dir, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) return null;

  const commonDir = await gitOutput(dir, [
    "rev-parse", "--path-format=absolute", "--git-common-dir",
  ]);
  const mainCheckout = commonDir ? dirname(commonDir.replace(/\/$/, "")) : toplevel;

  const branchRaw = await gitOutput(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = !branchRaw || branchRaw === "HEAD" ? null : branchRaw;

  return { toplevel, mainCheckout, isWorktree: toplevel !== mainCheckout, branch };
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * All pull requests whose head is this branch, in any state.
 *
 * Run from the worktree so `gh` resolves the repository from its remote; the
 * sweep must work for repositories that were never added to any config, since
 * a container left running does not care whether the orchestrator knows the
 * repository.
 */
export async function findPullRequests(
  cwd: string,
  branch: string,
): Promise<PullRequestState[]> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr", "list",
      "--head", branch,
      "--state", "all",
      "--limit", "20",
      "--json", "number,state,url,mergedAt,closedAt",
    ],
    { cwd, maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as PullRequestState[];
}

// ─── Gathering ──────────────────────────────────────────────────────

/** Injectable IO, so the gathering logic is testable without the machine. */
export interface SweepIO {
  pathExists(path: string): Promise<boolean>;
  inspectGitLocation(dir: string): Promise<GitLocation | null>;
  findPullRequests(cwd: string, branch: string): Promise<PullRequestState[]>;
}

export const REAL_IO: SweepIO = {
  pathExists,
  inspectGitLocation,
  findPullRequests,
};

/**
 * Collect what one project's decision needs, asking only what the previous
 * answer makes relevant. A `gh` round trip costs seconds, so a project already
 * ruled out by its location never pays for one.
 */
export async function gatherContext(
  project: ComposeProject,
  io: SweepIO = REAL_IO,
): Promise<ProjectContext> {
  if (!project.workingDir) {
    return { project, workingDirExists: false, git: null, prs: null };
  }

  const workingDirExists = await io.pathExists(project.workingDir);
  if (!workingDirExists) {
    return { project, workingDirExists, git: null, prs: null };
  }

  const git = await io.inspectGitLocation(project.workingDir);
  if (!git || !git.isWorktree || !git.branch) {
    return { project, workingDirExists, git, prs: null };
  }

  try {
    const prs = await io.findPullRequests(git.toplevel, git.branch);
    return { project, workingDirExists, git, prs };
  } catch (err) {
    return {
      project,
      workingDirExists,
      git,
      prs: null,
      prLookupError: (err as Error).message.split("\n")[0],
    };
  }
}

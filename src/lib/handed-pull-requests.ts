import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { inspectGitLocation, normalizeWorktreePath, type GitLocation } from "./container-sweep.js";
import type { OpenPullRequest } from "./open-pull-requests.js";
import { gitHubRepositoryOf } from "./patrol-gate.js";
import type { RepositoryMapping } from "./repositories.js";
import { readHeader } from "./tasks/header.js";
import type { Task, TaskComment } from "./tasks/types.js";

/**
 * Pull requests on tasks the human holds for review, and whether the AI should
 * rebase one that has fallen into conflict.
 *
 * Handing a task over for review does not stop the base branch from moving.
 * When it moves under a pull request the human holds, the pull request
 * conflicts, and while it conflicts its pull-request CI does not run at all:
 * the human opens it to find no result to review against, and hands it back
 * just to have it rebased. The AI keeps such a pull request mergeable instead,
 * without taking the task back — the assignee and the status stay the human's.
 *
 * Everything here is read from evidence that outlives the session: the task's
 * header names the worktree, git names its branch, GitHub names the pull
 * request, its last force push and its mergeability, and the task's comments
 * say whether the human has already been told about this exact head.
 */

const execFileAsync = promisify(execFile);

/** A pull request on the branch of a worktree a human-held task names. */
export interface HandedPullRequest {
  task: Pick<Task, "id" | "title" | "url">;
  /** The repository's label in the config, or `null` if it is not registered. */
  repositoryLabel: string | null;
  worktree: string;
  branch: string;
  /** The worktree has uncommitted changes to tracked files. */
  dirty: boolean;
  pullRequest: OpenPullRequest;
}

export type RebaseVerdict =
  | { kind: "rebase" }
  | { kind: "child-running"; agent: string }
  | { kind: "dirty" }
  | { kind: "unregistered" }
  | { kind: "handed-back" }
  | { kind: "too-soon"; until: Date };

export interface RebaseCandidate extends HandedPullRequest {
  verdict: RebaseVerdict;
}

/** Injectable IO, so the linking is testable without the machine. */
export interface HandedIO {
  inspectGitLocation(dir: string): Promise<GitLocation | null>;
  remoteRepository(dir: string): Promise<string | null>;
  isDirty(dir: string): Promise<boolean>;
}

export const REAL_HANDED_IO: HandedIO = {
  inspectGitLocation,
  async remoteRepository(dir) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", dir, "remote", "get-url", "origin"]);
      return gitHubRepositoryOf(stdout);
    } catch {
      return null;
    }
  },
  async isDirty(dir) {
    // Untracked files do not stand in a rebase's way; edits to tracked ones do,
    // and they mean someone is working there.
    const { stdout } = await execFileAsync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"]);
    return stdout.trim() !== "";
  },
};

/** Each worktree a task's header names, with the label its key carries for a multi-repository task. */
function worktreesOf(task: Task): { path: string; keyLabel: string | null }[] {
  return Object.entries(readHeader(task.description)).flatMap(([name, value]): { path: string; keyLabel: string | null }[] => {
    if (value === "") return [];
    if (name === "worktree") return [{ path: value, keyLabel: null }];
    if (name.startsWith("worktree-")) return [{ path: value, keyLabel: name.slice("worktree-".length) }];
    return [];
  });
}

function samePath(a: string, b: string): boolean {
  return resolve(normalizeWorktreePath(a)) === resolve(normalizeWorktreePath(b));
}

/**
 * Link each task to the open pull requests its worktrees are on.
 *
 * A worktree that is gone, or sits on a detached head, links to nothing: there
 * is no branch to name a pull request by, and no place to rebase it in.
 */
export async function findHandedPullRequests(
  tasks: readonly Task[],
  openPullRequests: readonly OpenPullRequest[],
  repositories: readonly RepositoryMapping[],
  io: HandedIO = REAL_HANDED_IO,
): Promise<HandedPullRequest[]> {
  const found: HandedPullRequest[] = [];
  for (const task of tasks) {
    for (const { path, keyLabel } of worktreesOf(task)) {
      const git = await io.inspectGitLocation(normalizeWorktreePath(path));
      if (!git?.branch) continue;
      const remote = await io.remoteRepository(git.toplevel);
      if (!remote) continue;

      const pullRequests = openPullRequests.filter(
        (pr) => pr.repository.toLowerCase() === remote && pr.headRefName === git.branch,
      );
      if (pullRequests.length === 0) continue;

      const registered =
        repositories.find((repo) => samePath(repo.path, git.mainCheckout)) ??
        repositories.find((repo) => repo.label === keyLabel);
      const dirty = await io.isDirty(git.toplevel);
      for (const pullRequest of pullRequests) {
        found.push({
          task: { id: task.id, title: task.title, url: task.url },
          repositoryLabel: registered?.label ?? null,
          worktree: git.toplevel,
          branch: git.branch,
          dirty,
          pullRequest,
        });
      }
    }
  }
  return found;
}

/**
 * Whether any comment names this commit, by any abbreviation git would print.
 *
 * A rebase the AI could not finish is handed to the human with the head it left
 * untouched written in a comment. Seeing that head named means the human has
 * already been told, and trying again on the same head would only tell them
 * twice. A new head — the human resolved it, or pushed — clears it.
 */
export function mentionsCommit(comments: readonly TaskComment[], sha: string): boolean {
  if (sha.length < 7) return false;
  const full = sha.toLowerCase();
  return comments.some((comment) =>
    (comment.body.toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) ?? []).some((token) => full.startsWith(token)),
  );
}

export interface ClassifyInput {
  handed: HandedPullRequest;
  /** Running children by the task they work on: task id → agent name. */
  runningChildren: ReadonlyMap<string, string>;
  comments: readonly TaskComment[];
  now: Date;
  minIntervalSeconds: number;
}

/**
 * Decide one conflicting pull request. The first reason not to rebase wins;
 * the order puts the human's work first, then what the human already knows.
 */
export function classifyRebase(input: ClassifyInput): RebaseVerdict {
  const { handed, now } = input;

  // Any child on the task, upkeep or not: an impl child on a human-held task is
  // one the human has taken over, and its worktree is theirs.
  const agent = input.runningChildren.get(handed.task.id);
  if (agent !== undefined) return { kind: "child-running", agent };
  if (handed.dirty) return { kind: "dirty" };
  // Rebase rules are per repository; without an entry the triage would treat
  // everything but lock files as hand-resolved, which is not what a registered
  // repository with generated files expects.
  if (handed.repositoryLabel === null) return { kind: "unregistered" };
  if (mentionsCommit(input.comments, handed.pullRequest.headRefOid)) return { kind: "handed-back" };

  const lastPush = handed.pullRequest.lastForcePushAt;
  if (lastPush !== null) {
    const until = new Date(new Date(lastPush).getTime() + input.minIntervalSeconds * 1000);
    if (!Number.isNaN(until.getTime()) && until.getTime() > now.getTime()) return { kind: "too-soon", until };
  }
  return { kind: "rebase" };
}

function formatInstant(date: Date): string {
  return date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

function verdictLine(verdict: RebaseVerdict): string {
  switch (verdict.kind) {
    case "rebase":
      return "rebase する";
    case "child-running":
      return `見送り: 子が動いている (${verdict.agent})`;
    case "dirty":
      return "見送り: worktree に未コミットの変更がある。人間が使っている可能性がある";
    case "unregistered":
      return "見送り: リポジトリが設定に無い。rebase の仕分けのルールを引けない";
    case "handed-back":
      return "見送り: この先端は人間へ渡し済み。コメントに SHA がある";
    case "too-soon":
      return `待つ: 前回の force push から間が無い。${formatInstant(verdict.until)} 以降`;
  }
}

/**
 * The lines the patrol reads. A pull request to rebase comes with everything
 * its instruction file needs, so nothing has to be looked up again.
 */
export function renderRebaseCandidates(
  candidates: readonly RebaseCandidate[],
  childName: (taskId: string, label: string) => string,
): string[] {
  if (candidates.length === 0) return ["  なし"];
  return candidates.flatMap((c) => {
    const lines = [
      `  ${c.verdict.kind === "rebase" ? "▶" : "・"} ${c.task.id}  ${c.task.title}`,
      `    ${verdictLine(c.verdict)}`,
      `    PR: ${c.pullRequest.url}`,
      `    worktree: ${c.worktree}`,
      `    ブランチ: ${c.branch}`,
    ];
    if (c.verdict.kind === "rebase" && c.repositoryLabel !== null) {
      lines.push(
        `    リポジトリラベル: ${c.repositoryLabel}`,
        `    子の名前: ${childName(c.task.id, c.repositoryLabel)}`,
        `    force push 前の先端: ${c.pullRequest.headRefOid}`,
      );
    }
    return lines;
  });
}

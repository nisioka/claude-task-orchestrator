import { describe, it, expect } from "vitest";
import {
  classifyRebase,
  findHandedPullRequests,
  mentionsCommit,
  renderRebaseCandidates,
  type HandedIO,
  type HandedPullRequest,
} from "../handed-pull-requests.js";
import type { GitLocation } from "../container-sweep.js";
import type { OpenPullRequest } from "../open-pull-requests.js";
import type { RepositoryMapping } from "../repositories.js";
import type { Task } from "../tasks/types.js";
import { upkeepAgentName } from "../orchestrator-config.js";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const HOUR = 3600;
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function task(id: string, header: Record<string, string>): Task {
  const block = Object.entries(header).map(([k, v]) => `${k}: ${v}`);
  return {
    id,
    title: `title of ${id}`,
    status: "In Review",
    group: "work",
    labels: [],
    assignee: { id: "u1", name: "human" },
    url: `https://tasks.example/${id}`,
    updatedAt: "2026-11-12T00:00:00.000Z",
    dueDate: null,
    priority: null,
    description: ["orchestrator:begin", ...block, "orchestrator:end", "", "body"].join("\n"),
  };
}

function pr(overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    repository: "Owner/Repo",
    number: 12,
    url: "https://github.com/Owner/Repo/pull/12",
    headRefName: "feat/abc-1-thing",
    headRefOid: HEAD,
    mergeable: "CONFLICTING",
    lastForcePushAt: null,
    ...overrides,
  };
}

const REPOS: RepositoryMapping[] = [
  { label: "repo", path: "/src/repo", baseBranch: "main" },
  { label: "other", path: "/src/other", baseBranch: "main" },
];

function io(locations: Record<string, GitLocation & { remote?: string; dirty?: boolean }>): HandedIO {
  return {
    inspectGitLocation: async (dir) => locations[dir] ?? null,
    remoteRepository: async (dir) =>
      Object.values(locations).find((l) => l.toplevel === dir)?.remote ?? null,
    isDirty: async (dir) => Object.values(locations).find((l) => l.toplevel === dir)?.dirty ?? false,
  };
}

const WORKTREE: GitLocation & { remote: string } = {
  toplevel: "/wt/repo/abc-1",
  mainCheckout: "/src/repo",
  isWorktree: true,
  branch: "feat/abc-1-thing",
  remote: "owner/repo",
};

describe("findHandedPullRequests", () => {
  it("links a task to the pull request on its worktree's branch", async () => {
    const found = await findHandedPullRequests(
      [task("T1", { worktree: "/wt/repo/abc-1" })],
      [pr(), pr({ number: 13, headRefName: "feat/other" })],
      REPOS,
      io({ "/wt/repo/abc-1": WORKTREE }),
    );
    expect(found).toEqual([
      {
        task: { id: "T1", title: "title of T1", url: "https://tasks.example/T1" },
        repositoryLabel: "repo",
        worktree: "/wt/repo/abc-1",
        branch: "feat/abc-1-thing",
        dirty: false,
        pullRequest: pr(),
      },
    ]);
  });

  it("does not link a branch of the same name in another repository", async () => {
    const found = await findHandedPullRequests(
      [task("T1", { worktree: "/wt/repo/abc-1" })],
      [pr({ repository: "owner/elsewhere" })],
      REPOS,
      io({ "/wt/repo/abc-1": WORKTREE }),
    );
    expect(found).toEqual([]);
  });

  it("reads each worktree of a task that spans repositories", async () => {
    const found = await findHandedPullRequests(
      [task("T1", { "worktree-repo": "/wt/repo/abc-1", "worktree-other": "/wt/other/abc-1" })],
      [pr(), pr({ repository: "owner/other", number: 3 })],
      REPOS,
      io({
        "/wt/repo/abc-1": WORKTREE,
        "/wt/other/abc-1": { ...WORKTREE, toplevel: "/wt/other/abc-1", mainCheckout: "/src/other", remote: "owner/other" },
      }),
    );
    expect(found.map((f) => [f.repositoryLabel, f.pullRequest.number])).toEqual([
      ["repo", 12],
      ["other", 3],
    ]);
  });

  it("links nothing for a worktree that is gone or on a detached head", async () => {
    const found = await findHandedPullRequests(
      [task("T1", { worktree: "/wt/gone" }), task("T2", { worktree: "/wt/detached" })],
      [pr()],
      REPOS,
      io({ "/wt/detached": { ...WORKTREE, toplevel: "/wt/detached", branch: null } }),
    );
    expect(found).toEqual([]);
  });

  it("leaves the label empty for a repository the config does not know", async () => {
    const found = await findHandedPullRequests(
      [task("T1", { worktree: "/wt/repo/abc-1" })],
      [pr()],
      [],
      io({ "/wt/repo/abc-1": WORKTREE }),
    );
    expect(found[0].repositoryLabel).toBeNull();
  });
});

function handed(overrides: Partial<HandedPullRequest> = {}): HandedPullRequest {
  return {
    task: { id: "T1", title: "t", url: "u" },
    repositoryLabel: "repo",
    worktree: "/wt/repo/abc-1",
    branch: "feat/abc-1-thing",
    dirty: false,
    pullRequest: pr(),
    ...overrides,
  };
}

function classify(h: HandedPullRequest, extra: { running?: Map<string, string>; comments?: string[] } = {}) {
  return classifyRebase({
    handed: h,
    runningChildren: extra.running ?? new Map(),
    comments: (extra.comments ?? []).map((body) => ({ author: "ai", body, createdAt: NOW.toISOString() })),
    now: NOW,
    minIntervalSeconds: 12 * HOUR,
  });
}

describe("classifyRebase", () => {
  it("rebases a conflicting pull request nobody is touching", () => {
    expect(classify(handed())).toEqual({ kind: "rebase" });
  });

  it("waits out the interval since the last force push", () => {
    const verdict = classify(handed({ pullRequest: pr({ lastForcePushAt: "2026-11-12T08:00:00.000Z" }) }));
    expect(verdict).toEqual({ kind: "too-soon", until: new Date("2026-11-12T20:00:00.000Z") });
  });

  it("rebases again once the interval has passed", () => {
    expect(classify(handed({ pullRequest: pr({ lastForcePushAt: "2026-11-11T23:00:00.000Z" }) }))).toEqual({
      kind: "rebase",
    });
  });

  it("stays out while any child works on the task", () => {
    const running = new Map([["T1", "ai-impl-T1--repo"]]);
    expect(classify(handed(), { running })).toEqual({ kind: "child-running", agent: "ai-impl-T1--repo" });
  });

  it("stays out of a worktree with uncommitted changes", () => {
    expect(classify(handed({ dirty: true }))).toEqual({ kind: "dirty" });
  });

  it("does not rebase in a repository the config does not know", () => {
    expect(classify(handed({ repositoryLabel: null }))).toEqual({ kind: "unregistered" });
  });

  it("does not try again on a head already handed to the human", () => {
    const comments = [`rebase を人間へ渡す。force push 前のリモート先端: ${HEAD.slice(0, 10)}`];
    expect(classify(handed(), { comments })).toEqual({ kind: "handed-back" });
  });

  it("tries again once the head has moved", () => {
    const comments = ["rebase を人間へ渡す。force push 前のリモート先端: fedcba9876"];
    expect(classify(handed(), { comments })).toEqual({ kind: "rebase" });
  });
});

describe("mentionsCommit", () => {
  it("matches any abbreviation of seven or more characters", () => {
    const comments = [{ author: "ai", body: `先端 ${HEAD.slice(0, 7).toUpperCase()} のまま`, createdAt: "" }];
    expect(mentionsCommit(comments, HEAD)).toBe(true);
  });

  it("ignores shorter hex and other text", () => {
    const comments = [{ author: "ai", body: "0123 cafe PR #12 https://example.com/0123456z", createdAt: "" }];
    expect(mentionsCommit(comments, HEAD)).toBe(false);
  });
});

describe("renderRebaseCandidates", () => {
  it("gives a pull request to rebase everything its instruction file needs", () => {
    const lines = renderRebaseCandidates([{ ...handed(), verdict: { kind: "rebase" } }], upkeepAgentName);
    expect(lines).toContain("    子の名前: ai-upkeep-T1--repo");
    expect(lines).toContain(`    force push 前の先端: ${HEAD}`);
    expect(lines).toContain("    PR: https://github.com/Owner/Repo/pull/12");
    expect(lines).toContain("    worktree: /wt/repo/abc-1");
  });

  it("does not offer a child name for one that is not to be rebased", () => {
    const lines = renderRebaseCandidates([{ ...handed(), verdict: { kind: "dirty" } }], upkeepAgentName);
    expect(lines.some((line) => line.includes("子の名前"))).toBe(false);
  });

  it("says so when there is nothing", () => {
    expect(renderRebaseCandidates([], upkeepAgentName)).toEqual(["  なし"]);
  });
});

import { describe, it, expect } from "vitest";
import {
  DEFAULT_SWEEP_OPTIONS,
  decideProject,
  gatherContext,
  groupByProject,
  parseContainerRows,
  parseDockerDate,
  type ComposeProject,
  type ContainerRow,
  type GitLocation,
  type ProjectContext,
  type PullRequestState,
  type SweepIO,
} from "../container-sweep.js";

const NOW = new Date("2026-08-25T12:00:00Z");

const WORKTREE = "/home/u/worktrees/repo/feat-x";
const MAIN = "/home/u/git/repo";

function project(over: Partial<ComposeProject> = {}): ComposeProject {
  return {
    project: "repo-abcd1234",
    workingDir: `${WORKTREE}/deployments/local`,
    containers: 4,
    running: 4,
    startedAt: new Date("2026-08-13T00:00:00Z"),
    ...over,
  };
}

function git(over: Partial<GitLocation> = {}): GitLocation {
  return {
    toplevel: WORKTREE,
    mainCheckout: MAIN,
    isWorktree: true,
    branch: "feat/x",
    ...over,
  };
}

function ctx(over: Partial<ProjectContext> = {}): ProjectContext {
  return {
    project: project(),
    workingDirExists: true,
    git: git(),
    prs: [],
    ...over,
  };
}

function pr(over: Partial<PullRequestState> = {}): PullRequestState {
  return {
    number: 100,
    state: "MERGED",
    url: "https://github.com/o/r/pull/100",
    mergedAt: "2026-08-19T00:00:00Z",
    closedAt: "2026-08-19T00:00:00Z",
    ...over,
  };
}

// ─── The four leaks a merge-event trigger cannot close ───────────────

describe("decideProject — what the merge event misses", () => {
  it("reaps a merged branch no matter which session started it", () => {
    // Attribution comes from the compose label, so a container started by a
    // session that no longer exists is decidable all the same.
    const d = decideProject(ctx({ prs: [pr()] }), NOW);
    expect(d.action).toBe("reap");
  });

  it("reaps a pull request closed without merging", () => {
    // No merge event will ever arrive for this branch.
    const d = decideProject(
      ctx({ prs: [pr({ state: "CLOSED", mergedAt: null, closedAt: "2026-08-19T00:00:00Z" })] }),
      NOW,
    );
    expect(d.action).toBe("reap");
    expect(d.reason).toContain("未マージ");
  });

  it("decides per compose project, so PORT_OFFSET retry residue is included", () => {
    // Three projects, one worktree: teardown keyed on the worktree would drop
    // only the name the Makefile derives today.
    const rows: ContainerRow[] = [
      row({ name: "repo-300-db-1", project: "repo-300" }),
      row({ name: "repo-400-db-1", project: "repo-400" }),
      row({ name: "repo-abcd-db-1", project: "repo-abcd" }),
    ];
    const projects = groupByProject(rows);
    expect(projects.map((p) => p.project)).toEqual(["repo-300", "repo-400", "repo-abcd"]);
    for (const p of projects) {
      expect(decideProject(ctx({ project: p, prs: [pr()] }), NOW).action).toBe("reap");
    }
  });

  it("reaps when the worktree is already gone", () => {
    // `make down` would have nowhere to run; teardown by project name does not
    // need the directory.
    const d = decideProject(ctx({ workingDirExists: false, git: null, prs: null }), NOW);
    expect(d.action).toBe("reap");
  });
});

// ─── Safety gates ────────────────────────────────────────────────────

describe("decideProject — what it must never touch", () => {
  it("skips a stack running in a main checkout", () => {
    const d = decideProject(
      ctx({ git: git({ toplevel: MAIN, isWorktree: false, branch: "develop" }), prs: [pr()] }),
      NOW,
    );
    expect(d.action).toBe("skip");
  });

  it("skips containers started outside compose", () => {
    const d = decideProject(ctx({ project: project({ project: "", workingDir: "" }) }), NOW);
    expect(d.action).toBe("skip");
  });

  it("keeps a branch whose pull request is still open", () => {
    const d = decideProject(
      ctx({ prs: [pr({ state: "OPEN", mergedAt: null, closedAt: null })] }),
      NOW,
    );
    expect(d.action).toBe("keep");
  });

  it("keeps an open pull request even when an older one on the branch merged", () => {
    const d = decideProject(
      ctx({ prs: [pr({ number: 1 }), pr({ number: 2, state: "OPEN", mergedAt: null, closedAt: null })] }),
      NOW,
    );
    expect(d.action).toBe("keep");
    expect(d.pr?.number).toBe(2);
  });

  it("keeps a just-merged branch until the grace period passes", () => {
    const d = decideProject(
      ctx({ prs: [pr({ mergedAt: "2026-08-25T11:00:00Z", closedAt: "2026-08-25T11:00:00Z" })] }),
      NOW,
      { ...DEFAULT_SWEEP_OPTIONS, graceHours: 3 },
    );
    expect(d.action).toBe("keep");
  });

  it("reaps once the grace period has passed", () => {
    const d = decideProject(
      ctx({ prs: [pr({ mergedAt: "2026-08-25T08:00:00Z", closedAt: "2026-08-25T08:00:00Z" })] }),
      NOW,
      { ...DEFAULT_SWEEP_OPTIONS, graceHours: 3 },
    );
    expect(d.action).toBe("reap");
  });

  it("keeps a young project that has no pull request yet", () => {
    const d = decideProject(
      ctx({ project: project({ startedAt: new Date("2026-08-25T09:00:00Z") }), prs: [] }),
      NOW,
    );
    expect(d.action).toBe("keep");
  });

  it("reports, never reaps, an old project with no pull request", () => {
    const d = decideProject(ctx({ prs: [] }), NOW);
    expect(d.action).toBe("report");
  });

  it("reports when the pull request lookup fails", () => {
    const d = decideProject(ctx({ prs: null, prLookupError: "gh: rate limited" }), NOW);
    expect(d.action).toBe("report");
    expect(d.reason).toContain("rate limited");
  });

  it("reports a detached HEAD instead of guessing", () => {
    const d = decideProject(ctx({ git: git({ branch: null }), prs: null }), NOW);
    expect(d.action).toBe("report");
  });

  it("does not treat an unknown start time as old", () => {
    const d = decideProject(ctx({ project: project({ startedAt: null }), prs: [] }), NOW);
    expect(d.action).toBe("keep");
  });
});

// ─── Grouping and parsing ────────────────────────────────────────────

function row(over: Partial<ContainerRow> = {}): ContainerRow {
  return {
    name: "c1",
    project: "repo-abcd",
    workingDir: `${WORKTREE}/deployments/local`,
    state: "running",
    createdAt: new Date("2026-08-13T00:00:00Z"),
    ...over,
  };
}

describe("groupByProject", () => {
  it("counts containers and running containers per project", () => {
    const [p] = groupByProject([
      row({ name: "a", state: "running" }),
      row({ name: "b", state: "exited" }),
    ]);
    expect(p.containers).toBe(2);
    expect(p.running).toBe(1);
  });

  it("takes the oldest container as the project's start time", () => {
    const [p] = groupByProject([
      row({ name: "a", createdAt: new Date("2026-08-20T00:00:00Z") }),
      row({ name: "b", createdAt: new Date("2026-08-13T00:00:00Z") }),
    ]);
    expect(p.startedAt?.toISOString()).toBe("2026-08-13T00:00:00.000Z");
  });

  it("drops containers with no compose project", () => {
    expect(groupByProject([row({ project: "" })])).toEqual([]);
  });
});

describe("parseContainerRows", () => {
  it("reads the compose labels docker prints", () => {
    const rows = parseContainerRows(
      "app-1\tproj\t/w/deployments/local\trunning\t2026-08-13 21:03:12 +0900 JST\n",
    );
    expect(rows[0]).toMatchObject({
      name: "app-1",
      project: "proj",
      workingDir: "/w/deployments/local",
      state: "running",
    });
    expect(rows[0].createdAt?.toISOString()).toBe("2026-08-13T12:03:12.000Z");
  });

  it("keeps an unlabeled container rather than dropping the line", () => {
    // It has to reach `decideProject` to be classified as out of scope.
    const rows = parseContainerRows("stray\t\t\trunning\t2026-08-13 21:03:12 +0900 JST\n");
    expect(rows).toHaveLength(1);
    expect(rows[0].project).toBe("");
  });
});

describe("parseDockerDate", () => {
  it("keeps the offset and drops the timezone abbreviation", () => {
    expect(parseDockerDate("2026-08-13 21:03:12 +0900 JST")?.toISOString()).toBe(
      "2026-08-13T12:03:12.000Z",
    );
  });

  it("returns null on anything it does not recognise", () => {
    expect(parseDockerDate("")).toBeNull();
    expect(parseDockerDate("13 Aug 2026")).toBeNull();
  });
});

// ─── Gathering ───────────────────────────────────────────────────────

describe("gatherContext", () => {
  function io(over: Partial<SweepIO> = {}): SweepIO {
    return {
      pathExists: async () => true,
      inspectGitLocation: async () => git(),
      findPullRequests: async () => [pr()],
      ...over,
    };
  }

  it("skips the pull request lookup for a main checkout", async () => {
    let asked = false;
    const c = await gatherContext(
      project(),
      io({
        inspectGitLocation: async () => git({ toplevel: MAIN, isWorktree: false }),
        findPullRequests: async () => {
          asked = true;
          return [];
        },
      }),
    );
    expect(asked).toBe(false);
    expect(c.prs).toBeNull();
  });

  it("skips every lookup when the working directory is gone", async () => {
    let asked = false;
    const c = await gatherContext(
      project(),
      io({
        pathExists: async () => false,
        inspectGitLocation: async () => {
          asked = true;
          return git();
        },
      }),
    );
    expect(asked).toBe(false);
    expect(c.workingDirExists).toBe(false);
  });

  it("records a failed pull request lookup instead of throwing", async () => {
    const c = await gatherContext(
      project(),
      io({
        findPullRequests: async () => {
          throw new Error("gh: could not resolve to a Repository\nsecond line");
        },
      }),
    );
    expect(c.prs).toBeNull();
    expect(c.prLookupError).toBe("gh: could not resolve to a Repository");
  });

  it("asks gh from the worktree root, not the compose directory", async () => {
    let cwd = "";
    await gatherContext(
      project(),
      io({
        findPullRequests: async (dir) => {
          cwd = dir;
          return [];
        },
      }),
    );
    expect(cwd).toBe(WORKTREE);
  });
});

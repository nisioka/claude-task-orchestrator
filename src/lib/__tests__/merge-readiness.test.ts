import { describe, it, expect } from "vitest";
import {
  assessChecks,
  collectMergeablePrs,
  judgeMergeable,
  parseDetail,
  parseMergeAfter,
  prerequisitesToLookUp,
  type CheckSuite,
  type GraphqlRunner,
  type HeadChecks,
  type OpenPullRequest,
  type PrerequisiteState,
} from "../merge-readiness.js";

describe("parseMergeAfter", () => {
  it("reads owner/repo#N, #N and pull request URLs, separated by spaces or commas", () => {
    const body = [
      "Summary",
      "",
      "merge-after: acme/api#10, #12 https://github.com/acme/docs/pull/3",
      "- Merge-After: acme/api#10",
    ].join("\n");
    expect(parseMergeAfter(body, "acme/web")).toEqual({
      refs: [
        { repo: "acme/api", number: 10 },
        { repo: "acme/web", number: 12 },
        { repo: "acme/docs", number: 3 },
      ],
      invalid: [],
    });
  });

  it("ignores lines inside fenced code blocks", () => {
    const body = ["Write it like this:", "```", "merge-after: owner/repo#123", "```", "~~~", "merge-after: #1", "~~~"].join("\n");
    expect(parseMergeAfter(body, "acme/web")).toEqual({ refs: [], invalid: [] });
  });

  it("does not read the key in the middle of a sentence", () => {
    expect(parseMergeAfter("Please merge this; merge-after: acme/api#10 is not a line", "acme/web").refs).toEqual([]);
  });

  it("reports tokens that name no pull request, and an empty line", () => {
    expect(parseMergeAfter("merge-after: acme/api#10 (backend first)\nmerge-after:", "acme/web")).toEqual({
      refs: [{ repo: "acme/api", number: 10 }],
      invalid: ["(backend", "first)", "merge-after:"],
    });
  });
});

function actions(
  workflow: string,
  runNumber: number,
  conclusion: string | null,
  runs: [string, string | null][] = [[workflow, conclusion]],
  event = "pull_request",
): CheckSuite {
  return {
    app: "github-actions",
    status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
    conclusion,
    workflowRun: { workflowId: workflow, workflowName: workflow, event, runNumber },
    checkRuns: runs.map(([name, c]) => ({ name, status: c === null ? "IN_PROGRESS" : "COMPLETED", conclusion: c })),
    checkRunsTruncated: false,
  };
}

function silentApp(app: string): CheckSuite {
  return { app, status: "QUEUED", conclusion: null, workflowRun: null, checkRuns: [], checkRunsTruncated: false };
}

function head(suites: CheckSuite[], statuses: HeadChecks["statuses"] = []): HeadChecks {
  return { suites, suitesTruncated: false, statuses };
}

describe("assessChecks", () => {
  it("judges each workflow by its newest run, so superseded cancelled runs do not count", () => {
    expect(
      assessChecks(
        head([
          actions("evidence", 18, "CANCELLED"),
          actions("evidence", 19, "CANCELLED"),
          actions("evidence", 20, "SUCCESS"),
          actions("ci", 7, "SUCCESS", [["build", "SUCCESS"], ["e2e", "SKIPPED"]]),
        ]),
      ),
    ).toEqual({ state: "passed" });
  });

  it("fails when the newest run itself was cancelled", () => {
    expect(assessChecks(head([actions("ci", 8, "SUCCESS"), actions("ci", 9, "CANCELLED")]))).toEqual({
      state: "failed",
      detail: "ci",
    });
  });

  it("skips apps that never report, and scheduled runs", () => {
    expect(
      assessChecks(
        head([
          silentApp("preview-deployer"),
          silentApp("review-bot"),
          actions("nightly", 5, "FAILURE", [["full test", "FAILURE"]], "schedule"),
          actions("ci", 3, "SUCCESS"),
        ]),
      ),
    ).toEqual({ state: "passed" });
  });

  it("treats an Actions suite with no runs yet as a queued workflow", () => {
    const queued: CheckSuite = { ...actions("ci", 4, null, []), status: "QUEUED" };
    expect(assessChecks(head([queued]))).toEqual({ state: "pending", detail: "ci" });
  });

  it("fails on a failed check run even inside a suite that concluded successfully", () => {
    expect(
      assessChecks(head([actions("format", 2, "SUCCESS", [["format", "SUCCESS"], ["Test Report (chunk-7)", "FAILURE"]])])),
    ).toEqual({ state: "failed", detail: "Test Report (chunk-7)" });
  });

  it("keeps a workflow's runs for different events apart", () => {
    expect(
      assessChecks(head([actions("ci", 1, "FAILURE", [["build", "FAILURE"]], "push"), actions("ci", 2, "SUCCESS")])),
    ).toEqual({ state: "failed", detail: "ci, build" });
  });

  it("reads commit statuses", () => {
    expect(assessChecks(head([], [{ context: "review", state: "PENDING" }]))).toEqual({
      state: "pending",
      detail: "review",
    });
    expect(assessChecks(head([], [{ context: "deploy", state: "ERROR" }]))).toEqual({
      state: "failed",
      detail: "deploy",
    });
  });

  it("does not call checks it could not read in full passed", () => {
    expect(assessChecks({ ...head([]), suitesTruncated: true }).state).toBe("unknown");
    const truncated = { ...actions("ci", 1, "SUCCESS"), checkRunsTruncated: true };
    expect(assessChecks(head([truncated]))).toEqual({ state: "unknown", detail: "読み切れない: ci" });
  });

  it("passes a head with no checks at all", () => {
    expect(assessChecks(head([silentApp("preview-deployer")]))).toEqual({ state: "passed" });
  });
});

function pr(repo: string, number: number, overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return {
    repo,
    number,
    title: `${repo}#${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    body: "",
    checks: { state: "passed" },
    ...overrides,
  };
}

const none = new Map<string, PrerequisiteState>();

describe("judgeMergeable", () => {
  it("lists a pull request with nothing holding it", () => {
    expect(judgeMergeable([pr("acme/api", 10)], none)).toEqual({
      ready: [{ repo: "acme/api", number: 10, title: "acme/api#10", url: "https://github.com/acme/api/pull/10", waiting: [] }],
      held: [],
    });
  });

  it.each<[string, Partial<OpenPullRequest>, string]>([
    ["a draft", { isDraft: true }, "draft"],
    ["a conflict", { mergeable: "CONFLICTING" }, "コンフリクトしている"],
    ["an unknown mergeability", { mergeable: "UNKNOWN" }, "マージできるかを確かめられない"],
    ["a merge GitHub blocks", { mergeStateStatus: "BLOCKED" }, "GitHub のマージ状態が BLOCKED"],
    ["failing checks", { checks: { state: "failed", detail: "build" } }, "チェックが失敗: build"],
    ["running checks", { checks: { state: "pending", detail: "test" } }, "チェックが終わっていない: test"],
    ["unread checks", { checks: null }, "チェックを読んでいない"],
  ])("holds back %s", (_, overrides, reason) => {
    const view = judgeMergeable([pr("acme/api", 10, overrides)], none);
    expect(view.ready).toEqual([]);
    expect(view.held[0].reasons).toContain(reason);
  });

  it("keeps a waiting pull request off the list and names it on the one it waits for", () => {
    const view = judgeMergeable(
      [pr("acme/web", 20, { body: "merge-after: acme/api#10" }), pr("acme/api", 10)],
      none,
    );
    expect(view.ready.map((p) => p.number)).toEqual([10]);
    expect(view.ready[0].waiting).toEqual([
      { repo: "acme/web", number: 20, title: "acme/web#20", url: "https://github.com/acme/web/pull/20", nextUp: true },
    ]);
    expect(view.held).toEqual([
      { repo: "acme/web", number: 20, url: "https://github.com/acme/web/pull/20", reasons: ["先に acme/api#10 のマージが要る"] },
    ]);
  });

  it("does not promise the waiting one comes next when something else also holds it", () => {
    const view = judgeMergeable(
      [
        pr("acme/web", 20, { body: "merge-after: acme/api#10", checks: { state: "failed", detail: "typecheck" } }),
        pr("acme/web", 21, { body: "merge-after: acme/api#10 acme/docs#3" }),
        pr("acme/api", 10),
        pr("acme/docs", 3, { isDraft: true }),
      ],
      none,
    );
    expect(view.ready.map((p) => p.number)).toEqual([10]);
    expect(view.ready[0].waiting.map((w) => [w.number, w.nextUp])).toEqual([
      [20, false],
      [21, false],
    ]);
  });

  it("lists the waiting one once everything it names is merged", () => {
    const waiting = pr("acme/web", 20, { body: "merge-after: acme/api#10" });
    expect(prerequisitesToLookUp([waiting])).toEqual([{ repo: "acme/api", number: 10 }]);
    const view = judgeMergeable([waiting], new Map([["acme/api#10", "MERGED"]]));
    expect(view.ready.map((p) => p.number)).toEqual([20]);
  });

  it.each<[PrerequisiteState | undefined, string]>([
    ["OPEN", "先に acme/api#10 のマージが要る"],
    ["CLOSED", "acme/api#10 はマージされずに閉じた"],
    ["UNKNOWN", "acme/api#10 の状態を確かめられない"],
    [undefined, "acme/api#10 の状態を確かめられない"],
  ])("holds back a pull request whose prerequisite is %s", (state, reason) => {
    const prerequisites = new Map<string, PrerequisiteState>(state ? [["acme/api#10", state]] : []);
    const view = judgeMergeable([pr("acme/web", 20, { body: "merge-after: acme/api#10" })], prerequisites);
    expect(view.held[0].reasons).toEqual([reason]);
  });

  it("holds back a pull request whose merge-after line cannot be read", () => {
    const view = judgeMergeable([pr("acme/web", 20, { body: "merge-after: the backend one" })], none);
    expect(view.ready).toEqual([]);
    expect(view.held[0].reasons[0]).toBe("merge-after を読めない: the");
  });
});

describe("parseDetail", () => {
  it("reads the GraphQL shape", () => {
    const detail = parseDetail({
      repository: {
        pullRequest: {
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "UNSTABLE",
          commits: {
            nodes: [{
              commit: {
                checkSuites: {
                  totalCount: 2,
                  nodes: [
                    { status: "QUEUED", conclusion: null, app: { slug: "review-bot" }, workflowRun: null, checkRuns: { totalCount: 0, nodes: [] } },
                    {
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      app: { slug: "github-actions" },
                      workflowRun: { event: "pull_request", runNumber: 42, workflow: { databaseId: 7, name: "ci" } },
                      checkRuns: { totalCount: 3, nodes: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }] },
                    },
                  ],
                },
                status: { contexts: [{ context: "review", state: "SUCCESS" }] },
              },
            }],
          },
        },
      },
    });
    expect(detail.mergeStateStatus).toBe("UNSTABLE");
    expect(detail.head.suitesTruncated).toBe(false);
    expect(detail.head.suites[1]).toEqual({
      app: "github-actions",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      workflowRun: { workflowId: "7", workflowName: "ci", event: "pull_request", runNumber: 42 },
      checkRuns: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
      checkRunsTruncated: true,
    });
    expect(detail.head.statuses).toEqual([{ context: "review", state: "SUCCESS" }]);
  });

  it("throws when the pull request is missing", () => {
    expect(() => parseDetail({ repository: { pullRequest: null } })).toThrow();
  });
});

describe("collectMergeablePrs", () => {
  interface Fake {
    open: { repo: string; number: number; body?: string; mergeable?: string[] }[];
    states?: Record<string, string>;
    failDetail?: string[];
  }

  function fakeGitHub(fake: Fake): { run: GraphqlRunner; calls: string[] } {
    const calls: string[] = [];
    const reads = new Map<string, number>();
    const run: GraphqlRunner = async (query, vars) => {
      if (query.includes("search(")) {
        calls.push("search");
        return {
          search: {
            nodes: fake.open.map((p) => ({
              number: p.number,
              title: `t${p.number}`,
              url: `https://github.com/${p.repo}/pull/${p.number}`,
              isDraft: false,
              mergeable: "UNKNOWN",
              body: p.body ?? "",
              repository: { nameWithOwner: p.repo },
            })),
          },
        };
      }
      const key = `${vars.owner}/${vars.name}#${vars.number}`;
      if (query.includes("checkSuites")) {
        calls.push(`detail ${key}`);
        if (fake.failDetail?.includes(key)) throw new Error("boom");
        const p = fake.open.find((o) => `${o.repo}#${o.number}` === key)!;
        const n = reads.get(key) ?? 0;
        reads.set(key, n + 1);
        const mergeable = p.mergeable?.[Math.min(n, p.mergeable.length - 1)] ?? "MERGEABLE";
        return {
          repository: {
            pullRequest: {
              isDraft: false,
              mergeable,
              mergeStateStatus: mergeable === "MERGEABLE" ? "CLEAN" : "UNKNOWN",
              commits: { nodes: [{ commit: { checkSuites: { totalCount: 0, nodes: [] }, status: null } }] },
            },
          },
        };
      }
      calls.push(`state ${key}`);
      const state = fake.states?.[key];
      if (state === undefined) throw new Error("Could not resolve to a PullRequest");
      return { repository: { pullRequest: { state } } };
    };
    return { run, calls };
  }

  it("shows the waiting side only after the one it names is merged", async () => {
    const before = fakeGitHub({
      open: [{ repo: "acme/api", number: 10 }, { repo: "acme/web", number: 20, body: "merge-after: acme/api#10" }],
    });
    const first = await collectMergeablePrs({ run: before.run, retryDelayMs: 0 });
    expect(first.ready.map((p) => `${p.repo}#${p.number}`)).toEqual(["acme/api#10"]);
    expect(first.ready[0].waiting.map((w) => [w.number, w.nextUp])).toEqual([[20, true]]);
    // Both are open here, so nothing needs looking up.
    expect(before.calls.filter((c) => c.startsWith("state"))).toEqual([]);

    const after = fakeGitHub({
      open: [{ repo: "acme/web", number: 20, body: "merge-after: acme/api#10" }],
      states: { "acme/api#10": "MERGED" },
    });
    const second = await collectMergeablePrs({ run: after.run, retryDelayMs: 0 });
    expect(second.ready.map((p) => `${p.repo}#${p.number}`)).toEqual(["acme/web#20"]);
    expect(after.calls).toContain("state acme/api#10");
  });

  it("asks again once when GitHub has not computed mergeability yet", async () => {
    const github = fakeGitHub({ open: [{ repo: "acme/api", number: 10, mergeable: ["UNKNOWN", "MERGEABLE"] }] });
    const view = await collectMergeablePrs({ run: github.run, retryDelayMs: 0 });
    expect(view.ready.map((p) => p.number)).toEqual([10]);
    expect(github.calls.filter((c) => c === "detail acme/api#10")).toHaveLength(2);
  });

  it("holds back only the pull request it could not read", async () => {
    const github = fakeGitHub({
      open: [{ repo: "acme/api", number: 10 }, { repo: "acme/web", number: 20 }],
      failDetail: ["acme/web#20"],
    });
    const view = await collectMergeablePrs({ run: github.run, retryDelayMs: 0 });
    expect(view.ready.map((p) => p.number)).toEqual([10]);
    expect(view.held.map((p) => p.number)).toEqual([20]);
    expect(view.held[0].reasons).toContain("チェックを読んでいない");
  });

  it("holds back a pull request whose prerequisite cannot be looked up", async () => {
    const github = fakeGitHub({ open: [{ repo: "acme/web", number: 20, body: "merge-after: acme/api#999" }] });
    const view = await collectMergeablePrs({ run: github.run, retryDelayMs: 0 });
    expect(view.ready).toEqual([]);
    expect(view.held[0].reasons).toEqual(["acme/api#999 の状態を確かめられない"]);
  });

  it("fails as a whole when the search fails", async () => {
    await expect(
      collectMergeablePrs({
        run: async () => {
          throw new Error("gh: not logged in");
        },
      }),
    ).rejects.toThrow("not logged in");
  });
});

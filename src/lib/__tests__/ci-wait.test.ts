import { describe, it, expect } from "vitest";
import {
  DEFAULT_REVIEW_BOTS,
  currentRuns,
  formatAnnotations,
  initialState,
  isSettled,
  parseAppChecks,
  readSnapshot,
  renderSummary,
  step,
  tailFailedLog,
  waitForCi,
  NO_JOB_DETAILS,
  type GhRunner,
  type Snapshot,
  type WaitOptions,
  type WaitState,
  type WorkflowRun,
} from "../ci-wait.js";
import { parseArgs } from "../../cli/ci-wait.js";

const MIN = 60_000;
const OPTIONS: WaitOptions = { timeoutMs: 90 * MIN, noRunsMs: 10 * MIN, reviewBots: DEFAULT_REVIEW_BOTS };

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    name: "CI",
    workflowId: 10,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    runNumber: 1,
    runAttempt: 1,
    ...overrides,
  };
}

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    head: "aaaaaaa1111",
    headAuthor: null,
    pullRequest: { state: "OPEN", mergeable: "MERGEABLE" },
    runs: [run()],
    appChecks: [],
    statuses: [],
    ...overrides,
  };
}

/** Feeds reads one minute apart and returns the last step. */
function feed(reads: Snapshot[], options = OPTIONS, start = 0) {
  let state: WaitState = initialState(start);
  let result = null as ReturnType<typeof step> | null;
  reads.forEach((s, i) => {
    if (result?.done) throw new Error(`finished before read ${i + 1}`);
    result = step(state, s, start + i * MIN, options);
    state = result.state;
  });
  return result!;
}

describe("step: when the wait is over", () => {
  it("ends only after the same settled read twice in a row", () => {
    expect(feed([snap()]).done).toBe(false);
    const second = feed([snap(), snap()]);
    expect(second).toMatchObject({ done: true, outcome: "success" });
  });

  it("keeps waiting while a run is still going", () => {
    const going = snap({ runs: [run({ status: "in_progress", conclusion: null })] });
    expect(feed([going, going, going]).done).toBe(false);
  });

  it("starts the count again when a run appears between two settled reads", () => {
    const one = snap();
    const two = snap({ runs: [run(), run({ id: 2, name: "Lint", workflowId: 11 })] });
    expect(feed([one, two]).done).toBe(false);
    expect(feed([one, two, two])).toMatchObject({ done: true, outcome: "success" });
  });

  it("is not settled before any run exists", () => {
    expect(isSettled(snap({ runs: [] }), DEFAULT_REVIEW_BOTS)).toBe(false);
  });

  it("keeps cancellations apart from failures", () => {
    const cancelled = snap({ runs: [run({ conclusion: "cancelled" })] });
    expect(feed([cancelled, cancelled])).toMatchObject({ done: true, outcome: "cancelled" });
    const both = snap({ runs: [run({ conclusion: "cancelled" }), run({ id: 2, workflowId: 11, conclusion: "failure" })] });
    expect(feed([both, both])).toMatchObject({ done: true, outcome: "failure" });
  });

  it("judges each workflow by its newest run and ignores scheduled ones", () => {
    const runs = [
      run({ id: 1, runNumber: 1, conclusion: "cancelled" }),
      run({ id: 2, runNumber: 2, conclusion: "success" }),
      run({ id: 3, workflowId: 99, event: "schedule", status: "in_progress", conclusion: null }),
    ];
    expect(currentRuns(runs).map((r) => r.id)).toEqual([2]);
    expect(feed([snap({ runs }), snap({ runs })])).toMatchObject({ done: true, outcome: "success" });
  });

  it("waits for checks from other apps and commit statuses, but not for review bots", () => {
    const appPending = snap({ appChecks: [{ app: "ci-app", name: "Build", status: "in_progress", conclusion: null, title: null }] });
    expect(isSettled(appPending, DEFAULT_REVIEW_BOTS)).toBe(false);
    const statusPending = snap({ statuses: [{ context: "deploy/preview", state: "pending", description: null }] });
    expect(isSettled(statusPending, DEFAULT_REVIEW_BOTS)).toBe(false);

    const botPending = snap({
      appChecks: [{ app: "coderabbitai", name: "CodeRabbit", status: "in_progress", conclusion: null, title: "Review in progress" }],
    });
    expect(feed([botPending, botPending])).toMatchObject({ done: true, outcome: "success" });
  });

  it("counts a failed check from another app as a failure", () => {
    const failed = snap({ appChecks: [{ app: "ci-app", name: "Build", status: "completed", conclusion: "failure", title: null }] });
    expect(feed([failed, failed])).toMatchObject({ done: true, outcome: "failure" });
  });
});

describe("step: following the head", () => {
  it("moves to the new head and does not pair a settled read of the old one with the new one", () => {
    const old = snap({ head: "aaaaaaa1111" });
    const moved = snap({ head: "bbbbbbb2222", headAuthor: "some-bot[bot]", runs: [run({ id: 5 })] });
    const result = feed([old, moved]);
    expect(result.done).toBe(false);
    expect(result.state.head).toBe("bbbbbbb2222");
    expect(result.state.headChanges).toEqual([{ from: "aaaaaaa1111", to: "bbbbbbb2222", author: "some-bot[bot]" }]);

    const finished = feed([old, moved, moved]);
    expect(finished).toMatchObject({ done: true, outcome: "success" });
  });

  it("ignores what the old head's runs ended as", () => {
    const old = snap({ head: "aaaaaaa1111", runs: [run({ conclusion: "cancelled" })] });
    const moved = snap({ head: "bbbbbbb2222", runs: [run({ id: 5, conclusion: "success" })] });
    expect(feed([old, moved, moved])).toMatchObject({ done: true, outcome: "success" });
  });

  it("counts the no-run limit from when the new head was first seen", () => {
    const old = snap({ head: "aaaaaaa1111", runs: [run({ status: "in_progress", conclusion: null })] });
    const bare = snap({ head: "bbbbbbb2222", runs: [] });
    const reads = [...Array(8).fill(old), ...Array(10).fill(bare)];
    expect(feed(reads).done).toBe(false);
    expect(feed([...reads, bare])).toMatchObject({ done: true, outcome: "no-runs" });
  });
});

describe("step: returning at once", () => {
  it("returns on the first read when the pull request conflicts", () => {
    const conflict = snap({ pullRequest: { state: "OPEN", mergeable: "CONFLICTING" }, runs: [] });
    expect(feed([conflict])).toMatchObject({ done: true, outcome: "conflict" });
  });

  it("keeps waiting while GitHub has not computed mergeability yet", () => {
    const unknown = snap({ pullRequest: { state: "OPEN", mergeable: "UNKNOWN" }, runs: [run({ status: "queued", conclusion: null })] });
    expect(feed([unknown]).done).toBe(false);
  });

  it("returns when the pull request is no longer open", () => {
    expect(feed([snap({ pullRequest: { state: "MERGED", mergeable: "UNKNOWN" } })])).toMatchObject({ done: true, outcome: "closed" });
  });

  it("returns when no run has started ten minutes in", () => {
    const bare = snap({ runs: [] });
    expect(feed(Array(10).fill(bare)).done).toBe(false);
    expect(feed(Array(11).fill(bare))).toMatchObject({ done: true, outcome: "no-runs" });
  });

  it("applies the no-run limit to a branch as well", () => {
    const bare = snap({ pullRequest: null, runs: [] });
    expect(feed(Array(11).fill(bare))).toMatchObject({ done: true, outcome: "no-runs" });
  });
});

describe("step: time limit", () => {
  it("gives up when the limit is reached, and not before", () => {
    const going = snap({ runs: [run({ status: "in_progress", conclusion: null })] });
    const options = { ...OPTIONS, timeoutMs: 30 * MIN };
    expect(feed(Array(30).fill(going), options).done).toBe(false);
    expect(feed(Array(31).fill(going), options)).toMatchObject({ done: true, outcome: "timeout" });
  });
});

describe("renderSummary", () => {
  it("names the head change, what failed, what was cancelled and the review bot, without the log when there is none", () => {
    const snapshot = snap({
      head: "bbbbbbb2222",
      runs: [run({ conclusion: "failure" }), run({ id: 2, name: "Lint", workflowId: 11, conclusion: "cancelled" })],
      appChecks: [{ app: "coderabbitai", name: "CodeRabbit", status: "completed", conclusion: "neutral", title: "Review rate limited" }],
    });
    const state: WaitState = {
      ...initialState(0),
      head: "bbbbbbb2222",
      headChanges: [{ from: "aaaaaaa1111", to: "bbbbbbb2222", author: "some-bot[bot]" }],
    };
    const text = renderSummary({
      target: "acme/app#12",
      outcome: "failure",
      state,
      snapshot,
      now: 42 * MIN,
      reviewBots: DEFAULT_REVIEW_BOTS,
      noRunsMinutes: 10,
      jobs: {
        failedJobs: [{ name: "CI / test", conclusion: "failure", annotations: ["failure src/a.ts:3 expected 1"], logTail: ["boom"] }],
        omittedJobs: [],
        cancelledJobs: [],
        readRuns: [1],
      },
    });
    expect(text.split("\n").slice(0, 7)).toEqual([
      "結果: failure",
      "対象: acme/app#12 head bbbbbbb",
      "head が変わった: aaaaaaa → bbbbbbb、some-bot[bot] が push",
      "失敗: CI / test: failure",
      "取消: Lint",
      "レビューボット: CodeRabbit neutral Review rate limited",
      "待った時間: 42 分",
    ]);
    expect(text).toContain("--- CI / test: failure\nannotations:\n  failure src/a.ts:3 expected 1\n失敗したステップのログの末尾 1 行:\nboom");
  });

  it("keeps a failed check from another app that shares a name with a failed run", () => {
    const snapshot = snap({
      runs: [run({ id: 1, conclusion: "failure" })],
      appChecks: [{ app: "ci-app", name: "CI", status: "completed", conclusion: "failure", title: null }],
    });
    const text = renderSummary({
      target: "acme/app#12",
      outcome: "failure",
      state: { ...initialState(0), head: snapshot.head },
      snapshot,
      now: 0,
      reviewBots: DEFAULT_REVIEW_BOTS,
      noRunsMinutes: 10,
      jobs: { failedJobs: [{ name: "CI / test", conclusion: "failure", annotations: [], logTail: [] }], omittedJobs: [], cancelledJobs: [], readRuns: [1] },
    });
    expect(text).toContain("失敗: CI / test: failure, CI: failure");
  });

  it("lists what is still running on a timeout", () => {
    const snapshot = snap({ runs: [run({ status: "in_progress", conclusion: null })] });
    const text = renderSummary({
      target: "acme/app#12",
      outcome: "timeout",
      state: { ...initialState(0), head: snapshot.head },
      snapshot,
      now: 90 * MIN,
      reviewBots: DEFAULT_REVIEW_BOTS,
      noRunsMinutes: 10,
      jobs: NO_JOB_DETAILS,
    });
    expect(text).toContain("結果: timeout");
    expect(text).toContain("終わっていない: CI");
  });
});

describe("log helpers", () => {
  it("keeps the text of the failed step's log and drops the job, step and timestamp", () => {
    const raw = [
      "test\tRun tests\t2026-01-01T00:00:00.1234567Z \u001b[31mFAIL\u001b[0m a.test.ts",
      "test\tRun tests\t2026-01-01T00:00:01.0000000Z exit 1",
      "",
    ].join("\n");
    expect(tailFailedLog(raw, 40)).toEqual(["FAIL a.test.ts", "exit 1"]);
    expect(tailFailedLog(raw, 1)).toEqual(["exit 1"]);
  });

  it("drops the exit code annotation every failed step carries", () => {
    expect(
      formatAnnotations(
        [
          { path: ".github", line: 1, level: "failure", message: "Process completed with exit code 1." },
          { path: "src/a.ts", line: 3, level: "failure", message: "expected 1\nreceived 2" },
        ],
        10,
      ),
    ).toEqual(["failure src/a.ts:3 expected 1"]);
  });

  it("leaves GitHub Actions out of the checks from other apps", () => {
    const data = {
      check_runs: [
        { app: { slug: "github-actions" }, name: "test", status: "completed", conclusion: "success", output: {} },
        { app: { slug: "coderabbitai" }, name: "CodeRabbit", status: "completed", conclusion: "success", output: { title: "Finished" } },
      ],
    };
    expect(parseAppChecks(data)).toEqual([
      { app: "coderabbitai", name: "CodeRabbit", status: "completed", conclusion: "success", title: "Finished" },
    ]);
  });
});

describe("readSnapshot", () => {
  const pr = (state: string, mergeable: string, head: string) => JSON.stringify({ state, mergeable, headRefOid: head });

  it("stops reading once the pull request is closed or conflicting", async () => {
    for (const [state, mergeable] of [["CLOSED", "UNKNOWN"], ["OPEN", "CONFLICTING"]]) {
      const calls: string[] = [];
      const gh: GhRunner = async (args) => {
        calls.push(args.join(" "));
        if (args[0] === "pr") return pr(state, mergeable, "aaaaaaa1111");
        throw new Error("GitHub is down");
      };
      const snapshot = await readSnapshot(gh, { repo: "acme/app", pr: 12 }, null);
      expect(snapshot).toMatchObject({ head: "aaaaaaa1111", pullRequest: { state, mergeable }, runs: [] });
      expect(calls).toHaveLength(1);
    }
  });

  it("drops what it read when the head moved during the read", async () => {
    let views = 0;
    const gh: GhRunner = async (args) => {
      const key = args.join(" ");
      if (args[0] === "pr") return pr("OPEN", "MERGEABLE", ++views === 1 ? "aaaaaaa1111" : "bbbbbbb2222");
      if (key.includes("/actions/runs?")) return JSON.stringify([{ workflow_runs: [{ id: 1, name: "CI", status: "completed", conclusion: "success" }] }]);
      if (key.includes("/check-runs?")) return JSON.stringify([{ check_runs: [] }]);
      if (key.includes("/status?")) return JSON.stringify([{ statuses: [] }]);
      if (key.includes("/commits/bbbbbbb2222")) return JSON.stringify({ author: { login: "some-bot[bot]" } });
      throw new Error(`unexpected gh call: ${key}`);
    };
    const snapshot = await readSnapshot(gh, { repo: "acme/app", pr: 12 }, "aaaaaaa1111");
    expect(snapshot).toMatchObject({ head: "bbbbbbb2222", headAuthor: "some-bot[bot]", runs: [], appChecks: [], statuses: [] });
  });

  it("reads every page of the runs, the checks and the statuses", async () => {
    const gh: GhRunner = async (args) => {
      const key = args.join(" ");
      if (args[0] === "pr") return pr("OPEN", "MERGEABLE", "aaaaaaa1111");
      expect(args.slice(0, 3)).toEqual(["api", "--paginate", "--slurp"]);
      if (key.includes("/actions/runs?")) return JSON.stringify([{ workflow_runs: [{ id: 1 }] }, { workflow_runs: [{ id: 2 }] }]);
      if (key.includes("/check-runs?")) return JSON.stringify([{ check_runs: [] }, { check_runs: [{ app: { slug: "ci-app" }, name: "Build" }] }]);
      if (key.includes("/status?")) return JSON.stringify([{ statuses: [] }, { statuses: [{ context: "deploy", state: "pending" }] }]);
      throw new Error(`unexpected gh call: ${key}`);
    };
    const snapshot = await readSnapshot(gh, { repo: "acme/app", pr: 12 }, null);
    expect(snapshot.runs.map((r) => r.id)).toEqual([1, 2]);
    expect(snapshot.appChecks.map((c) => c.name)).toEqual(["Build"]);
    expect(snapshot.statuses.map((s) => s.context)).toEqual(["deploy"]);
  });
});

describe("waitForCi", () => {
  /** A fake gh that answers from a script of reads, one per poll. Each poll reads the pull request twice. */
  function fakeGh(reads: { head: string; runs: unknown[] }[], extra: Record<string, string> = {}) {
    const calls: string[] = [];
    let prViews = 0;
    const current = () => reads[Math.min(Math.floor((prViews - 1) / 2), reads.length - 1)];
    const gh: GhRunner = async (args) => {
      const key = args.join(" ");
      calls.push(key);
      if (args[0] === "pr" && args[1] === "view") {
        prViews++;
        return JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", headRefOid: current().head });
      }
      if (key.includes("/actions/runs?head_sha=")) return JSON.stringify([{ workflow_runs: current().runs }]);
      if (key.includes("/check-runs?")) return JSON.stringify([{ check_runs: [] }]);
      if (key.includes("/status?")) return JSON.stringify([{ statuses: [] }]);
      if (key.includes("/commits/")) return JSON.stringify({ author: { login: "some-bot[bot]" } });
      for (const [needle, answer] of Object.entries(extra)) if (key.includes(needle)) return answer;
      throw new Error(`unexpected gh call: ${key}`);
    };
    return { gh, calls };
  }

  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  const CONFIG = { ...OPTIONS, intervalMs: MIN, maxReadFailures: 3 };
  const apiRun = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: "CI",
    workflow_id: 10,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    run_number: 1,
    run_attempt: 1,
    ...over,
  });

  it("reads until two settled reads agree, then prints once", async () => {
    const { gh } = fakeGh([
      { head: "aaaaaaa1111", runs: [apiRun({ status: "in_progress", conclusion: null })] },
      { head: "aaaaaaa1111", runs: [apiRun()] },
      { head: "aaaaaaa1111", runs: [apiRun()] },
    ]);
    const result = await waitForCi({ repo: "acme/app", pr: 12 }, CONFIG, { gh, ...clock() });
    expect(result.outcome).toBe("success");
    expect(result.summary.split("\n")[0]).toBe("結果: success");
    expect(result.summary).toContain("待った時間: 2 分");
  });

  it("reads the failed job's annotations and log once it is over", async () => {
    const failed = [apiRun({ id: 7, conclusion: "failure" })];
    const { gh, calls } = fakeGh([{ head: "aaaaaaa1111", runs: failed }], {
      "/actions/runs/7/jobs": JSON.stringify({
        jobs: [
          { id: 70, name: "test", conclusion: "failure" },
          { id: 71, name: "lint", conclusion: "success" },
        ],
      }),
      "/check-runs/70/annotations": JSON.stringify([{ path: "src/a.ts", start_line: 3, annotation_level: "failure", message: "expected 1" }]),
      "--job 70 --log-failed": "test\tRun\t2026-01-01T00:00:00Z oops\n",
    });
    const result = await waitForCi({ repo: "acme/app", pr: 12 }, CONFIG, { gh, ...clock() });
    expect(result.outcome).toBe("failure");
    expect(result.summary).toContain("失敗: CI / test: failure");
    expect(result.summary).toContain("  failure src/a.ts:3 expected 1");
    expect(result.summary).toContain("oops");
    expect(calls.filter((c) => c.includes("--log-failed"))).toHaveLength(1);
  });

  it("names who moved the head", async () => {
    const { gh } = fakeGh([
      { head: "aaaaaaa1111", runs: [apiRun({ status: "in_progress", conclusion: null })] },
      { head: "bbbbbbb2222", runs: [apiRun({ id: 2 })] },
      { head: "bbbbbbb2222", runs: [apiRun({ id: 2 })] },
    ]);
    const result = await waitForCi({ repo: "acme/app", pr: 12 }, CONFIG, { gh, ...clock() });
    expect(result.summary).toContain("head が変わった: aaaaaaa → bbbbbbb、some-bot[bot] が push");
  });

  it("stops at the time limit", async () => {
    const { gh } = fakeGh([{ head: "aaaaaaa1111", runs: [apiRun({ status: "in_progress", conclusion: null })] }]);
    const result = await waitForCi({ repo: "acme/app", pr: 12 }, { ...CONFIG, timeoutMs: 5 * MIN }, { gh, ...clock() });
    expect(result.outcome).toBe("timeout");
    expect(result.summary).toContain("待った時間: 5 分");
  });

  it("gives up when GitHub cannot be read several times in a row", async () => {
    const gh: GhRunner = async () => {
      throw new Error("network down");
    };
    await expect(waitForCi({ repo: "acme/app", pr: 12 }, CONFIG, { gh, ...clock() })).rejects.toThrow("3 回続けて読めませんでした");
  });
});

describe("ci-wait arguments", () => {
  it("reads the pull request, the repository and the limit", () => {
    expect(parseArgs(["--pr=#12", "--repo=acme/app", "--timeout-min=45"])).toMatchObject({ pr: 12, repo: "acme/app", timeoutMinutes: 45 });
    expect(parseArgs([])).toMatchObject({ pr: null, branch: null, timeoutMinutes: 90 });
  });

  it("refuses a pull request and a branch together, and unknown arguments", () => {
    expect(() => parseArgs(["--pr=1", "--branch=main"])).toThrow("どちらか1つ");
    expect(() => parseArgs(["--watch"])).toThrow("知らない引数");
    expect(() => parseArgs(["--repo=app", "--pr=1"])).toThrow("owner/name");
  });

  it("does not look up the current branch's pull request in another repository", () => {
    expect(() => parseArgs(["--repo=acme/other"])).toThrow("--pr か --branch");
  });
});

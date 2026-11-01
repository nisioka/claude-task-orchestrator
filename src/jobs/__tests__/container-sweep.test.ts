import { describe, it, expect } from "vitest";
import {
  adviceFor,
  buildSweepPayload,
  describeReport,
  needsAttention,
  pruneReportState,
  recordReports,
  selectReportsToNotify,
} from "../container-sweep.js";
import type { SweepDecision, ComposeProject } from "../../lib/container-sweep.js";

/** A decision to tear one stack down, unless `action` says otherwise. */
function decision(over: Partial<SweepDecision> = {}): SweepDecision {
  const project: ComposeProject = {
    project: "repo-abcd1234",
    workingDir: "/home/u/worktrees/repo/feat-x/deployments/local",
    containers: 3,
    running: 3,
    startedAt: new Date("2026-08-20T00:00:00Z"),
  };
  return {
    project,
    action: "reap",
    reason: "PR #100 は MERGED",
    branch: "feat/x",
    ...over,
  } as SweepDecision;
}

describe("needsAttention", () => {
  it("says no when the run only stopped things", () => {
    // 予定どおりに起きて自分で完結する。毎時これを流すと本当の1件が沈む
    expect(needsAttention([], [])).toBe(false);
  });

  it("says yes when something could not be judged", () => {
    expect(needsAttention([decision({ action: "report" })], [])).toBe(true);
  });

  it("says yes when a teardown failed", () => {
    expect(needsAttention([], [{ decision: decision(), error: "boom" }])).toBe(true);
  });
});

describe("buildSweepPayload", () => {
  const report = [decision({ action: "report", reason: "PRが見つかりません" })];

  it("leads with what has to be looked at, not with what worked", () => {
    const payload = buildSweepPayload([], report, [], false);

    expect(payload.embeds?.[0].title).toContain("要確認");
  });

  it("still says how much of the run succeeded", () => {
    // 失敗の報せだけ届いて、残りが通ったのかが分からないと調べに行く手間が増える
    const payload = buildSweepPayload([decision(), decision()], report, [], false);

    expect(payload.embeds?.[0].description).toContain("2 プロジェクト");
    expect(payload.embeds?.[0].description).toContain("6 コンテナ");
  });

  it("does not list the projects it stopped one by one", () => {
    const payload = buildSweepPayload([decision(), decision()], [], [], false);

    expect(payload.embeds?.[0].fields ?? []).toHaveLength(0);
  });

  it("colours a failed teardown red and a mere report amber", () => {
    const failed = buildSweepPayload([], [], [{ decision: decision(), error: "boom" }], false);
    const reported = buildSweepPayload([], report, [], false);

    expect(failed.embeds?.[0].color).toBe(0xff4444);
    expect(reported.embeds?.[0].color).toBe(0xffa000);
  });
});

describe("describeReport", () => {
  const stale = decision({
    action: "report",
    reason: "PRが無いまま 3 日以上残っている",
    worktree: "/home/u/worktrees/repo/feat-x",
  });

  it("leads with the ticket, because that is how a reader recognises the work", () => {
    const text = describeReport({
      ...stale,
      task: { id: "T-9", title: "名刺の取り込み", status: "Question", assignee: "A Person", url: "https://t/T-9" },
    });

    expect(text.split("\n")[0]).toBe("チケット: [T-9 名刺の取り込み](https://t/T-9) — Question / 担当 A Person");
  });

  it("says when no ticket claims the worktree, rather than leaving the line out", () => {
    expect(describeReport({ ...stale, task: null })).toContain("見つからない");
  });

  it("says that the containers are already stopped when none is running", () => {
    const text = describeReport({ ...stale, project: { ...stale.project, running: 0 } });

    expect(text).toContain("3 件はすべて停止済み");
  });

  it("tells the reader what resolves it, including the exact teardown command", () => {
    const text = describeReport(stale);

    expect(text).toContain("確認すること:");
    expect(text).toContain("docker compose -p repo-abcd1234 down --volumes");
  });

  it("gives gh-specific advice when the PR lookup failed", () => {
    expect(adviceFor(decision({ action: "report", reason: "PRの状態を引けなかった: boom" }))).toContain("gh auth status");
  });
});

describe("buildSweepPayload with tasks", () => {
  it("titles the field with the ticket id when one is known", () => {
    const d = decision({
      action: "report",
      reason: "PRが無いまま 3 日以上残っている",
      task: { id: "T-9", title: "x", status: "Todo", assignee: null, url: "https://t/T-9" },
    });

    expect(buildSweepPayload([], [d], [], false).embeds?.[0].fields?.[0].name).toBe("⚠️ 要確認: T-9");
  });
});

describe("selectReportsToNotify", () => {
  const now = new Date("2026-08-25T12:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  const stale = decision({ action: "report", reason: "PRが無いまま 3 日以上残っている" });

  it("sends what has never been sent", () => {
    expect(selectReportsToNotify([stale], { reported: {} }, now, DAY)).toHaveLength(1);
  });

  it("holds a line that went out less than the interval ago", () => {
    const state = recordReports({ reported: {} }, [stale], new Date(now.getTime() - DAY / 2));

    expect(selectReportsToNotify([stale], state, now, DAY)).toHaveLength(0);
  });

  it("sends again once the interval has passed", () => {
    const state = recordReports({ reported: {} }, [stale], new Date(now.getTime() - DAY));

    expect(selectReportsToNotify([stale], state, now, DAY)).toHaveLength(1);
  });

  it("sends at once when the reason changed, because the situation did", () => {
    const state = recordReports({ reported: {} }, [decision({ action: "report", reason: "PRの状態を引けなかった: x" })], now);

    expect(selectReportsToNotify([stale], state, now, DAY)).toHaveLength(1);
  });

  it("forgets a project once it is no longer undecidable", () => {
    const state = recordReports({ reported: {} }, [stale], now);

    expect(pruneReportState(state, []).reported).toEqual({});
    expect(pruneReportState(state, [stale]).reported).toHaveProperty("repo-abcd1234");
  });
});

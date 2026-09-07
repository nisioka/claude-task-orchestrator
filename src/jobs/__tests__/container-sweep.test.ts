import { describe, it, expect } from "vitest";
import { needsAttention, buildSweepPayload } from "../container-sweep.js";
import type { SweepDecision, ComposeProject } from "../../lib/container-sweep.js";

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

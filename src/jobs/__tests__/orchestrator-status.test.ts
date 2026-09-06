import { describe, it, expect } from "vitest";
import {
  formatAge,
  renderHumanQueue,
  renderAiQueue,
  renderAgent,
  renderUsage,
  renderOrchestrator,
  formatUntil,
  classifySchedules,
  renderScheduled,
} from "../orchestrator-status.js";
import {
  DEFAULT_WORKFLOW,
  humanBallStatuses,
  humanDutyByStatus,
} from "../../lib/tasks/workflow.js";
import type { Task } from "../../lib/tasks/types.js";
import type { AgentSummary, AgentJobState, HeartbeatRecord } from "../../lib/agent-runtime.js";

const NOW = new Date("2026-08-06T12:00:00.000Z");

function issue(overrides: Partial<Task> = {}): Task {
  return {
    id: "TASK-1",
    title: "テストイシュー",
    status: "In Review",
    group: null,
    dueDate: null,
    priority: null,
    updatedAt: "2026-08-06T11:00:00.000Z",
    labels: [],
    url: "https://linear.app/x/issue/TASK-1",
    assignee: { id: "human", name: "だいすけ" },
    ...overrides,
  };
}

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    pid: 1234,
    id: "ab12cd34",
    cwd: "/home/tester/worktrees/repo",
    kind: "background",
    startedAt: NOW.getTime() - 30 * 60 * 1000,
    sessionId: "session-uuid-1",
    name: "ai-impl-TASK-1226",
    status: "busy",
    state: "working",
    ...overrides,
  };
}

function jobState(overrides: Partial<AgentJobState> = {}): AgentJobState {
  return {
    state: "working",
    detail: "テストを書いています",
    inFlightTasks: 1,
    tokens: 41234,
    result: null,
    intent: "TASK-1226 を実装する",
    resumeSessionId: "session-uuid-1",
    transcriptPath: "/home/tester/.claude/projects/x/session.jsonl",
    ...overrides,
  };
}

// ─── Duty classification ────────────────────────────────────────────

describe("humanDutyByStatus", () => {
  const duties = humanDutyByStatus(DEFAULT_WORKFLOW);

  it("maps each status where the human holds the ball to one of the four duties", () => {
    expect(duties["Question"]).toBe("要件確認");
    expect(duties["In Review"]).toBe("レビューとマージ");
    expect(duties["Test"]).toBe("実機テスト");
    expect(duties["Wait"]).toBe("待ちの解除確認");
  });

  it("lists exactly those statuses as the human's ball", () => {
    expect([...humanBallStatuses(DEFAULT_WORKFLOW)].sort()).toEqual(
      ["In Review", "Question", "Test", "Wait"].sort(),
    );
  });

  it("labels duties for display only, never gating what the AI may pick up", () => {
    // The AI's ball is decided by assignee alone, so there is no AI-side
    // status allowlist to keep in sync with this one.
    expect(Object.keys(duties)).toEqual(humanBallStatuses(DEFAULT_WORKFLOW));
  });
});

// ─── formatAge ──────────────────────────────────────────────────────

describe("formatAge", () => {
  it("reports sub-minute ages as such", () => {
    expect(formatAge("2026-08-06T11:59:30.000Z", NOW)).toBe("1分未満");
  });

  it("reports minutes", () => {
    expect(formatAge("2026-08-06T11:23:00.000Z", NOW)).toBe("37分");
  });

  it("reports hours and minutes", () => {
    expect(formatAge("2026-08-06T09:15:00.000Z", NOW)).toBe("2時間45分");
  });

  it("omits zero minutes", () => {
    expect(formatAge("2026-08-06T09:00:00.000Z", NOW)).toBe("3時間");
  });

  it("reports days and hours once past a day", () => {
    expect(formatAge("2026-08-04T10:00:00.000Z", NOW)).toBe("2日2時間");
  });

  it("omits zero hours", () => {
    expect(formatAge("2026-08-04T12:00:00.000Z", NOW)).toBe("2日");
  });

  it("does not report negative ages from clock skew", () => {
    expect(formatAge("2026-08-06T12:30:00.000Z", NOW)).toBe("1分未満");
  });

  it("says so when the timestamp cannot be read", () => {
    expect(formatAge("yesterday", NOW)).toBe("不明");
  });
});

// ─── renderHumanQueue ───────────────────────────────────────────────

describe("renderHumanQueue", () => {
  it("groups issues under the duty their status implies", () => {
    const lines = renderHumanQueue(
      [
        issue({ id: "TASK-1", status: "In Review" }),
        issue({ id: "TASK-2", status: "Question" }),
      ],
      NOW,
      DEFAULT_WORKFLOW,
    ).join("\n");

    expect(lines).toContain("レビューとマージ");
    expect(lines).toContain("要件確認");
    expect(lines).toContain("TASK-1");
    expect(lines).toContain("TASK-2");
  });

  it("shows how long each issue has been waiting", () => {
    const lines = renderHumanQueue([issue({ updatedAt: "2026-08-06T09:00:00.000Z" })], NOW, DEFAULT_WORKFLOW).join("\n");

    expect(lines).toContain("3時間");
  });

  it("puts the longest wait first within a duty", () => {
    const lines = renderHumanQueue(
      [
        issue({ id: "TASK-recent", updatedAt: "2026-08-06T11:50:00.000Z" }),
        issue({ id: "TASK-old", updatedAt: "2026-08-01T11:50:00.000Z" }),
      ],
      NOW,
      DEFAULT_WORKFLOW,
    );

    const body = lines.join("\n");
    expect(body.indexOf("TASK-old")).toBeLessThan(body.indexOf("TASK-recent"));
  });

  it("says the queue is empty rather than printing nothing", () => {
    expect(renderHumanQueue([], NOW, DEFAULT_WORKFLOW).join("\n")).toContain("なし");
  });

  it("groups an unrecognised status under a catch-all rather than dropping it", () => {
    const lines = renderHumanQueue([issue({ status: "Something Else" })], NOW, DEFAULT_WORKFLOW).join("\n");

    expect(lines).toContain("TASK-1");
  });
});

// ─── renderAiQueue ──────────────────────────────────────────────────

describe("renderAiQueue", () => {
  it("groups by status", () => {
    const lines = renderAiQueue(
      [issue({ id: "TASK-3", status: "Todo" }), issue({ id: "TASK-4", status: "In Progress" })],
      NOW,
    ).join("\n");

    expect(lines).toContain("Todo");
    expect(lines).toContain("In Progress");
    expect(lines).toContain("TASK-3");
  });

  it("says the queue is empty rather than printing nothing", () => {
    expect(renderAiQueue([], NOW).join("\n")).toContain("なし");
  });
});

// ─── renderAgent ────────────────────────────────────────────────────

describe("renderAgent", () => {
  it("shows the agent's own description of what it is doing", () => {
    expect(renderAgent(agent(), jobState(), NOW).join("\n")).toContain("テストを書いています");
  });

  it("shows the context it is re-reading each turn, against its limit", () => {
    const rendered = renderAgent(
      agent(),
      jobState(),
      NOW,
      { at: NOW.toISOString(), contextTokens: 348_000 },
      400_000,
    ).join("\n");

    expect(rendered).toContain("348k / 上限 400k");
  });

  it("says when the context is over the limit, so the orchestrator hands over", () => {
    const rendered = renderAgent(
      agent(),
      jobState(),
      NOW,
      { at: NOW.toISOString(), contextTokens: 412_000 },
      400_000,
    ).join("\n");

    expect(rendered).toContain("引き継ぎ");
  });

  it("stays quiet when the context could not be measured", () => {
    const rendered = renderAgent(agent(), jobState(), NOW, null, 400_000).join("\n");

    expect(rendered).toContain("文脈: 不明");
    expect(rendered).not.toContain("引き継ぎ");
  });

  it("points at the agent TUI to join, since --resume is refused while it runs", () => {
    const rendered = renderAgent(agent(), jobState(), NOW).join("\n");

    expect(rendered).toContain("claude agents");
    expect(rendered).toContain("session-uuid-1");
  });

  it("names the issue the agent is working on", () => {
    expect(renderAgent(agent(), jobState(), NOW).join("\n")).toContain("TASK-1226");
  });

  it("shows how long the agent has been running", () => {
    expect(renderAgent(agent(), jobState(), NOW).join("\n")).toContain("30分");
  });

  it("still renders when no state file could be read", () => {
    const lines = renderAgent(agent(), null, NOW).join("\n");

    expect(lines).toContain("ai-impl-TASK-1226");
    expect(lines).toContain("不明");
  });

  it("shows the working directory so the human can look at the work in progress", () => {
    expect(renderAgent(agent(), jobState(), NOW).join("\n")).toContain(
      "/home/tester/worktrees/repo",
    );
  });
});

// ─── renderOrchestrator ─────────────────────────────────────────────

describe("renderOrchestrator", () => {
  const beat = (at: string): HeartbeatRecord => ({
    at,
    dispatched: ["TASK-1"],
    handedToHuman: [],
    note: "1件投入",
  });

  it("reports a running orchestrator with its last heartbeat", () => {
    const lines = renderOrchestrator(
      agent({ name: "ai-orchestrator" }),
      beat("2026-08-06T11:50:00.000Z"),
      NOW,
    ).join("\n");

    expect(lines).toContain("稼働中");
    expect(lines).toContain("10分");
    expect(lines).toContain("1件投入");
  });

  it("reports plainly when no orchestrator is running", () => {
    expect(renderOrchestrator(null, null, NOW).join("\n")).toContain("停止");
  });

  it("flags a running orchestrator whose heartbeat has gone quiet", () => {
    const lines = renderOrchestrator(
      agent({ name: "ai-orchestrator" }),
      beat("2026-08-06T09:00:00.000Z"),
      NOW,
    ).join("\n");

    expect(lines).toContain("巡回が止まっている可能性");
  });

  it("does not flag a session that has never written a heartbeat as running normally", () => {
    expect(
      renderOrchestrator(agent({ name: "ai-orchestrator" }), null, NOW).join("\n"),
    ).toContain("ハートビートなし");
  });
});

// ─── renderUsage ────────────────────────────────────────────────────

describe("renderUsage", () => {
  const usage = {
    five_hour: { utilization: 12, resets_at: "2026-08-06T15:00:00.000Z" },
    seven_day: { utilization: 47, resets_at: "2026-08-10T00:00:00.000Z" },
  };

  it("shows both windows with their reset times", () => {
    const lines = renderUsage(usage).join("\n");

    expect(lines).toContain("12%");
    expect(lines).toContain("47%");
    expect(lines).toContain("5時間枠");
    expect(lines).toContain("7日枠");
  });

  it("says so when usage could not be read, rather than failing the whole view", () => {
    expect(renderUsage(null).join("\n")).toContain("取得できませんでした");
  });
});

// ─── formatUntil ────────────────────────────────────────────────────

describe("formatUntil", () => {
  it("counts down in coarse Japanese units", () => {
    expect(formatUntil(new Date("2026-08-06T14:30:00.000Z"), NOW)).toBe("2時間30分");
    expect(formatUntil(new Date("2026-08-06T12:45:00.000Z"), NOW)).toBe("45分");
    expect(formatUntil(new Date("2026-08-08T12:00:00.000Z"), NOW)).toBe("2日");
  });

  it("says まもなく for a time already reached", () => {
    expect(formatUntil(new Date("2026-08-06T11:00:00.000Z"), NOW)).toBe("まもなく");
    expect(formatUntil(NOW, NOW)).toBe("まもなく");
  });
});

// ─── classifySchedules / renderScheduled ────────────────────────────

function describedIssue(overrides: Partial<Task> = {}): Task {
  return { ...issue(), description: "", ...overrides };
}

describe("classifySchedules", () => {
  it("collects future-scheduled Todo issues, ignoring past ones", () => {
    const future = describedIssue({
      id: "TASK-2",
      status: "Todo",
      description: "<!-- start-after: 2026-08-06T22:00+09:00 -->", // 13:00 UTC, future
    });
    const past = describedIssue({
      id: "TASK-3",
      status: "Todo",
      description: "<!-- start-after: 2026-08-06T20:00+09:00 -->", // 11:00 UTC, already reached
    });

    const view = classifySchedules([future, past], NOW, DEFAULT_WORKFLOW);

    expect(view.pending.map((p) => p.issue.id)).toEqual(["TASK-2"]);
    expect(view.invalid).toEqual([]);
  });

  it("only considers Todo issues", () => {
    const inProgress = describedIssue({
      status: "In Progress",
      description: "<!-- start-after: 2026-08-07T00:00 -->",
    });
    expect(classifySchedules([inProgress], NOW, DEFAULT_WORKFLOW).pending).toEqual([]);
  });

  it("surfaces issues whose marker cannot be parsed", () => {
    const bad = describedIssue({
      id: "TASK-9",
      status: "Todo",
      description: "<!-- start-after: 来週のどこか -->",
    });
    const view = classifySchedules([bad], NOW, DEFAULT_WORKFLOW);
    expect(view.pending).toEqual([]);
    expect(view.invalid).toEqual([{ issue: bad, raw: "来週のどこか" }]);
  });

  it("ignores Todo issues without a marker", () => {
    const plain = describedIssue({ status: "Todo", description: "普通の説明" });
    const view = classifySchedules([plain], NOW, DEFAULT_WORKFLOW);
    expect(view.pending).toEqual([]);
    expect(view.invalid).toEqual([]);
  });
});

describe("renderScheduled", () => {
  it("says なし when there is nothing scheduled or invalid", () => {
    expect(renderScheduled({ pending: [], invalid: [] }, NOW).join("\n")).toContain("なし");
  });

  it("shows the JST start time, the remaining wait, and orders soonest-first", () => {
    const later = { issue: issue({ id: "TASK-5", title: "後" }), at: new Date("2026-08-06T15:00:00.000Z") };
    const sooner = { issue: issue({ id: "TASK-4", title: "先" }), at: new Date("2026-08-06T13:00:00.000Z") };
    const lines = renderScheduled({ pending: [later, sooner], invalid: [] }, NOW);
    const text = lines.join("\n");

    expect(text.indexOf("TASK-4")).toBeLessThan(text.indexOf("TASK-5"));
    expect(text).toContain("開始予定");
    expect(text).toContain("あと1時間"); // 13:00 UTC == 22:00 JST, 1h away
  });

  it("flags an invalid marker with the offending text and a hand-back note", () => {
    const lines = renderScheduled(
      { pending: [], invalid: [{ issue: issue({ id: "TASK-9" }), raw: "来週" }] },
      NOW,
    );
    const text = lines.join("\n");
    expect(text).toContain("TASK-9");
    expect(text).toContain("来週");
    expect(text).toContain("人間へ差し戻");
  });
});

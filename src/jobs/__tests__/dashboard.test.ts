import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import {
  buildStatusView,
  parseCronStarts,
  parseCronTargets,
  parseOpenPrs,
  summarizeLogTail,
  summarizePatrols,
} from "../dashboard.js";
import { formatRunMarker } from "../../lib/run-log.js";
import type { OrchestratorSnapshot } from "../orchestrator-status.js";
import type { Task } from "../../lib/tasks/types.js";
import type { WorkflowStatuses } from "../../lib/tasks/workflow.js";

const workflow = {
  backlog: "Backlog",
  queued: "Todo",
  question: "Question",
  inProgress: "In Progress",
  wait: "Wait",
  inReview: "In Review",
  test: "Test",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
} as WorkflowStatuses;

function task(id: string, status: string, updatedAt: string): Task {
  return {
    id,
    title: `title ${id}`,
    status,
    group: "work",
    labels: [],
    assignee: null,
    url: `https://example.com/${id}`,
    updatedAt,
    dueDate: null,
    priority: null,
  } as Task;
}

function snapshot(overrides: Partial<OrchestratorSnapshot> = {}): OrchestratorSnapshot {
  return {
    takenAt: new Date("2026-10-28T03:00:00Z"),
    group: "work",
    workflow,
    maxIntervalSeconds: 1800,
    sessionContextLimitTokens: 300_000,
    childContextLimitTokens: 400_000,
    orchestrator: null,
    heartbeat: null,
    children: [],
    aiIssues: [],
    mismatches: [],
    schedule: { pending: [], invalid: [] },
    humanIssues: [],
    ...overrides,
  };
}

describe("buildStatusView", () => {
  it("groups the human's ball by duty, longest wait first", () => {
    const view = buildStatusView(
      snapshot({
        humanIssues: [
          task("B", "Question", "2026-10-27T00:00:00Z"),
          task("A", "Question", "2026-10-20T00:00:00Z"),
          task("C", "Wait", "2026-10-25T00:00:00Z"),
        ],
      }),
    );
    expect(view.waitStatus).toBe("Wait");
    expect(view.humanQueue).toEqual([
      { duty: "要件確認", issues: [expect.objectContaining({ id: "A" }), expect.objectContaining({ id: "B" })] },
      { duty: "待ちの解除確認", issues: [expect.objectContaining({ id: "C" })] },
    ]);
  });

  it("does not call a stopped orchestrator's old heartbeat stale", () => {
    const view = buildStatusView(
      snapshot({ heartbeat: { at: "2026-10-01T00:00:00Z", dispatched: [], handedToHuman: [], note: null } }),
    );
    expect(view.orchestrator.agent).toBeNull();
    expect(view.orchestrator.heartbeatStale).toBe(false);
  });

  it("flags a running orchestrator whose heartbeat stopped", () => {
    const view = buildStatusView(
      snapshot({
        orchestrator: {
          agent: {
            pid: null,
            id: "x",
            cwd: "/repo",
            kind: "bg",
            startedAt: Date.parse("2026-10-27T00:00:00Z"),
            sessionId: "s",
            name: "ai-orchestrator",
            status: null,
            state: "working",
          },
          state: null,
          context: { at: "2026-10-28T02:59:00Z", contextTokens: 310_000 },
        },
        heartbeat: { at: "2026-10-27T20:00:00Z", dispatched: [], handedToHuman: [], note: "n" },
      }),
    );
    expect(view.orchestrator.heartbeatStale).toBe(true);
    expect(view.orchestrator.agent?.contextOver).toBe(true);
  });
});

describe("summarizePatrols", () => {
  const now = new Date("2026-10-28T03:00:00Z"); // 12:00 JST
  const lines = [
    { at: "2026-10-26T14:59:00Z", dispatched: ["X"], handedToHuman: [], note: "前日の23:59 JST" },
    { at: "2026-10-27T15:00:00Z", dispatched: ["A", "B"], handedToHuman: ["C"], note: "today" },
    { at: "2026-10-27T15:30:00Z", dispatched: [], handedToHuman: [], note: "省略", gate: true },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");

  it("counts per JST day, patrols and gate skips apart", () => {
    const { days } = summarizePatrols(`${lines}\nnot json\n`, now);
    expect(days).toHaveLength(7);
    expect(days.at(-1)).toEqual({ date: "2026-10-28", patrols: 1, gateSkips: 1, dispatched: 2, handedToHuman: 1 });
    expect(days.at(-2)).toEqual({ date: "2026-10-27", patrols: 0, gateSkips: 0, dispatched: 0, handedToHuman: 0 });
    expect(days.at(-3)).toEqual({ date: "2026-10-26", patrols: 1, gateSkips: 0, dispatched: 1, handedToHuman: 0 });
  });

  it("lists recent patrols newest first and skips unreadable lines", () => {
    const { recent } = summarizePatrols(`${lines}\nnot json\n`, now);
    expect(recent.map((r) => r.note)).toEqual(["省略", "today", "前日の23:59 JST"]);
    expect(recent[0].gate).toBe(true);
  });
});

describe("parseCronTargets", () => {
  it("keys jobs by log file and merges their schedules", () => {
    const crontab = [
      "# comment >> /tmp/ignored.log",
      "15 13 * * 1 cd /repo && npx tsx src/index.ts progress-report PJ:A >> /tmp/progress.log 2>&1",
      "45 10 * * 5 cd /repo && npx tsx src/index.ts progress-report PJ:A >> /tmp/progress.log 2>&1",
      "*/20 * * * * flock -n x $HOME/repo/scripts/orchestrator.sh work orchestrator-supervisor >> $HOME/state/supervisor.log 2>&1",
      "0 7 * * * cd /other && node src/cli/digest.ts >> /tmp/gmail-digest.log 2>&1",
      "0 8 * * * echo no log",
    ].join("\n");
    expect(
      parseCronTargets(crontab).map(({ job, schedules, logPath }) => ({ job, schedules, logPath })),
    ).toEqual([
      { job: "progress-report", schedules: ["15 13 * * 1", "45 10 * * 5"], logPath: "/tmp/progress.log" },
      { job: "orchestrator-supervisor", schedules: ["*/20 * * * *"], logPath: `${homedir()}/state/supervisor.log` },
      { job: "gmail-digest", schedules: ["0 7 * * *"], logPath: "/tmp/gmail-digest.log" },
    ]);
  });

  it("keeps each line's command as cron logs it", () => {
    const [target] = parseCronTargets("*/5  8-22 * * 1-5  cd /repo && run >> /tmp/a.log 2>&1");
    expect(target.commands).toEqual(["cd /repo && run >> /tmp/a.log 2>&1"]);
  });
});

describe("parseCronStarts", () => {
  it("keeps the last start of each command", () => {
    const syslog = [
      "2026-10-28T10:05:03.6+09:00 host CRON[1]: (me) CMD (cd /repo && run >> /tmp/a.log 2>&1)",
      "2026-10-28T10:06:00.0+09:00 host other[2]: CMD (not cron)",
      "2026-10-28T11:05:03.6+09:00 host CRON[3]: (me) CMD (cd /repo && run >> /tmp/a.log 2>&1)",
    ].join("\n");
    expect([...parseCronStarts(syslog)]).toEqual([
      ["cd /repo && run >> /tmp/a.log 2>&1", "2026-10-28T02:05:03.600Z"],
    ]);
  });
});

describe("summarizeLogTail", () => {
  it("returns the last line and the last error-looking line", () => {
    expect(summarizeLogTail("ok 1\nジョブ実行エラー [x]: fetch failed\nok 2\n\n")).toEqual({
      lastLine: "ok 2",
      lastErrorLine: "ジョブ実行エラー [x]: fetch failed",
      lastErrorAt: null,
    });
  });

  it("handles an empty log", () => {
    expect(summarizeLogTail("")).toEqual({ lastLine: null, lastErrorLine: null, lastErrorAt: null });
  });

  it("dates the last error by the run marker above it, and skips markers as output", () => {
    const log = [
      formatRunMarker("job", new Date("2026-10-27T14:50:00Z")),
      "ジョブ実行エラー [job]: fetch failed",
      formatRunMarker("job", new Date("2026-10-28T02:10:00Z")),
      "done",
      formatRunMarker("job", new Date("2026-10-28T02:50:00Z")),
    ].join("\n");
    expect(summarizeLogTail(log)).toEqual({
      lastLine: "done",
      lastErrorLine: "ジョブ実行エラー [job]: fetch failed",
      lastErrorAt: "2026-10-27T14:50:00.000Z",
    });
  });
});

describe("parseOpenPrs", () => {
  it("reads gh search output and skips rows without a repository or url", () => {
    const json = JSON.stringify([
      { repository: { nameWithOwner: "o/r" }, number: 12, title: "Fix a thing", url: "https://github.com/o/r/pull/12" },
      { repository: {}, number: 13, title: "broken", url: "https://github.com/o/r/pull/13" },
    ]);
    expect(parseOpenPrs(json)).toEqual([
      { repo: "o/r", number: 12, title: "Fix a thing", url: "https://github.com/o/r/pull/12" },
    ]);
  });
});

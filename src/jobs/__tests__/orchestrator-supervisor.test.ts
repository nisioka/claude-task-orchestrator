import { describe, it, expect } from "vitest";
import {
  assessHealth,
  evaluatePrerequisites,
  buildBootstrapPrompt,
  buildStartedPayload,
  buildStalledPayload,
  buildStartFailedPayload,
  buildDuplicatePayload,
  buildReloadPayload,
  parseSupervisorArgs,
  liveOrchestrators,
  reconcileDuplicates,
  assessRecycle,
  buildRecyclePayload,
} from "../orchestrator-supervisor.js";
import type { HeartbeatRecord, AgentSummary } from "../../lib/agent-runtime.js";
import type { OrchestratorConfig } from "../../lib/orchestrator-config.js";
import type { DiscordPayload } from "../../lib/types.js";

const NOW = new Date("2026-08-06T12:00:00.000Z");
const MAX_INTERVAL = 1800;
const GRACE = 1800;

function heartbeat(at: string): HeartbeatRecord {
  return { at, dispatched: [], handedToHuman: [], note: null };
}

function health(overrides: Partial<Parameters<typeof assessHealth>[0]> = {}) {
  return assessHealth({
    sessionListed: true,
    jobState: "working",
    lastHeartbeat: heartbeat("2026-08-06T11:50:00.000Z"),
    startedAt: NOW.getTime() - 10 * 3600 * 1000,
    now: NOW,
    maxIntervalSeconds: MAX_INTERVAL,
    graceSeconds: GRACE,
    ...overrides,
  });
}

// ─── assessHealth: the decision table from the design ───────────────

describe("assessHealth", () => {
  it("reports absent when the session is not listed", () => {
    expect(health({ sessionListed: false })).toEqual({ kind: "absent" });
  });

  it("reports absent when the session is listed but in a terminal state", () => {
    expect(health({ jobState: "done" })).toEqual({ kind: "absent" });
    expect(health({ jobState: "failed" })).toEqual({ kind: "absent" });
    expect(health({ jobState: "stopped" })).toEqual({ kind: "absent" });
  });

  it("reports absent for a terminal state even when the heartbeat is fresh", () => {
    expect(
      health({ jobState: "done", lastHeartbeat: heartbeat("2026-08-06T11:59:00.000Z") }),
    ).toEqual({ kind: "absent" });
  });

  it("reports healthy inside the post-launch grace period, before any heartbeat exists", () => {
    expect(
      health({ lastHeartbeat: null, startedAt: NOW.getTime() - 60_000 }),
    ).toEqual({ kind: "healthy" });
  });

  it("reports healthy when the heartbeat is fresh", () => {
    expect(health()).toEqual({ kind: "healthy" });
  });

  it("reports healthy when only a single tick was missed", () => {
    expect(health({ lastHeartbeat: heartbeat("2026-08-06T11:20:00.000Z") })).toEqual({
      kind: "healthy",
    });
  });

  it("reports stalled when the session is up but the heartbeat is old", () => {
    expect(health({ lastHeartbeat: heartbeat("2026-08-06T10:50:00.000Z") })).toEqual({
      kind: "stalled",
      lastHeartbeatAt: "2026-08-06T10:50:00.000Z",
    });
  });

  it("reports stalled when the session is up but has never written a heartbeat", () => {
    expect(health({ lastHeartbeat: null })).toEqual({ kind: "stalled", lastHeartbeatAt: null });
  });

  it("does not restart-loop: a session started moments ago is never stalled", () => {
    expect(
      health({ lastHeartbeat: null, startedAt: NOW.getTime() - (GRACE - 1) * 1000 }),
    ).toEqual({ kind: "healthy" });
  });

  it("stops shielding the session once the grace period lapses", () => {
    expect(
      health({ lastHeartbeat: null, startedAt: NOW.getTime() - (GRACE + 1) * 1000 }),
    ).toEqual({ kind: "stalled", lastHeartbeatAt: null });
  });

  it("does not shield a restarted session that already reported before it restarted", () => {
    // The daemon respawns a dead worker, resetting startedAt. The heartbeat is
    // newer than that restart, so this session has patrolled — the grace period
    // is for sessions that have not reported yet, and must not apply here.
    expect(
      health({
        startedAt: NOW.getTime() - 60_000,
        lastHeartbeat: heartbeat(new Date(NOW.getTime() - 30_000).toISOString()),
      }),
    ).toEqual({ kind: "healthy" });
  });

  it("shields a freshly started session whose only heartbeat predates it", () => {
    expect(
      health({
        startedAt: NOW.getTime() - 60_000,
        lastHeartbeat: heartbeat("2026-08-06T08:00:00.000Z"),
      }),
    ).toEqual({ kind: "healthy" });
  });

  it("judges on the heartbeat when the start time is unknown", () => {
    expect(health({ startedAt: null, lastHeartbeat: null })).toEqual({
      kind: "stalled",
      lastHeartbeatAt: null,
    });
  });
});

// ─── liveOrchestrators ──────────────────────────────────────────────

describe("liveOrchestrators", () => {
  const agent = (overrides: Partial<AgentSummary>): AgentSummary => ({
    pid: null,
    id: null,
    cwd: "/repo",
    kind: "background",
    startedAt: 1000,
    sessionId: "s",
    name: "ai-orchestrator",
    status: null,
    state: "working",
    ...overrides,
  });

  it("matches the session name exactly — a prefix match would depend on prompt wording", () => {
    const agents = [
      agent({ sessionId: "a" }),
      agent({ sessionId: "b", name: "ai-orchestrator-2" }),
      agent({ sessionId: "c", name: "ai-impl-TASK-1" }),
    ];

    expect(liveOrchestrators(agents).map((a) => a.sessionId)).toEqual(["a"]);
  });

  it("excludes sessions that already finished", () => {
    expect(liveOrchestrators([agent({ state: "done" })])).toEqual([]);
  });

  it("includes sessions with no reported state", () => {
    expect(liveOrchestrators([agent({ state: null })])).toHaveLength(1);
  });

  it("returns the newest first so duplicates resolve deterministically", () => {
    const agents = [
      agent({ sessionId: "old", startedAt: 1000 }),
      agent({ sessionId: "new", startedAt: 5000 }),
    ];

    expect(liveOrchestrators(agents).map((a) => a.sessionId)).toEqual(["new", "old"]);
  });
});

// ─── evaluatePrerequisites ──────────────────────────────────────────

describe("evaluatePrerequisites", () => {
  const supported = { serviceInstallSupported: true };

  it("is satisfied when the service and linger are both enabled", () => {
    expect(
      evaluatePrerequisites({ ...supported, serviceEnabled: true, lingerEnabled: true }),
    ).toEqual({ satisfied: true, problems: [] });
  });

  it("reports the missing service with a remedy", () => {
    const report = evaluatePrerequisites({ ...supported, serviceEnabled: false, lingerEnabled: true });

    expect(report.satisfied).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/claude daemon/);
  });

  it("reports missing linger with the exact command to run", () => {
    const report = evaluatePrerequisites({ ...supported, serviceEnabled: true, lingerEnabled: false });

    expect(report.problems[0]).toMatch(/loginctl enable-linger/);
  });

  it("reports both problems when neither is configured", () => {
    expect(
      evaluatePrerequisites({ ...supported, serviceEnabled: false, lingerEnabled: false }).problems,
    ).toHaveLength(2);
  });

  it("stays silent about the service when the CLI does not support installing one", () => {
    // A warning the human cannot clear trains them to ignore the whole notice.
    const report = evaluatePrerequisites({
      serviceInstallSupported: false,
      serviceEnabled: false,
      lingerEnabled: true,
    });

    expect(report).toEqual({ satisfied: true, problems: [] });
  });

  it("still reports linger when service install is unsupported", () => {
    const report = evaluatePrerequisites({
      serviceInstallSupported: false,
      serviceEnabled: false,
      lingerEnabled: false,
    });

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/loginctl enable-linger/);
  });
});

// ─── buildBootstrapPrompt ───────────────────────────────────────────

describe("buildBootstrapPrompt", () => {
  const config = {
    instructionPath: "/repo/prompts/orchestrator.md",
    heartbeatPath: "/state/heartbeat.jsonl",
    minIntervalSeconds: 600,
    targetIntervalSeconds: 1200,
    maxIntervalSeconds: 1800,
    implementModel: "opus",
    implementEffort: "xhigh",
    judgementModel: "opus",
  } as OrchestratorConfig;

  it("points at the instruction file rather than inlining it", () => {
    expect(buildBootstrapPrompt(config)).toContain("/repo/prompts/orchestrator.md");
  });

  it("carries the runtime settings the session cannot derive on its own", () => {
    const prompt = buildBootstrapPrompt(config);

    expect(prompt).toContain("/state/heartbeat.jsonl");
    expect(prompt).toContain("600");
    expect(prompt).toContain("1200");
    expect(prompt).toContain("1800");
    expect(prompt).toContain("xhigh");
  });

  it("does not hand the session a dispatch budget to police", () => {
    // The bottleneck is the human, not the machine. A number here would only
    // give the session something to throttle itself against, and nothing ever
    // counted dispatches anyway — the daily figure reset on every restart.
    const prompt = buildBootstrapPrompt(config);

    expect(prompt).not.toContain("同時実行数");
    expect(prompt).not.toContain("1日あたり");
  });

  it("stays short enough to sit on a command line", () => {
    expect(buildBootstrapPrompt(config).length).toBeLessThan(1000);
  });
});

// ─── Payloads ───────────────────────────────────────────────────────

describe("buildStartedPayload", () => {
  const satisfied = { satisfied: true, problems: [] };

  it("includes how to join the session", () => {
    const payload = buildStartedPayload("sid-1", "opus", "medium", "初回起動", satisfied);

    const value = payload.embeds?.[0].fields?.map((f) => f.value).join("\n") ?? "";
    expect(value).toContain("claude agents");
    expect(value).toContain("sid-1");
  });

  it("names the reason for the start", () => {
    const payload = buildStartedPayload("sid-1", "opus", "medium", "停滞のため再起動", satisfied);

    expect(payload.embeds?.[0].title).toContain("停滞のため再起動");
  });

  it("omits the prerequisite warning when everything is configured", () => {
    const payload = buildStartedPayload("sid-1", "opus", "medium", "初回起動", satisfied);

    expect(payload.embeds?.[0].fields?.some((f) => f.name.includes("前提条件"))).toBe(false);
  });

  it("surfaces unmet prerequisites alongside the start notice", () => {
    const payload = buildStartedPayload("sid-1", "opus", "medium", "初回起動", {
      satisfied: false,
      problems: ["linger が無効です"],
    });

    const field = payload.embeds?.[0].fields?.find((f) => f.name.includes("前提条件"));
    expect(field?.value).toContain("linger");
  });
});

describe("buildStalledPayload", () => {
  it("says the session is alive but the loop stopped", () => {
    const payload = buildStalledPayload("2026-08-06T10:00:00.000Z");

    expect(payload.embeds?.[0].description).toContain("巡回が止まって");
    expect(payload.embeds?.[0].description).toContain("2026-08-06T10:00:00.000Z");
  });

  it("handles never having had a heartbeat", () => {
    expect(buildStalledPayload(null).embeds?.[0].description).toContain("記録なし");
  });
});

describe("buildStartFailedPayload", () => {
  it("carries the failure message", () => {
    expect(buildStartFailedPayload("指示ファイルがありません").embeds?.[0].description).toBe(
      "指示ファイルがありません",
    );
  });
});

describe("buildDuplicatePayload", () => {
  it("lists every running session so the human can pick one to stop", () => {
    const description = buildDuplicatePayload(["a", "b"]).embeds?.[0].description ?? "";

    expect(description).toContain("claude agents");
    expect(description).toContain("`a`");
    expect(description).toContain("`b`");
    expect(description).toContain("2 個");
  });
});

describe("buildStalledPayload termination reporting", () => {
  it("says nothing extra when the old session was stopped", () => {
    expect(buildStalledPayload("2026-08-06T10:00:00.000Z", true).embeds?.[0].description).not.toContain(
      "終了できませんでした",
    );
  });

  it("warns when the old session could not be stopped", () => {
    const description = buildStalledPayload(null, false).embeds?.[0].description ?? "";

    expect(description).toContain("終了できませんでした");
    expect(description).toContain("二重に稼働");
  });
});

describe("buildStartedPayload field limits", () => {
  it("keeps the prerequisite field inside Discord's 1024 character limit", () => {
    const payload = buildStartedPayload("sid-1", "opus", "medium", "初回起動", {
      satisfied: false,
      problems: [Array.from({ length: 40 }, () => "非常に長い問題の説明。").join("")],
    });

    const field = payload.embeds?.[0].fields?.find((f) => f.name.includes("前提条件"));
    expect(field!.value.length).toBeLessThanOrEqual(1024);
  });
});

// ─── Forced reload ──────────────────────────────────────────────────

describe("parseSupervisorArgs", () => {
  it("defaults to leaving a healthy session alone", () => {
    expect(parseSupervisorArgs([])).toEqual({ forceRestart: false });
  });

  it("recognises --restart", () => {
    expect(parseSupervisorArgs(["--restart"])).toEqual({ forceRestart: true });
  });

  it("ignores unrelated arguments", () => {
    expect(parseSupervisorArgs(["--verbose", "restart"])).toEqual({ forceRestart: false });
  });
});

describe("buildReloadPayload", () => {
  it("names the session it stopped", () => {
    const description = buildReloadPayload("sid-9", true).embeds?.[0].description ?? "";

    expect(description).toContain("sid-9");
    expect(description).toContain("指示ファイル");
  });

  it("says the children survive, so the human does not expect lost work", () => {
    expect(buildReloadPayload("sid-9", true).embeds?.[0].description).toContain(
      "子エージェントは終了しません",
    );
  });

  it("warns when the old session could not be stopped", () => {
    expect(buildReloadPayload("sid-9", false).embeds?.[0].description).toContain(
      "終了できませんでした",
    );
  });
});

// ─── assessRecycle: what the next patrol will cost ──────────────────

describe("assessRecycle", () => {
  function recycle(overrides: Partial<Parameters<typeof assessRecycle>[0]> = {}) {
    return assessRecycle({
      contextTokens: 120_000,
      ageSeconds: 3600,
      maxContextTokens: 300_000,
      maxAgeSeconds: 86_400,
      ...overrides,
    });
  }

  it("keeps a session that is still small and young", () => {
    expect(recycle()).toEqual({ kind: "keep" });
  });

  it("recycles once the context reaches the limit", () => {
    expect(recycle({ contextTokens: 300_000 })).toEqual({
      kind: "recycle",
      cause: "context",
      contextTokens: 300_000,
    });
  });

  it("recycles on age when the context could not be measured", () => {
    expect(recycle({ contextTokens: null, ageSeconds: 90_000 })).toEqual({
      kind: "recycle",
      cause: "age",
      ageSeconds: 90_000,
    });
  });

  it("prefers the context reason, since that is what the cost follows", () => {
    expect(recycle({ contextTokens: 400_000, ageSeconds: 90_000 })).toMatchObject({
      cause: "context",
    });
  });

  it("keeps an unmeasurable session that is still young", () => {
    expect(recycle({ contextTokens: null })).toEqual({ kind: "keep" });
  });

  it("keeps everything when both limits are disabled", () => {
    expect(
      recycle({
        contextTokens: 900_000,
        ageSeconds: 400_000,
        maxContextTokens: null,
        maxAgeSeconds: null,
      }),
    ).toEqual({ kind: "keep" });
  });

  it("does not recycle a session whose age is unknown", () => {
    expect(recycle({ contextTokens: null, ageSeconds: null })).toEqual({ kind: "keep" });
  });
});

describe("buildRecyclePayload", () => {
  const verdict = { kind: "recycle", cause: "context", contextTokens: 312_000 } as const;

  it("reports the measurement that triggered it", () => {
    const description = buildRecyclePayload("sid-9", verdict, true).embeds?.[0].description ?? "";

    expect(description).toContain("312k");
    expect(description).toContain("sid-9");
  });

  it("says the patrol was healthy, so this does not read as a failure", () => {
    expect(buildRecyclePayload("sid-9", verdict, true).embeds?.[0].description).toContain(
      "巡回は正常",
    );
  });

  it("says the children survive", () => {
    expect(buildRecyclePayload("sid-9", verdict, true).embeds?.[0].description).toContain(
      "子エージェントは終了しません",
    );
  });

  it("reports the age when that is the cause", () => {
    const aged = { kind: "recycle", cause: "age", ageSeconds: 90_000 } as const;

    expect(buildRecyclePayload("sid-9", aged, true).embeds?.[0].description).toContain("25時間");
  });

  it("warns when the old session could not be stopped", () => {
    expect(buildRecyclePayload("sid-9", verdict, false).embeds?.[0].description).toContain(
      "終了できませんでした",
    );
  });
});

// ─── reconcileDuplicates ────────────────────────────────────────────

/**
 * Duplicates used to be announced and left standing, which made them permanent:
 * every later branch acts on the newest session, so a stranded older one was
 * never a termination candidate again. These pin the convergence, and the two
 * cases where evidence runs out and the job must not guess.
 */
describe("reconcileDuplicates", () => {
  const agent = (overrides: Partial<AgentSummary>): AgentSummary => ({
    pid: null,
    id: "short",
    cwd: "/repo",
    kind: "background",
    startedAt: 1000,
    sessionId: "s",
    name: "ai-orchestrator",
    status: null,
    state: "working",
    ...overrides,
  });

  // listAgents only runs on the reporting path, and a missing binary makes it
  // answer with an empty list rather than throwing.
  const config = { claudeExecutable: "/nonexistent/claude" } as OrchestratorConfig;

  function harness(kill: (a: AgentSummary) => boolean) {
    const sent: string[] = [];
    const killed: string[] = [];
    return {
      sent,
      killed,
      notify: async (payload: DiscordPayload) => {
        sent.push(payload.embeds?.[0].description ?? "");
      },
      terminate: async (a: AgentSummary) => {
        killed.push(a.sessionId);
        return kill(a);
      },
    };
  }

  it("leaves a single session alone", async () => {
    const h = harness(() => true);
    const live = [agent({ sessionId: "only" })];

    expect(await reconcileDuplicates(live, config, h.notify, h.terminate)).toEqual(live);
    expect(h.killed).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("terminates the older session and keeps the newest, saying nothing", async () => {
    const h = harness(() => true);
    const live = [
      agent({ sessionId: "new", id: "s1", startedAt: 5000 }),
      agent({ sessionId: "old", id: "s0", startedAt: 1000 }),
    ];

    const remaining = await reconcileDuplicates(live, config, h.notify, h.terminate);

    expect(h.killed).toEqual(["old"]);
    expect(remaining.map((a) => a.sessionId)).toEqual(["new"]);
    // 自力で収束したので人間に用は無い
    expect(h.sent).toEqual([]);
  });

  it("reports the ones that would not die", async () => {
    const h = harness(() => false);
    const live = [
      agent({ sessionId: "new", id: "s1", startedAt: 5000 }),
      agent({ sessionId: "old", id: "s0", startedAt: 1000 }),
    ];

    await reconcileDuplicates(live, config, h.notify, h.terminate);

    expect(h.killed).toEqual(["old"]);
    expect(h.sent.join()).toContain("old");
  });

  it("does not terminate a session it cannot prove is older", async () => {
    const h = harness(() => true);
    // 同着。どちらが後継か決められないものを殺すと、生きているほうを落としうる
    const live = [
      agent({ sessionId: "a", id: "s1", startedAt: 1000 }),
      agent({ sessionId: "b", id: "s0", startedAt: 1000 }),
    ];

    await reconcileDuplicates(live, config, h.notify, h.terminate);

    expect(h.killed).toEqual([]);
    expect(h.sent.join()).toContain("b");
  });

  it("does not terminate a session with no id to address", async () => {
    const h = harness(() => true);
    const live = [
      agent({ sessionId: "new", id: "s1", startedAt: 5000 }),
      agent({ sessionId: "old", id: null, startedAt: 1000 }),
    ];

    await reconcileDuplicates(live, config, h.notify, h.terminate);

    expect(h.killed).toEqual([]);
    expect(h.sent.join()).toContain("old");
  });
});

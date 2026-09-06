import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { homedir } from "node:os";
import {
  loadOrchestratorConfig,
  isEffortLevel,
  expandHome,
  ORCHESTRATOR_SESSION_NAME,
  PROMPT_CACHE_TTL_SECONDS,
  implAgentName,
  judgeAgentName,
  parseAgentName,
} from "../orchestrator-config.js";

/** Env vars this module reads; cleared before each test for hermetic defaults. */
const ORCHESTRATOR_ENV = [
  "ORCHESTRATOR_STATE_DIR",
  "ORCHESTRATOR_SESSION_ID_PATH",
  "ORCHESTRATOR_HEARTBEAT_PATH",
  "ORCHESTRATOR_INSTRUCTION_PATH",
  "ORCHESTRATOR_MODEL",
  "ORCHESTRATOR_EFFORT",
  "ORCHESTRATOR_IMPL_MODEL",
  "ORCHESTRATOR_IMPL_EFFORT",
  "ORCHESTRATOR_JUDGE_MODEL",
  "ORCHESTRATOR_JUDGE_EFFORT",
  "ORCHESTRATOR_MIN_INTERVAL_SECONDS",
  "ORCHESTRATOR_TARGET_INTERVAL_SECONDS",
  "ORCHESTRATOR_MAX_INTERVAL_SECONDS",
  "ORCHESTRATOR_STARTUP_GRACE_SECONDS",
  "ORCHESTRATOR_MAX_SESSION_CONTEXT_TOKENS",
  "ORCHESTRATOR_MAX_SESSION_AGE_SECONDS",
  "ORCHESTRATOR_CHILD_CONTEXT_LIMIT_TOKENS",
  "ORCHESTRATOR_CLAUDE_BIN",
];

beforeEach(() => {
  for (const name of ORCHESTRATOR_ENV) vi.stubEnv(name, undefined as unknown as string);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── expandHome ─────────────────────────────────────────────────────

describe("expandHome", () => {
  it("expands a leading ~/", () => {
    expect(expandHome("~/foo/bar")).toBe(`${homedir()}/foo/bar`);
  });

  it("expands a bare ~", () => {
    expect(expandHome("~")).toBe(homedir());
  });

  it("leaves absolute paths alone", () => {
    expect(expandHome("/var/lib/thing")).toBe("/var/lib/thing");
  });

  it("does not expand a ~ that is not at the start", () => {
    expect(expandHome("/opt/~/x")).toBe("/opt/~/x");
  });

  it("does not expand ~user", () => {
    expect(expandHome("~other/foo")).toBe("~other/foo");
  });
});

// ─── isEffortLevel ──────────────────────────────────────────────────

describe("isEffortLevel", () => {
  it.each(["low", "medium", "high", "xhigh", "max"])("accepts %s", (value) => {
    expect(isEffortLevel(value)).toBe(true);
  });

  it.each(["", "LOW", "extreme", "1"])("rejects %s", (value) => {
    expect(isEffortLevel(value)).toBe(false);
  });
});

// ─── loadOrchestratorConfig: defaults ───────────────────────────────

describe("loadOrchestratorConfig defaults", () => {
  it("defaults the state directory under ~/.local/state", () => {
    const config = loadOrchestratorConfig();

    expect(config.stateDir).toBe(`${homedir()}/.local/state/ai-orchestrator`);
  });

  it("derives the session id and heartbeat paths from the state directory", () => {
    vi.stubEnv("ORCHESTRATOR_STATE_DIR", "/var/lib/orch");

    const config = loadOrchestratorConfig();

    expect(config.sessionIdPath).toBe("/var/lib/orch/session-id");
    expect(config.heartbeatPath).toBe("/var/lib/orch/heartbeat.jsonl");
  });

  it("uses opus for all three roles", () => {
    const config = loadOrchestratorConfig();

    expect(config.orchestratorModel).toBe("opus");
    expect(config.implementModel).toBe("opus");
    expect(config.judgementModel).toBe("opus");
  });

  it("uses medium effort for the orchestrator and xhigh for implementation", () => {
    const config = loadOrchestratorConfig();

    expect(config.orchestratorEffort).toBe("medium");
    expect(config.implementEffort).toBe("xhigh");
  });

  it("leaves the judgement effort unset so the daemon default applies", () => {
    expect(loadOrchestratorConfig().judgementEffort).toBeNull();
  });

  it("uses 10 / 20 / 30 minute intervals", () => {
    const config = loadOrchestratorConfig();

    expect(config.minIntervalSeconds).toBe(600);
    expect(config.targetIntervalSeconds).toBe(1200);
    expect(config.maxIntervalSeconds).toBe(1800);
  });

  it("uses the real claude binary", () => {
    expect(loadOrchestratorConfig().claudeExecutable).toBe("claude");
  });

  it("keeps the maximum interval below the prompt cache TTL", () => {
    expect(loadOrchestratorConfig().maxIntervalSeconds).toBeLessThan(PROMPT_CACHE_TTL_SECONDS);
  });
});

// ─── loadOrchestratorConfig: overrides ──────────────────────────────

describe("loadOrchestratorConfig overrides", () => {
  it("reads each of the three model settings independently", () => {
    vi.stubEnv("ORCHESTRATOR_MODEL", "sonnet");
    vi.stubEnv("ORCHESTRATOR_IMPL_MODEL", "opus");
    vi.stubEnv("ORCHESTRATOR_JUDGE_MODEL", "haiku");

    const config = loadOrchestratorConfig();

    expect(config.orchestratorModel).toBe("sonnet");
    expect(config.implementModel).toBe("opus");
    expect(config.judgementModel).toBe("haiku");
  });

  it("reads each of the three effort settings independently", () => {
    vi.stubEnv("ORCHESTRATOR_EFFORT", "low");
    vi.stubEnv("ORCHESTRATOR_IMPL_EFFORT", "max");
    vi.stubEnv("ORCHESTRATOR_JUDGE_EFFORT", "high");

    const config = loadOrchestratorConfig();

    expect(config.orchestratorEffort).toBe("low");
    expect(config.implementEffort).toBe("max");
    expect(config.judgementEffort).toBe("high");
  });

  it("expands ~ in path settings", () => {
    vi.stubEnv("ORCHESTRATOR_STATE_DIR", "~/orch-state");
    vi.stubEnv("ORCHESTRATOR_INSTRUCTION_PATH", "~/prompts/orchestrator.md");

    const config = loadOrchestratorConfig();

    expect(config.stateDir).toBe(`${homedir()}/orch-state`);
    expect(config.instructionPath).toBe(`${homedir()}/prompts/orchestrator.md`);
  });

  it("allows the executable to be swapped for a fake agent", () => {
    vi.stubEnv("ORCHESTRATOR_CLAUDE_BIN", "/repo/test-fixtures/fake-claude.mjs");

    expect(loadOrchestratorConfig().claudeExecutable).toBe("/repo/test-fixtures/fake-claude.mjs");
  });

  it("allows the session id and heartbeat paths to be set explicitly", () => {
    vi.stubEnv("ORCHESTRATOR_SESSION_ID_PATH", "/srv/sid");
    vi.stubEnv("ORCHESTRATOR_HEARTBEAT_PATH", "/srv/hb.jsonl");

    const config = loadOrchestratorConfig();

    expect(config.sessionIdPath).toBe("/srv/sid");
    expect(config.heartbeatPath).toBe("/srv/hb.jsonl");
  });
});

// ─── loadOrchestratorConfig: invariants ─────────────────────────────

describe("loadOrchestratorConfig invariants", () => {
  it("rejects min > target", () => {
    vi.stubEnv("ORCHESTRATOR_MIN_INTERVAL_SECONDS", "1500");

    expect(() => loadOrchestratorConfig()).toThrow(/下限.*目標/);
  });

  it("rejects target > max", () => {
    vi.stubEnv("ORCHESTRATOR_TARGET_INTERVAL_SECONDS", "2000");
    vi.stubEnv("ORCHESTRATOR_MAX_INTERVAL_SECONDS", "1900");

    expect(() => loadOrchestratorConfig()).toThrow(/目標.*上限/);
  });

  it("accepts all three intervals being equal", () => {
    vi.stubEnv("ORCHESTRATOR_MIN_INTERVAL_SECONDS", "900");
    vi.stubEnv("ORCHESTRATOR_TARGET_INTERVAL_SECONDS", "900");
    vi.stubEnv("ORCHESTRATOR_MAX_INTERVAL_SECONDS", "900");

    expect(() => loadOrchestratorConfig()).not.toThrow();
  });

  it("rejects a maximum interval at or beyond the prompt cache TTL", () => {
    vi.stubEnv("ORCHESTRATOR_MAX_INTERVAL_SECONDS", String(PROMPT_CACHE_TTL_SECONDS));

    expect(() => loadOrchestratorConfig()).toThrow(/3600/);
  });

  it("explains why crossing the cache TTL is rejected", () => {
    vi.stubEnv("ORCHESTRATOR_MAX_INTERVAL_SECONDS", "7200");

    expect(() => loadOrchestratorConfig()).toThrow(/キャッシュ/);
  });

  it("accepts a maximum interval just under the TTL", () => {
    vi.stubEnv("ORCHESTRATOR_MAX_INTERVAL_SECONDS", String(PROMPT_CACHE_TTL_SECONDS - 1));

    expect(() => loadOrchestratorConfig()).not.toThrow();
  });

  it("rejects an unknown effort value and names the variable", () => {
    vi.stubEnv("ORCHESTRATOR_EFFORT", "extreme");

    expect(() => loadOrchestratorConfig()).toThrow(/ORCHESTRATOR_EFFORT/);
  });

  it("rejects an unknown implementation effort value", () => {
    vi.stubEnv("ORCHESTRATOR_IMPL_EFFORT", "turbo");

    expect(() => loadOrchestratorConfig()).toThrow(/ORCHESTRATOR_IMPL_EFFORT/);
  });

  it("rejects a state directory under /tmp — WSL does not persist it", () => {
    vi.stubEnv("ORCHESTRATOR_STATE_DIR", "/tmp/ai-orchestrator");

    expect(() => loadOrchestratorConfig()).toThrow(/tmp/);
  });

  it("does not mistake /tmpfoo for /tmp", () => {
    vi.stubEnv("ORCHESTRATOR_STATE_DIR", "/tmpfoo/state");

    expect(() => loadOrchestratorConfig()).not.toThrow();
  });

  it("rejects a non-numeric interval", () => {
    vi.stubEnv("ORCHESTRATOR_TARGET_INTERVAL_SECONDS", "twenty");

    expect(() => loadOrchestratorConfig()).toThrow(/ORCHESTRATOR_TARGET_INTERVAL_SECONDS/);
  });

  it("rejects a zero interval", () => {
    vi.stubEnv("ORCHESTRATOR_MIN_INTERVAL_SECONDS", "0");

    expect(() => loadOrchestratorConfig()).toThrow(/ORCHESTRATOR_MIN_INTERVAL_SECONDS/);
  });

});

// ─── Session naming ─────────────────────────────────────────────────

describe("session naming", () => {
  it("names the resident session ai-orchestrator", () => {
    expect(ORCHESTRATOR_SESSION_NAME).toBe("ai-orchestrator");
  });

  it("derives implementation agent names", () => {
    expect(implAgentName("TASK-1226")).toBe("ai-impl-TASK-1226");
  });

  it("derives judgement agent names", () => {
    expect(judgeAgentName("TASK-1226")).toBe("ai-judge-TASK-1226");
  });

  it("rejects an identifier that is not in Linear's format", () => {
    expect(() => implAgentName("not an id")).toThrow();
    expect(() => judgeAgentName("")).toThrow();
  });

  it("accepts whatever shape the task source spells identifiers in", () => {
    // ClickUp's have no dash and no trailing number. A pattern built around
    // Linear's shape would make every child unparseable on ClickUp — and an
    // unparseable name is dropped from the status view, so the human would see
    // no running children while children were running.
    expect(implAgentName("z8tj1h26um")).toBe("ai-impl-z8tj1h26um");
    expect(parseAgentName("ai-impl-z8tj1h26um")).toEqual({
      role: "impl",
      issueIdentifier: "z8tj1h26um",
    });
  });

  it("still shows a name with a stray suffix, rather than hiding it", () => {
    // The naming convention is exact and a suffix breaks collation with the
    // task. Reporting it under an identifier that matches nothing is the loud
    // failure; returning null would drop the agent from the view.
    expect(parseAgentName("ai-impl-TASK-1226-extra")).toEqual({
      role: "impl",
      issueIdentifier: "TASK-1226-extra",
    });
  });

  it("round-trips an implementation name back to its issue identifier", () => {
    const identifier = "TASK-1226";

    expect(parseAgentName(implAgentName(identifier))).toEqual({
      role: "impl",
      issueIdentifier: identifier,
    });
  });

  it("round-trips a judgement name back to its issue identifier", () => {
    const identifier = "PRIV-7";

    expect(parseAgentName(judgeAgentName(identifier))).toEqual({
      role: "judge",
      issueIdentifier: identifier,
    });
  });

  it("recognises the resident session name", () => {
    expect(parseAgentName(ORCHESTRATOR_SESSION_NAME)).toEqual({ role: "orchestrator" });
  });

  it.each([
    "",
    "ai-impl-",
    "ai-orchestrator-2",
    "claude-code",
    "ai-impl-two words",
    "ai-impl-/tmp/some/path",
  ])("returns null for %s", (name) => {
    expect(parseAgentName(name)).toBeNull();
  });
});

// ─── Recycle limits ─────────────────────────────────────────────────

describe("loadOrchestratorConfig recycle limits", () => {
  it("caps the resident session by default, since context only grows", () => {
    const config = loadOrchestratorConfig();

    expect(config.maxSessionContextTokens).toBe(300_000);
    expect(config.maxSessionAgeSeconds).toBe(86_400);
    expect(config.childContextLimitTokens).toBe(400_000);
  });

  it("accepts an override", () => {
    vi.stubEnv("ORCHESTRATOR_MAX_SESSION_CONTEXT_TOKENS", "250000");

    expect(loadOrchestratorConfig().maxSessionContextTokens).toBe(250_000);
  });

  it('treats "-" as no limit', () => {
    vi.stubEnv("ORCHESTRATOR_MAX_SESSION_CONTEXT_TOKENS", "-");
    vi.stubEnv("ORCHESTRATOR_MAX_SESSION_AGE_SECONDS", "-");

    const config = loadOrchestratorConfig();

    expect(config.maxSessionContextTokens).toBeNull();
    expect(config.maxSessionAgeSeconds).toBeNull();
  });

  it("rejects a context limit a fresh session would already exceed", () => {
    vi.stubEnv("ORCHESTRATOR_MAX_SESSION_CONTEXT_TOKENS", "50000");

    expect(() => loadOrchestratorConfig()).toThrow(/小さすぎます/);
  });

  it("rejects an age limit shorter than two patrols", () => {
    vi.stubEnv("ORCHESTRATOR_MAX_INTERVAL_SECONDS", "1800");
    vi.stubEnv("ORCHESTRATOR_MAX_SESSION_AGE_SECONDS", "1800");

    expect(() => loadOrchestratorConfig()).toThrow(/短すぎます/);
  });

  it("rejects a non-integer limit", () => {
    vi.stubEnv("ORCHESTRATOR_CHILD_CONTEXT_LIMIT_TOKENS", "たくさん");

    expect(() => loadOrchestratorConfig()).toThrow(/不正です/);
  });
});

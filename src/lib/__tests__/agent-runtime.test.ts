import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import {
  terminateSession,
  parseAgentList,
  parseJobState,
  classifyRun,
  buildLaunchArgs,
  jobStatePath,
  parseHeartbeatTail,
  isHeartbeatStale,
  pickLaunchedAgent,
  buildKillRequest,
  TERMINAL_AGENT_STATES,
} from "../agent-runtime.js";
import type { AgentSummary } from "../agent-runtime.js";

// ─── parseAgentList ─────────────────────────────────────────────────

describe("parseAgentList", () => {
  it("parses a background entry", () => {
    const stdout = JSON.stringify([
      {
        id: "1b27421a",
        cwd: "/home/tester/repo",
        kind: "background",
        startedAt: 1785830544635,
        sessionId: "1b27421a-63cb-4848-be01-e0712d4fda83",
        name: "ai-impl-TASK-1226",
        state: "done",
      },
    ]);

    expect(parseAgentList(stdout)).toEqual([
      {
        pid: null,
        id: "1b27421a",
        cwd: "/home/tester/repo",
        kind: "background",
        startedAt: 1785830544635,
        sessionId: "1b27421a-63cb-4848-be01-e0712d4fda83",
        name: "ai-impl-TASK-1226",
        status: null,
        state: "done",
      },
    ]);
  });

  it("parses an interactive entry, which carries pid and status but no id or state", () => {
    const stdout = JSON.stringify([
      {
        pid: 690190,
        cwd: "/home/tester/wt",
        kind: "interactive",
        startedAt: 1785485394922,
        sessionId: "86191eba-6676-4d7f-b8e4-6931f45b84d5",
        name: "fix-something",
        status: "idle",
      },
    ]);

    const [agent] = parseAgentList(stdout);

    expect(agent.pid).toBe(690190);
    expect(agent.status).toBe("idle");
    expect(agent.id).toBeNull();
    expect(agent.state).toBeNull();
  });

  it("returns [] for malformed JSON instead of throwing", () => {
    expect(parseAgentList("not json {{{")).toEqual([]);
  });

  it("returns [] when the payload is not an array", () => {
    expect(parseAgentList(JSON.stringify({ agents: [] }))).toEqual([]);
  });

  it("returns [] for empty output", () => {
    expect(parseAgentList("")).toEqual([]);
  });

  it("drops entries without a session id but keeps the rest", () => {
    const stdout = JSON.stringify([
      { cwd: "/a", kind: "background", name: "no-session" },
      { sessionId: "s-2", name: "ok", cwd: "/b", kind: "background" },
    ]);

    const agents = parseAgentList(stdout);

    expect(agents).toHaveLength(1);
    expect(agents[0].sessionId).toBe("s-2");
  });

  it("drops non-object entries", () => {
    const stdout = JSON.stringify([null, 42, "x", { sessionId: "s-1", name: "ok" }]);

    expect(parseAgentList(stdout)).toHaveLength(1);
  });

  it("nulls out missing optional fields rather than dropping the entry", () => {
    const stdout = JSON.stringify([{ sessionId: "s-1" }]);

    expect(parseAgentList(stdout)).toEqual([
      {
        pid: null,
        id: null,
        cwd: "",
        kind: "",
        startedAt: null,
        sessionId: "s-1",
        name: "",
        status: null,
        state: null,
      },
    ]);
  });

  it("ignores fields whose type is wrong instead of failing the whole list", () => {
    const stdout = JSON.stringify([
      { sessionId: "s-1", name: 7, pid: "not-a-number", startedAt: "yesterday" },
    ]);

    const [agent] = parseAgentList(stdout);

    expect(agent.name).toBe("");
    expect(agent.pid).toBeNull();
    expect(agent.startedAt).toBeNull();
  });
});

// ─── parseJobState ──────────────────────────────────────────────────

describe("parseJobState", () => {
  const full = JSON.stringify({
    state: "done",
    detail: "PR を作成しました",
    inFlight: { tasks: 2, queued: 0, kinds: ["local_bash"] },
    tokens: 3254,
    output: { result: "作業完了" },
    intent: "TASK-1226 を実装する",
    resumeSessionId: "1b27421a-63cb-4848-be01-e0712d4fda83",
    linkScanPath: "/home/tester/.claude/projects/x/session.jsonl",
  });

  it("extracts every field the orchestrator reports on", () => {
    expect(parseJobState(full)).toEqual({
      state: "done",
      detail: "PR を作成しました",
      inFlightTasks: 2,
      tokens: 3254,
      result: "作業完了",
      intent: "TASK-1226 を実装する",
      resumeSessionId: "1b27421a-63cb-4848-be01-e0712d4fda83",
      transcriptPath: "/home/tester/.claude/projects/x/session.jsonl",
    });
  });

  it("returns nulls for missing fields", () => {
    expect(parseJobState("{}")).toEqual({
      state: null,
      detail: null,
      inFlightTasks: null,
      tokens: null,
      result: null,
      intent: null,
      resumeSessionId: null,
      transcriptPath: null,
    });
  });

  it("returns null for malformed JSON", () => {
    expect(parseJobState("{ nope")).toBeNull();
  });

  it.each([["[]"], ['"text"'], ["42"], ["null"]])("returns null for non-object payload %s", (raw) => {
    expect(parseJobState(raw)).toBeNull();
  });

  it("tolerates inFlight being absent or the wrong shape", () => {
    expect(parseJobState(JSON.stringify({ inFlight: null }))?.inFlightTasks).toBeNull();
    expect(parseJobState(JSON.stringify({ inFlight: "busy" }))?.inFlightTasks).toBeNull();
    expect(parseJobState(JSON.stringify({ inFlight: { tasks: "two" } }))?.inFlightTasks).toBeNull();
  });

  it("tolerates output being absent or the wrong shape", () => {
    expect(parseJobState(JSON.stringify({ output: null }))?.result).toBeNull();
    expect(parseJobState(JSON.stringify({ output: { result: 5 } }))?.result).toBeNull();
  });
});

// ─── classifyRun ────────────────────────────────────────────────────

describe("classifyRun", () => {
  it.each(TERMINAL_AGENT_STATES)(
    "treats the terminal state %s as finished even while still listed",
    (state) => {
      expect(classifyRun({ listed: true, jobState: state })).toBe("finished");
    },
  );

  it("treats a terminal state as finished when no longer listed", () => {
    expect(classifyRun({ listed: false, jobState: "done" })).toBe("finished");
  });

  it("treats a listed, non-terminal agent as running", () => {
    expect(classifyRun({ listed: true, jobState: "working" })).toBe("running");
  });

  it("treats a listed agent with no state file as running", () => {
    expect(classifyRun({ listed: true, jobState: null })).toBe("running");
  });

  it("treats an unlisted, non-terminal agent as missing — sleep and reboot do this daily", () => {
    expect(classifyRun({ listed: false, jobState: "working" })).toBe("missing");
    expect(classifyRun({ listed: false, jobState: null })).toBe("missing");
  });
});

// ─── buildLaunchArgs ────────────────────────────────────────────────

describe("buildLaunchArgs", () => {
  const base = {
    prompt: "指示ファイル /p/orchestrator.md を読んで開始してください",
    cwd: "/home/tester/repo",
    model: "opus",
    name: "ai-impl-TASK-1226",
  };

  it("requests a background session", () => {
    expect(buildLaunchArgs(base)).toContain("--bg");
  });

  it("never passes -p or --print — combined with --bg the process exits 0 doing nothing", () => {
    const args = buildLaunchArgs({ ...base, effort: "xhigh", brief: true });

    expect(args).not.toContain("-p");
    expect(args).not.toContain("--print");
  });

  it("does not pass --session-id — the daemon overrides it under --bg", () => {
    expect(buildLaunchArgs(base)).not.toContain("--session-id");
  });

  it("always names the session — otherwise the daemon invents one from the prompt", () => {
    const args = buildLaunchArgs(base);

    expect(args[args.indexOf("--name") + 1]).toBe("ai-impl-TASK-1226");
  });

  it("passes the model", () => {
    expect(buildLaunchArgs(base)[buildLaunchArgs(base).indexOf("--model") + 1]).toBe("opus");
  });

  it("passes effort only when given", () => {
    expect(buildLaunchArgs(base)).not.toContain("--effort");

    const args = buildLaunchArgs({ ...base, effort: "xhigh" });
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
  });

  it("passes --brief only when requested", () => {
    expect(buildLaunchArgs(base)).not.toContain("--brief");
    expect(buildLaunchArgs({ ...base, brief: true })).toContain("--brief");
  });

  it("passes the permission mode only when given", () => {
    expect(buildLaunchArgs(base)).not.toContain("--permission-mode");

    const args = buildLaunchArgs({ ...base, permissionMode: "auto" });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
  });

  it("puts the prompt last, as a positional argument", () => {
    const args = buildLaunchArgs({ ...base, effort: "xhigh", brief: true });

    expect(args[args.length - 1]).toBe(base.prompt);
  });

  it("rejects an empty name", () => {
    expect(() => buildLaunchArgs({ ...base, name: "" })).toThrow();
  });
});

// ─── pickLaunchedAgent ──────────────────────────────────────────────

describe("pickLaunchedAgent", () => {
  const agent = (overrides: Partial<AgentSummary>): AgentSummary => ({
    pid: null,
    id: null,
    cwd: "/repo",
    kind: "background",
    startedAt: 1000,
    sessionId: "s",
    name: "ai-impl-TASK-1226",
    status: null,
    state: null,
    ...overrides,
  });

  it("returns the entry that appeared after the launch", () => {
    const before = [agent({ sessionId: "old" })];
    const after = [agent({ sessionId: "old" }), agent({ sessionId: "new", startedAt: 2000 })];

    expect(pickLaunchedAgent(before, after, "ai-impl-TASK-1226")?.sessionId).toBe("new");
  });

  it("returns null when nothing new appeared — a finished run does not count as a launch", () => {
    const before = [agent({ sessionId: "old", state: "done" })];

    expect(pickLaunchedAgent(before, before, "ai-impl-TASK-1226")).toBeNull();
  });

  it("ignores entries with a different name", () => {
    const after = [agent({ sessionId: "new", name: "something-else" })];

    expect(pickLaunchedAgent([], after, "ai-impl-TASK-1226")).toBeNull();
  });

  it("prefers the most recently started candidate", () => {
    const after = [
      agent({ sessionId: "a", startedAt: 1000 }),
      agent({ sessionId: "b", startedAt: 3000 }),
    ];

    expect(pickLaunchedAgent([], after, "ai-impl-TASK-1226")?.sessionId).toBe("b");
  });
});

// ─── buildKillRequest ───────────────────────────────────────────────

describe("buildKillRequest", () => {
  it("asks the daemon to kill and evict the job", () => {
    expect(buildKillRequest("1b27421a")).toEqual({
      proto: 1,
      op: "kill",
      short: "1b27421a",
      evict: true,
    });
  });
});

// ─── jobStatePath ───────────────────────────────────────────────────

describe("jobStatePath", () => {
  it("points at the daemon's per-job state file", () => {
    expect(jobStatePath("1b27421a", "/home/tester")).toBe(
      "/home/tester/.claude/jobs/1b27421a/state.json",
    );
  });
});

// ─── parseHeartbeatTail ─────────────────────────────────────────────

describe("parseHeartbeatTail", () => {
  const line = (at: string) =>
    JSON.stringify({ at, dispatched: ["TASK-1"], handedToHuman: [], note: "巡回" });

  it("reads only the last line", () => {
    const raw = [line("2026-08-06T00:00:00.000Z"), line("2026-08-06T00:20:00.000Z")].join("\n");

    expect(parseHeartbeatTail(raw)?.at).toBe("2026-08-06T00:20:00.000Z");
  });

  it("tolerates a trailing newline", () => {
    expect(parseHeartbeatTail(line("2026-08-06T00:20:00.000Z") + "\n")?.at).toBe(
      "2026-08-06T00:20:00.000Z",
    );
  });

  it("maps the record fields", () => {
    const raw = JSON.stringify({
      at: "2026-08-06T00:20:00.000Z",
      dispatched: ["TASK-1", "TASK-2"],
      handedToHuman: ["TASK-3"],
      note: "2件投入",
    });

    expect(parseHeartbeatTail(raw)).toEqual({
      at: "2026-08-06T00:20:00.000Z",
      dispatched: ["TASK-1", "TASK-2"],
      handedToHuman: ["TASK-3"],
      note: "2件投入",
    });
  });

  it("defaults the lists to empty and the note to null", () => {
    const raw = JSON.stringify({ at: "2026-08-06T00:20:00.000Z" });

    expect(parseHeartbeatTail(raw)).toEqual({
      at: "2026-08-06T00:20:00.000Z",
      dispatched: [],
      handedToHuman: [],
      note: null,
    });
  });

  it("keeps only string entries in the lists", () => {
    const raw = JSON.stringify({ at: "2026-08-06T00:20:00.000Z", dispatched: ["a", 1, null] });

    expect(parseHeartbeatTail(raw)?.dispatched).toEqual(["a"]);
  });

  it.each([["", "empty file"], ["\n\n", "blank lines"], ["{ broken", "malformed line"]])(
    "returns null for %s",
    (raw) => {
      expect(parseHeartbeatTail(raw)).toBeNull();
    },
  );

  it("returns null when the last line has no timestamp", () => {
    expect(parseHeartbeatTail(JSON.stringify({ dispatched: [] }))).toBeNull();
  });

  it("returns null when the last line is malformed, without falling back to an earlier line", () => {
    const raw = [line("2026-08-06T00:00:00.000Z"), "{ broken"].join("\n");

    expect(parseHeartbeatTail(raw)).toBeNull();
  });
});

// ─── isHeartbeatStale ───────────────────────────────────────────────

describe("isHeartbeatStale", () => {
  const now = new Date("2026-08-06T01:00:00.000Z");
  const MAX = 1800; // 30 minutes; threshold is twice that

  const at = (iso: string) => ({ at: iso, dispatched: [], handedToHuman: [], note: null });

  it("treats a missing record as stalled", () => {
    expect(isHeartbeatStale(null, now, MAX)).toBe(true);
  });

  it("is not stale when one tick was missed", () => {
    // 40 minutes ago: one skipped tick, still inside 2 × 30 minutes.
    expect(isHeartbeatStale(at("2026-08-06T00:20:00.000Z"), now, MAX)).toBe(false);
  });

  it("is stale once two consecutive ticks were missed", () => {
    // 61 minutes ago: beyond 2 × 30 minutes.
    expect(isHeartbeatStale(at("2026-08-05T23:59:00.000Z"), now, MAX)).toBe(true);
  });

  it("is not stale exactly at the threshold", () => {
    expect(isHeartbeatStale(at("2026-08-06T00:00:00.000Z"), now, MAX)).toBe(false);
  });

  it("is stale one second past the threshold", () => {
    expect(isHeartbeatStale(at("2026-08-05T23:59:59.000Z"), now, MAX)).toBe(true);
  });

  it("treats an unparseable timestamp as stalled", () => {
    expect(isHeartbeatStale(at("yesterday"), now, MAX)).toBe(true);
  });

  it("is not stale for a record from the future — clock skew is not a stall", () => {
    expect(isHeartbeatStale(at("2026-08-06T01:05:00.000Z"), now, MAX)).toBe(false);
  });
});

// ─── terminateSession ───────────────────────────────────────────────

/**
 * The multi-daemon case is the whole reason this function loops.
 *
 * `ENOJOB` is one daemon saying it does not have the job — not that the job is
 * gone. Answering on the first such reply reports a kill against a daemon that
 * was never asked, and the session it belongs to keeps running.
 */
describe("terminateSession", () => {
  const servers: Server[] = [];
  let root: string | null = null;

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((done) => s.close(() => done()))));
    servers.length = 0;
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  /** Sockets are listed newest first, so `name` decides the order they are tried. */
  async function serve(name: string, response: Record<string, unknown>): Promise<void> {
    if (!root) {
      await mkdir(join(homedir(), ".cache"), { recursive: true });
      root = await mkdtemp(join(homedir(), ".cache", "terminate-"));
      vi.stubEnv("ORCHESTRATOR_DAEMON_SOCK_DIR", root);
    }
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    const server = createServer((socket) => {
      socket.on("data", () => socket.end(`${JSON.stringify(response)}\n`));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(join(dir, "control.sock"), done));
  }

  it("keeps asking after a daemon disclaims the job", async () => {
    await serve("a", { ok: false, code: "ENOJOB" });
    await serve("b", { ok: true });

    expect(await terminateSession("short-1")).toBe(true);
  });

  it("reports success only once every daemon has disclaimed it", async () => {
    await serve("a", { ok: false, code: "ENOJOB" });
    await serve("b", { ok: false, code: "ENOJOB" });

    expect(await terminateSession("short-1")).toBe(true);
  });

  it("reports failure when a daemon refuses for any other reason", async () => {
    await serve("a", { ok: false, code: "ENOJOB" });
    await serve("b", { ok: false, code: "EBUSY" });

    expect(await terminateSession("short-1")).toBe(false);
  });

  it("reports failure when there is no daemon to ask", async () => {
    await mkdir(join(homedir(), ".cache"), { recursive: true });
    root = await mkdtemp(join(homedir(), ".cache", "terminate-"));
    vi.stubEnv("ORCHESTRATOR_DAEMON_SOCK_DIR", root);

    // No answer at all is not "nothing left to stop".
    expect(await terminateSession("short-1")).toBe(false);
  });
});

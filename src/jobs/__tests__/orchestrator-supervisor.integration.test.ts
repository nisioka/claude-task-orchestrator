import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DiscordPayload } from "../../lib/types.js";
import { listFakeAgentPids, reapFakeAgentsSince } from "../../lib/__tests__/fake-agent-reaper.js";
import { ORCHESTRATOR_SESSION_NAME } from "../../lib/orchestrator-config.js";

/**
 * Exercises the supervisor against the fake agent, spending no model usage.
 *
 * The stalled case is the one worth automating: the session is present and
 * answering, so a liveness check reports it healthy forever. Only the
 * heartbeat distinguishes it, and only a test that actually runs the job
 * proves the distinction survives refactoring.
 */

/**
 * Every case here spawns a real Node process, which normally takes well under a
 * second — but the default 5s budget is measured while the rest of the suite is
 * running in parallel, and it was overrun roughly once in six full runs.
 */
vi.setConfig({ testTimeout: 30_000 });

// supervisor は core の設定だけを使う。core-config を差し替えないと実物が .env を探しに行く
vi.mock("../../lib/core-config.js", () => ({
  loadCoreConfig: () => ({
    taskSource: "linear" as const, taskSourceApiKey: "k",
    discordWebhookUrl: "https://discord.com/api/webhooks/1/x",
  }),
}));

const sent: DiscordPayload[] = [];
vi.mock("../../lib/notification.js", () => ({
  sendNotifications: async (_config: unknown, payload: DiscordPayload) => {
    sent.push(payload);
  },
}));

const FAKE_CLAUDE = resolve("test-fixtures/fake-claude.mjs");

let workDir: string;
let registryPath: string;
let sessionIdPath: string;
let heartbeatPath: string;
let agentsBefore: Set<number>;

beforeEach(async () => {
  sent.length = 0;
  agentsBefore = listFakeAgentPids(ORCHESTRATOR_SESSION_NAME);
  // Not under /tmp: the config guard rejects a state dir there, and rightly so.
  await mkdir(join(homedir(), ".cache"), { recursive: true });
  workDir = await mkdtemp(join(homedir(), ".cache", "supervisor-int-"));
  registryPath = join(workDir, "registry.json");
  sessionIdPath = join(workDir, "session-id");
  heartbeatPath = join(workDir, "heartbeat.jsonl");

  const instructionPath = join(workDir, "orchestrator.md");
  await writeFile(instructionPath, "# 指示\n巡回してください。\n", "utf-8");

  // An empty socket dir keeps termination away from the developer's daemon.
  await mkdir(join(workDir, "sockets"), { recursive: true });

  vi.stubEnv("ORCHESTRATOR_STATE_DIR", workDir);
  vi.stubEnv("ORCHESTRATOR_SESSION_ID_PATH", sessionIdPath);
  vi.stubEnv("ORCHESTRATOR_HEARTBEAT_PATH", heartbeatPath);
  vi.stubEnv("ORCHESTRATOR_INSTRUCTION_PATH", instructionPath);
  vi.stubEnv("ORCHESTRATOR_CLAUDE_BIN", FAKE_CLAUDE);
  vi.stubEnv("ORCHESTRATOR_STARTUP_GRACE_SECONDS", "1");
  vi.stubEnv("ORCHESTRATOR_DAEMON_SOCK_DIR", join(workDir, "sockets"));

  vi.stubEnv("FAKE_CLAUDE_REGISTRY", registryPath);
  vi.stubEnv("FAKE_CLAUDE_HOME", workDir);
  vi.stubEnv("FAKE_CLAUDE_DELAY_MS", "60000");
});

afterEach(async () => {
  for (const agent of await readRegistry()) {
    if (typeof agent.pid === "number") {
      try {
        process.kill(agent.pid);
      } catch {
        // already gone
      }
    }
  }
  // レジストリに載る前に失敗した子はここまでの回収に掛からない。pid の差分で拾う。
  // 名前で絞る。絞らないと、並列に走る他のファイルが起動した子まで落としてしまう。
  reapFakeAgentsSince(agentsBefore, ORCHESTRATOR_SESSION_NAME);
  vi.unstubAllEnvs();
  await rm(workDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────

interface RegistryEntry {
  pid: number | null;
  id: string | null;
  cwd: string;
  kind: string;
  startedAt: number;
  sessionId: string;
  name: string;
  status: string | null;
  state: string | null;
}

async function readRegistry(): Promise<RegistryEntry[]> {
  try {
    return JSON.parse(await readFile(registryPath, "utf-8"));
  } catch {
    return [];
  }
}

async function seedRegistry(entries: Partial<RegistryEntry>[]): Promise<void> {
  const full = entries.map((entry, index) => ({
    pid: null,
    id: `seed${index}`,
    cwd: workDir,
    kind: "background",
    startedAt: Date.now() - 3_600_000,
    sessionId: `seeded-session-${index}`,
    name: "ai-orchestrator",
    status: "busy",
    state: "working",
    ...entry,
  }));
  await writeFile(registryPath, JSON.stringify(full, null, 2), "utf-8");
}

async function writeHeartbeat(at: Date): Promise<void> {
  await writeFile(
    heartbeatPath,
    `${JSON.stringify({ at: at.toISOString(), dispatched: [], handedToHuman: [], note: "巡回" })}\n`,
    "utf-8",
  );
}

async function run(options: { forceRestart?: boolean } = {}): Promise<void> {
  const { runOrchestratorSupervisor } = await import("../orchestrator-supervisor.js");
  await runOrchestratorSupervisor(options);
}

async function recordedSessionId(): Promise<string | null> {
  try {
    return (await readFile(sessionIdPath, "utf-8")).trim();
  } catch {
    return null;
  }
}

// ─── Scenarios ──────────────────────────────────────────────────────

describe("runOrchestratorSupervisor", () => {
  it("starts a session when none exists, and records its id", async () => {
    await run();

    const agents = await readRegistry();
    expect(agents.filter((a) => a.name === "ai-orchestrator")).toHaveLength(1);
    expect(await recordedSessionId()).toBe(agents[0].sessionId);
  });

  it("tells the human how to join the session it started", async () => {
    await run();

    const text = JSON.stringify(sent);
    expect(text).toContain("claude agents");
    expect(text).toContain("初回起動");
  });

  it("stays silent and changes nothing when the session is healthy", async () => {
    await seedRegistry([{}]);
    await writeHeartbeat(new Date());

    await run();

    expect(sent).toEqual([]);
    expect(await readRegistry()).toHaveLength(1);
  });

  it("adopts an unrecorded session under our name instead of starting a second one", async () => {
    await seedRegistry([{ sessionId: "unrecorded-1" }]);
    await writeHeartbeat(new Date());

    await run();

    expect(await readRegistry()).toHaveLength(1);
    expect(await recordedSessionId()).toBe("unrecorded-1");
    expect(sent).toEqual([]);
  });

  it("replaces a healthy session that has outlived its context budget", async () => {
    // Patrolling normally — only the price of each patrol has gone up. The
    // context measurement needs a transcript the daemon named; with none, the
    // age backstop is what has to fire.
    await seedRegistry([{ sessionId: "aged-1", startedAt: Date.now() - 30 * 3600 * 1000 }]);
    await writeHeartbeat(new Date());

    await run();

    const orchestrators = (await readRegistry()).filter((a) => a.name === "ai-orchestrator");
    expect(orchestrators).toHaveLength(2);
    expect(await recordedSessionId()).not.toBe("aged-1");
    expect(JSON.stringify(sent)).toContain("入れ替え");
  });

  it("leaves a healthy session alone when both recycle limits are disabled", async () => {
    vi.stubEnv("ORCHESTRATOR_MAX_SESSION_CONTEXT_TOKENS", "-");
    vi.stubEnv("ORCHESTRATOR_MAX_SESSION_AGE_SECONDS", "-");
    await seedRegistry([{ sessionId: "aged-2", startedAt: Date.now() - 30 * 3600 * 1000 }]);
    await writeHeartbeat(new Date());

    await run();

    expect(sent).toEqual([]);
    expect(await readRegistry()).toHaveLength(1);
  });

  it("restarts a session that is present but has stopped patrolling", async () => {
    await seedRegistry([{ sessionId: "stalled-1" }]);
    // Two intervals of silence: present, answering, but the loop has stopped.
    await writeHeartbeat(new Date(Date.now() - 3 * 1800 * 1000));

    await run();

    const orchestrators = (await readRegistry()).filter((a) => a.name === "ai-orchestrator");
    expect(orchestrators).toHaveLength(2);

    const recorded = await recordedSessionId();
    expect(recorded).not.toBe("stalled-1");
    expect(orchestrators.map((a) => a.sessionId)).toContain(recorded);
  });

  it("reports the stall before restarting", async () => {
    await seedRegistry([{ sessionId: "stalled-1" }]);
    await writeHeartbeat(new Date(Date.now() - 3 * 1800 * 1000));

    await run();

    const titles = sent.map((p) => p.embeds?.[0].title ?? "");
    expect(titles.some((t) => t.includes("停滞"))).toBe(true);
    expect(titles.some((t) => t.includes("停滞のため再起動"))).toBe(true);
  });

  it("does not treat a finished session as alive", async () => {
    await seedRegistry([{ sessionId: "finished-1", state: "done" }]);
    await writeHeartbeat(new Date());

    await run();

    expect((await readRegistry()).filter((a) => a.state === "working")).toHaveLength(1);
  });

  it("warns when more than one session is running under our name", async () => {
    await seedRegistry([{ sessionId: "dup-1" }, { sessionId: "dup-2" }]);
    await writeHeartbeat(new Date());

    await run();

    expect(sent.map((p) => p.embeds?.[0].title ?? "").join()).toContain("二重");
  });

  it("fails loudly when the instruction file is missing", async () => {
    vi.stubEnv("ORCHESTRATOR_INSTRUCTION_PATH", join(workDir, "does-not-exist.md"));

    await expect(run()).rejects.toThrow(/指示ファイルが見つかりません/);
    expect(sent.map((p) => p.embeds?.[0].title ?? "").join()).toContain("起動できませんでした");
  });

  it("does not start anything when the instruction file is missing", async () => {
    vi.stubEnv("ORCHESTRATOR_INSTRUCTION_PATH", join(workDir, "does-not-exist.md"));

    await expect(run()).rejects.toThrow();

    expect(await readRegistry()).toEqual([]);
  });
});

// ─── Prompt rendering ───────────────────────────────────────────────

describe("runOrchestratorSupervisor rendering the prompts", () => {
  beforeEach(async () => {
    // Point the supervisor at prompt sources of our own, and let it decide
    // where the rendered instruction file goes.
    const source = join(workDir, "src-prompts");
    await mkdir(join(source, "child"), { recursive: true });
    await writeFile(
      join(source, "orchestrator.md"),
      "子のルール: {{promptDir}}/child/impl.md\n着手待ちは `Todo`。\n",
      "utf-8",
    );
    await writeFile(join(source, "child", "impl.md"), "cd {{repoDir}}\n", "utf-8");

    vi.stubEnv("ORCHESTRATOR_PROMPT_SOURCE_DIRS", source);
    vi.stubEnv("ORCHESTRATOR_INSTRUCTION_PATH", "");
  });

  it("renders before checking for the instruction file, so a first run works", async () => {
    // Nothing has written the rendered tree yet; if the check ran first the
    // supervisor would refuse to start on every fresh machine.
    await run();

    expect((await readRegistry()).filter((a) => a.name === "ai-orchestrator")).toHaveLength(1);
  });

  it("points the session at the rendered file, not at the source", async () => {
    await run();

    const rendered = join(workDir, "prompts", "orchestrator.md");
    const agent = (await readRegistry()).find((a) => a.name === "ai-orchestrator");
    expect(JSON.stringify(agent)).toContain(rendered);
  });

  it("substitutes the paths the prompts leave open", async () => {
    await run();

    const text = await readFile(join(workDir, "prompts", "orchestrator.md"), "utf-8");
    expect(text).toContain(`${join(workDir, "prompts")}/child/impl.md`);
    expect(text).not.toContain("{{");
  });

  it("applies the configured status names", async () => {
    const workflowPath = join(workDir, "workflow.json");
    await writeFile(workflowPath, JSON.stringify({ queued: "to do" }), "utf-8");
    vi.stubEnv("ORCHESTRATOR_WORKFLOW_PATH", workflowPath);

    await run();

    const text = await readFile(join(workDir, "prompts", "orchestrator.md"), "utf-8");
    expect(text).toContain("`to do`");
    expect(text).not.toContain("`Todo`");
  });
});

// ─── Forced reload ──────────────────────────────────────────────────

describe("runOrchestratorSupervisor --restart", () => {
  it("restarts a healthy session so an edited instruction file takes effect", async () => {
    await seedRegistry([{ sessionId: "healthy-1" }]);
    await writeHeartbeat(new Date());

    await run({ forceRestart: true });

    const orchestrators = (await readRegistry()).filter((a) => a.name === "ai-orchestrator");
    expect(orchestrators).toHaveLength(2);

    const recorded = await recordedSessionId();
    expect(recorded).not.toBe("healthy-1");
  });

  it("says why it restarted", async () => {
    await seedRegistry([{ sessionId: "healthy-1" }]);
    await writeHeartbeat(new Date());

    await run({ forceRestart: true });

    const titles = sent.map((p) => p.embeds?.[0].title ?? "").join();
    expect(titles).toContain("指示ファイル反映");
  });

  it("leaves a healthy session alone without the flag", async () => {
    await seedRegistry([{ sessionId: "healthy-1" }]);
    await writeHeartbeat(new Date());

    await run();

    expect(await readRegistry()).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("starts a session when none is running, flag or not", async () => {
    await run({ forceRestart: true });

    expect((await readRegistry()).filter((a) => a.name === "ai-orchestrator")).toHaveLength(1);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchBackgroundAgent, listAgents, readJobState } from "../agent-runtime.js";
import { listFakeAgentPids, reapFakeAgentsSince } from "./fake-agent-reaper.js";

/**
 * Drives the real launch → observe → collect path against the fake agent, so
 * the plumbing is covered without spending any model usage.
 */

const FAKE_CLAUDE = resolve("test-fixtures/fake-claude.mjs");

/** このファイルが起動する子の名前。回収をこの名前だけに絞るために使う。 */
const AGENT_NAME = "ai-impl-TASK-1226";

let workDir: string;
let agentsBefore: Set<number>;

beforeEach(async () => {
  agentsBefore = listFakeAgentPids(AGENT_NAME);
  workDir = await mkdtemp(join(tmpdir(), "agent-runtime-fake-"));
  process.env.FAKE_CLAUDE_REGISTRY = join(workDir, "registry.json");
  process.env.FAKE_CLAUDE_HOME = workDir;
  process.env.FAKE_CLAUDE_DELAY_MS = "0";
  delete process.env.FAKE_CLAUDE_FINAL_STATE;
});

afterEach(async () => {
  // 子は detached で起動するのでテスト側にハンドルがない。このテストが生んだ
  // pid だけを落とす。アサーションが途中で失敗しても必ず通る場所に置いている。
  reapFakeAgentsSince(agentsBefore, AGENT_NAME);
  delete process.env.FAKE_CLAUDE_REGISTRY;
  delete process.env.FAKE_CLAUDE_HOME;
  delete process.env.FAKE_CLAUDE_DELAY_MS;
  delete process.env.FAKE_CLAUDE_FINAL_STATE;
  await rm(workDir, { recursive: true, force: true });
});

const launchOptions = {
  prompt: "start",
  model: "opus",
  name: AGENT_NAME,
  get cwd() {
    return workDir;
  },
};

describe("launchBackgroundAgent against the fake agent", () => {
  it("returns the daemon-assigned session, which is not something the caller chose", async () => {
    const agent = await launchBackgroundAgent(launchOptions, {
      executable: FAKE_CLAUDE,
      pollIntervalMs: 20,
      pollAttempts: 50,
    });

    expect(agent.name).toBe("ai-impl-TASK-1226");
    expect(agent.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(agent.kind).toBe("background");
  });

  it("makes the launched agent visible in the list", async () => {
    const agent = await launchBackgroundAgent(launchOptions, {
      executable: FAKE_CLAUDE,
      pollIntervalMs: 20,
      pollAttempts: 50,
    });

    const listed = await listAgents(FAKE_CLAUDE);

    expect(listed.map((a) => a.sessionId)).toContain(agent.sessionId);
  });

  it("writes a job state file the collector can read", async () => {
    const agent = await launchBackgroundAgent(launchOptions, {
      executable: FAKE_CLAUDE,
      pollIntervalMs: 20,
      pollAttempts: 50,
    });

    const state = await readJobState(agent.id!, workDir);

    expect(state?.detail).toBe("fake agent ai-impl-TASK-1226");
    expect(state?.tokens).toBe(1234);
    expect(state?.resumeSessionId).toBe(agent.sessionId);
  });

  it("distinguishes a second launch from the first, same name", async () => {
    const first = await launchBackgroundAgent(launchOptions, {
      executable: FAKE_CLAUDE,
      pollIntervalMs: 20,
      pollAttempts: 50,
    });
    const second = await launchBackgroundAgent(launchOptions, {
      executable: FAKE_CLAUDE,
      pollIntervalMs: 20,
      pollAttempts: 50,
    });

    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("reports a failure to register rather than pretending the launch worked", async () => {
    // A registry the fake cannot write to means nothing ever appears in the list.
    //
    // 置き場所は通常ファイルの下にする。ディレクトリのあるべき場所にファイルが
    // あるので、レジストリの作成は即座に EEXIST で失敗して子が落ちる。
    // ここは以前 /proc 配下を指していたが、procfs の mkdir は ENOENT を返すため
    // fs.mkdirSync(dir, { recursive: true }) が「親を作る → 子を作り直す」を
    // 無限に繰り返し、子が CPU を 100% 回したまま孤児として残っていた。
    // 「書けない場所」は、失敗の仕方まで確かめてから選ぶこと。
    const blocker = join(workDir, "not-a-directory");
    await writeFile(blocker, "");
    process.env.FAKE_CLAUDE_REGISTRY = join(blocker, "registry.json");

    await expect(
      launchBackgroundAgent(launchOptions, {
        executable: FAKE_CLAUDE,
        pollIntervalMs: 10,
        pollAttempts: 3,
      }),
    ).rejects.toThrow(/起動を確認できませんでした/);
  });

  it("keeps a slow agent in the working state until it finishes", async () => {
    process.env.FAKE_CLAUDE_DELAY_MS = "60000";

    const agent = await launchBackgroundAgent(launchOptions, {
      executable: FAKE_CLAUDE,
      pollIntervalMs: 20,
      pollAttempts: 50,
    });

    expect(agent.state).toBe("working");

    const registry = JSON.parse(await readFile(process.env.FAKE_CLAUDE_REGISTRY!, "utf-8"));
    const entry = registry.find((a: { sessionId: string }) => a.sessionId === agent.sessionId);
    expect(entry.state).toBe("working");

    process.kill(entry.pid);
  });
});

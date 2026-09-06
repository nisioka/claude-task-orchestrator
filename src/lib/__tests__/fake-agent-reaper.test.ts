import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listFakeAgentPids, reapFakeAgentsSince } from "./fake-agent-reaper.js";

/**
 * The reaper kills by SIGKILL and finds its targets with a process-wide
 * `pgrep`. Two test files launch fake agents and vitest runs files in
 * parallel, so an unscoped reap kills the other file's agent — and if it lands
 * before that agent has written the registry, the other file fails with
 * "起動を確認できませんでした" and nothing points at the cause.
 */

const FAKE_CLAUDE = resolve("test-fixtures/fake-claude.mjs");
const MINE = "ai-impl-REAPER-1";
const THEIRS = "ai-impl-REAPER-2";

let dir: string;
const started: ChildProcess[] = [];

function launch(name: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [FAKE_CLAUDE, "--bg", "--name", name, "--model", "opus", "start"],
    {
      env: {
        ...process.env,
        FAKE_CLAUDE_REGISTRY: join(dir, `${name}.json`),
        FAKE_CLAUDE_HOME: dir,
        FAKE_CLAUDE_DELAY_MS: "60000",
      },
      stdio: "ignore",
    },
  );
  started.push(child);
  return child;
}

/** Waits until the process shows up under its own name, or gives up. */
async function untilListed(name: string): Promise<Set<number>> {
  for (let i = 0; i < 100; i++) {
    const pids = listFakeAgentPids(name);
    if (pids.size > 0) return pids;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${name} が起動しませんでした`);
}

afterEach(() => {
  for (const name of [MINE, THEIRS]) reapFakeAgentsSince(new Set(), name);
  for (const child of started.splice(0)) child.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("listFakeAgentPids", () => {
  it("sees only the agents launched under the given name", async () => {
    dir = mkdtempSync(join(tmpdir(), "reaper-"));
    launch(MINE);
    launch(THEIRS);
    await untilListed(MINE);
    await untilListed(THEIRS);

    const mine = listFakeAgentPids(MINE);
    const theirs = listFakeAgentPids(THEIRS);

    expect(mine.size).toBe(1);
    expect(theirs.size).toBe(1);
    expect([...mine][0]).not.toBe([...theirs][0]);
  });

  it("sees both when no name is given", async () => {
    dir = mkdtempSync(join(tmpdir(), "reaper-"));
    launch(MINE);
    launch(THEIRS);
    await untilListed(MINE);
    await untilListed(THEIRS);

    const all = listFakeAgentPids();

    expect(all.size).toBeGreaterThanOrEqual(2);
  });
});

describe("reapFakeAgentsSince", () => {
  it("leaves another name's agent alone", async () => {
    // The whole point: this is what an unscoped reap used to kill.
    dir = mkdtempSync(join(tmpdir(), "reaper-"));
    launch(MINE);
    launch(THEIRS);
    await untilListed(MINE);
    const survivor = [...(await untilListed(THEIRS))][0];

    reapFakeAgentsSince(new Set(), MINE);

    // 死んだほうは消え、相手は残る
    for (let i = 0; i < 100 && listFakeAgentPids(MINE).size > 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(listFakeAgentPids(MINE).size).toBe(0);
    expect([...listFakeAgentPids(THEIRS)]).toContain(survivor);
  });

  it("spares the agents that were already running", async () => {
    dir = mkdtempSync(join(tmpdir(), "reaper-"));
    launch(MINE);
    const before = await untilListed(MINE);

    reapFakeAgentsSince(before, MINE);

    expect([...listFakeAgentPids(MINE)]).toEqual([...before]);
  });
});

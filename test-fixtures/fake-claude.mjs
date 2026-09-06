#!/usr/bin/env node
/**
 * A stand-in for the `claude` executable.
 *
 * It answers `agents --json --all` from a registry file and, when launched
 * with `--bg`, registers itself, writes a job state file, then finishes after
 * a configured delay. That is enough to drive the whole launch → observe →
 * collect path of the supervisor without spending any model usage, which is
 * what makes the stalled-session test — the failure a liveness check cannot
 * see — worth running automatically.
 *
 * Environment:
 *   FAKE_CLAUDE_REGISTRY    path to the JSON array backing `agents --json`
 *   FAKE_CLAUDE_HOME        home under which .claude/jobs/<short>/state.json is written
 *   FAKE_CLAUDE_DELAY_MS    how long to stay "working" (default 0)
 *   FAKE_CLAUDE_FINAL_STATE terminal state to finish in (default "done")
 *   FAKE_CLAUDE_EXIT_CODE   exit code (default 0)
 *   FAKE_CLAUDE_DETAIL      the `detail` string written to the state file
 *   FAKE_CLAUDE_TOKENS      the `tokens` value written to the state file
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const registryPath = process.env.FAKE_CLAUDE_REGISTRY;

if (!registryPath) {
  console.error("FAKE_CLAUDE_REGISTRY is required");
  process.exit(2);
}

if (argv[0] === "agents") {
  process.stdout.write(JSON.stringify(readRegistry()));
  process.exit(0);
}

// ─── Launch mode ────────────────────────────────────────────────────

if (!argv.includes("--bg")) {
  console.error("fake-claude only supports `agents` and `--bg` launches");
  process.exit(2);
}

const name = flag("--name");
if (!name) {
  console.error("--name is required");
  process.exit(2);
}

const sessionId = randomUUID();
const short = sessionId.slice(0, 8);
const home = process.env.FAKE_CLAUDE_HOME ?? process.env.HOME;
const finalState = process.env.FAKE_CLAUDE_FINAL_STATE ?? "done";
const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? "0");
const exitCode = Number(process.env.FAKE_CLAUDE_EXIT_CODE ?? "0");

// The daemon assigns its own session id under --bg, so the fake does too.
upsertRegistry({
  // Not a field the real registry has. Recorded so a test can assert on what
  // the supervisor actually told the session to read. The prompt is the last
  // argument, after every flag.
  prompt: argv[argv.length - 1],
  pid: process.pid,
  id: short,
  cwd: process.cwd(),
  kind: "background",
  startedAt: Date.now(),
  sessionId,
  name,
  status: "busy",
  state: "working",
});
writeState("working");

if (delayMs > 0) {
  setTimeout(finish, delayMs);
} else {
  finish();
}

function finish() {
  upsertRegistry({ sessionId, state: finalState, status: "idle", pid: null });
  writeState(finalState);
  process.exit(exitCode);
}

// ─── Helpers ────────────────────────────────────────────────────────

function readRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function upsertRegistry(entry) {
  const agents = readRegistry();
  const index = agents.findIndex((a) => a && a.sessionId === entry.sessionId);
  if (index === -1) {
    agents.push(entry);
  } else {
    agents[index] = { ...agents[index], ...entry };
  }
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(agents, null, 2));
}

function writeState(state) {
  if (!home) return;
  const path = join(home, ".claude", "jobs", short, "state.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      state,
      detail: process.env.FAKE_CLAUDE_DETAIL ?? `fake agent ${name}`,
      inFlight: { tasks: state === "working" ? 1 : 0, queued: 0, kinds: [] },
      tokens: Number(process.env.FAKE_CLAUDE_TOKENS ?? "1234"),
      output: state === "working" ? null : { result: `${name} finished` },
      intent: flag("--name"),
      sessionId,
      resumeSessionId: sessionId,
      daemonShort: short,
      linkScanPath: join(home, ".claude", "projects", "fake", `${sessionId}.jsonl`),
      cwd: process.cwd(),
    }),
  );
}

function flag(flagName) {
  const index = argv.indexOf(flagName);
  return index === -1 ? null : argv[index + 1];
}

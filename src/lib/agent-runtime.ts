import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildExecEnv } from "./exec-env.js";

const execFileAsync = promisify(execFile);

/**
 * The one module that touches the background-agent machinery.
 *
 * `claude --bg`, `claude agents --json` and `~/.claude/jobs/<id>/state.json`
 * are not public interfaces. Confining them here means a format change costs
 * one file. Every parser below is a pure function that degrades instead of
 * throwing: losing a single tick is acceptable, taking the orchestrator down
 * because one line of JSON changed shape is not.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface AgentSummary {
  /** Interactive sessions only; background entries report no pid. */
  pid: number | null;
  /** Short daemon id. Background sessions only — it keys the job state file. */
  id: string | null;
  cwd: string;
  kind: string;
  startedAt: number | null;
  sessionId: string;
  name: string;
  /** Interactive sessions only: "busy" | "idle". */
  status: string | null;
  /** Background sessions only: "working" | "done" | "failed" | "stopped" | … */
  state: string | null;
}

export interface AgentJobState {
  state: string | null;
  /** What the agent itself says it is doing. Shown to the human verbatim. */
  detail: string | null;
  inFlightTasks: number | null;
  tokens: number | null;
  result: string | null;
  intent: string | null;
  resumeSessionId: string | null;
  transcriptPath: string | null;
}

export type RunClass = "running" | "finished" | "missing";

export interface LaunchOptions {
  /** Short bootstrap text only. Long instructions go through a file. */
  prompt: string;
  cwd: string;
  model: string;
  effort?: string;
  /**
   * Required, and the only handle we get on the new session.
   *
   * Measured against claude 2.1.223: under `--bg` the daemon ignores a
   * caller-supplied `--session-id` and mints its own, so the session id cannot
   * be chosen up front — it has to be read back from the agent list. The name
   * is what survives, which is why the naming convention carries the identity.
   */
  name: string;
  /** Enables SendUserMessage so the agent can reach the human first. */
  brief?: boolean;
  permissionMode?: string;
}

export interface HeartbeatRecord {
  at: string;
  dispatched: string[];
  handedToHuman: string[];
  note: string | null;
}

/** States after which the daemon will not do more work on a session. */
export const TERMINAL_AGENT_STATES = ["done", "failed", "stopped"] as const;

/** Default executable. Overridable so tests can drive a fake agent. */
export const DEFAULT_CLAUDE_EXECUTABLE = "claude";

// ─── Pure parsers ───────────────────────────────────────────────────

export function parseAgentList(stdout: string): AgentSummary[] {
  const parsed = safeJsonParse(stdout);
  if (!Array.isArray(parsed)) return [];

  const agents: AgentSummary[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const sessionId = asString(entry.sessionId);
    if (!sessionId) continue;

    agents.push({
      pid: asNumber(entry.pid),
      id: asString(entry.id),
      cwd: asString(entry.cwd) ?? "",
      kind: asString(entry.kind) ?? "",
      startedAt: asNumber(entry.startedAt),
      sessionId,
      name: asString(entry.name) ?? "",
      status: asString(entry.status),
      state: asString(entry.state),
    });
  }
  return agents;
}

export function parseJobState(raw: string): AgentJobState | null {
  const parsed = safeJsonParse(raw);
  if (!isRecord(parsed)) return null;

  const inFlight = isRecord(parsed.inFlight) ? parsed.inFlight : null;
  const output = isRecord(parsed.output) ? parsed.output : null;

  return {
    state: asString(parsed.state),
    detail: asString(parsed.detail),
    inFlightTasks: inFlight ? asNumber(inFlight.tasks) : null,
    tokens: asNumber(parsed.tokens),
    result: output ? asString(output.result) : null,
    intent: asString(parsed.intent),
    resumeSessionId: asString(parsed.resumeSessionId),
    transcriptPath: asString(parsed.linkScanPath),
  };
}

/**
 * Classify a dispatched run. Priority: the daemon's terminal state wins,
 * then presence in the agent list, and anything else has disappeared.
 */
export function classifyRun(input: { listed: boolean; jobState: string | null }): RunClass {
  if (input.jobState !== null && isTerminalState(input.jobState)) return "finished";
  return input.listed ? "running" : "missing";
}

export function isTerminalState(state: string): boolean {
  return (TERMINAL_AGENT_STATES as readonly string[]).includes(state);
}

export function buildLaunchArgs(options: LaunchOptions): string[] {
  if (!options.name) {
    throw new Error("エージェント名は必須です（命名規約がクラッシュ復旧照合の権威になるため）");
  }

  // `-p` is deliberately absent: combined with `--bg` the process exits 0
  // without ever starting a session.
  // `--session-id` is deliberately absent too: the daemon overrides it under
  // `--bg`, so passing one would only suggest a guarantee we do not have.
  const args = ["--bg", "--name", options.name, "--model", options.model];
  if (options.effort) args.push("--effort", options.effort);
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.brief) args.push("--brief");
  args.push(options.prompt);

  return args;
}

export function jobStatePath(shortId: string, home: string = homedir()): string {
  return join(home, ".claude", "jobs", shortId, "state.json");
}

/**
 * Interpret the last line of the heartbeat log. Only the tail is read, so the
 * cost stays constant however long the file grows.
 */
export function parseHeartbeatTail(raw: string): HeartbeatRecord | null {
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const last = lines[lines.length - 1];
  if (!last) return null;

  const parsed = safeJsonParse(last);
  if (!isRecord(parsed)) return null;

  const at = asString(parsed.at);
  if (!at) return null;

  return {
    at,
    dispatched: asStringArray(parsed.dispatched),
    handedToHuman: asStringArray(parsed.handedToHuman),
    note: asString(parsed.note),
  };
}

/**
 * A missing or old heartbeat means the loop stopped turning.
 *
 * The threshold is twice the maximum interval so a single skipped tick does
 * not fire, but two consecutive silences do. No record at all counts as
 * stalled; the caller applies the post-launch grace period.
 */
export function isHeartbeatStale(
  last: HeartbeatRecord | null,
  now: Date,
  maxIntervalSeconds: number,
): boolean {
  if (!last) return true;

  const at = new Date(last.at).getTime();
  if (Number.isNaN(at)) return true;

  const ageSeconds = (now.getTime() - at) / 1000;
  return ageSeconds > maxIntervalSeconds * 2;
}

// ─── IO ─────────────────────────────────────────────────────────────

export async function listAgents(
  executable: string = DEFAULT_CLAUDE_EXECUTABLE,
): Promise<AgentSummary[]> {
  try {
    const { stdout } = await execFileAsync(executable, ["agents", "--json", "--all"], {
      env: buildExecEnv(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseAgentList(stdout);
  } catch {
    // A failing daemon must not take the caller down with it.
    return [];
  }
}

export async function readJobState(
  shortId: string,
  home: string = homedir(),
): Promise<AgentJobState | null> {
  try {
    return parseJobState(await readFile(jobStatePath(shortId, home), "utf-8"));
  } catch {
    return null;
  }
}

export async function readLastHeartbeat(path: string): Promise<HeartbeatRecord | null> {
  try {
    return parseHeartbeatTail(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

// ─── Termination ────────────────────────────────────────────────────

/**
 * Stopping a background session means asking the daemon, not killing a pid.
 *
 * Measured against claude 2.1.223: sending SIGTERM to the pid shown in the
 * agent list makes the daemon respawn the worker under the same name and
 * session id a few seconds later — which, for a stalled orchestrator, would
 * bring the degraded conversation straight back. The daemon's control socket
 * accepts newline-delimited JSON requests and answers `{ok, op, …}`.
 */
export function buildKillRequest(shortId: string): Record<string, unknown> {
  return { proto: 1, op: "kill", short: shortId, evict: true };
}

/** The daemon's socket directory. Overridable so tests never reach a real daemon. */
export function controlSocketRoot(uid: number = process.getuid?.() ?? 0): string {
  return process.env.ORCHESTRATOR_DAEMON_SOCK_DIR || join("/tmp", `cc-daemon-${uid}`);
}

/** Candidate control sockets, newest first. The daemon may have rotated dirs. */
export async function findControlSockets(uid: number = process.getuid?.() ?? 0): Promise<string[]> {
  const root = controlSocketRoot(uid);
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const entries = await readdir(root, { withFileTypes: true });
    const found: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, "control.sock");
      const info = await stat(path).catch(() => null);
      if (info) found.push({ path, mtimeMs: info.mtimeMs });
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
  } catch {
    return [];
  }
}

/** Send one request over a control socket. Returns `null` on any failure. */
export async function sendControlRequest(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<Record<string, unknown> | null> {
  const { connect } = await import("node:net");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    const socket = connect(socketPath);
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      const parsed = safeJsonParse(chunk.toString("utf-8").split("\n")[0]);
      finish(isRecord(parsed) ? parsed : null);
    });
  });
}

/**
 * Ask the daemon to stop and evict a background session.
 *
 * Reports whether the request was *accepted*, which is not the same as the
 * session having exited — see `terminateSessionAndWait` for that. A caller that
 * needs the session gone must confirm it disappeared.
 */
export async function terminateSession(shortId: string): Promise<boolean> {
  const sockets = await findControlSockets();
  // No daemon to ask is not "nothing left to stop" — it is no answer at all.
  if (sockets.length === 0) return false;

  let everyDaemonDisclaimed = true;
  for (const socketPath of sockets) {
    const response = await sendControlRequest(socketPath, buildKillRequest(shortId));
    if (response?.ok === true) return true;
    // ENOJOB means *this* daemon has no such job. The loop exists because there
    // may be several, so it settles nothing until every one of them has said
    // it — answering early would report a kill against a daemon never asked.
    if (response?.code !== "ENOJOB") everyDaemonDisclaimed = false;
  }
  return everyDaemonDisclaimed;
}

/**
 * Stop a background session and wait for it to actually leave the agent list.
 *
 * The daemon acknowledges a kill by accepting it, not by having finished it,
 * and the resident orchestrator is busy mid-turn most of the time. Trusting the
 * acknowledgement is how two sessions end up running: the supervisor believes
 * the old one is gone, launches its replacement, and never looks again.
 *
 * Returns whether the session is gone. Not being gone is a normal answer here —
 * the caller reports it, and the next tick reconciles what is still standing.
 */
export async function terminateSessionAndWait(
  shortId: string,
  sessionId: string,
  options: { executable?: string; attempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 5;
  const intervalMs = options.intervalMs ?? 1000;

  await terminateSession(shortId);

  // Observation is the authority, so look before waiting: a daemon that evicts
  // as it answers is already done, and sleeping first would charge every caller
  // for a session that is gone.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resume) => setTimeout(resume, intervalMs));
    const stillLive = (await listAgents(options.executable)).some(
      (a) => a.sessionId === sessionId && (a.state === null || !isTerminalState(a.state)),
    );
    if (!stillLive) return true;
  }
  return false;
}

export interface LaunchIoOptions {
  pollAttempts?: number;
  pollIntervalMs?: number;
  executable?: string;
}

/**
 * Pick the session a launch produced: an entry under the requested name whose
 * session id was not already present before the launch.
 *
 * Comparing against the pre-launch snapshot matters because a finished run of
 * the same issue keeps its entry in `--all` output; without the diff we would
 * happily "confirm" a launch by pointing at last week's corpse.
 */
export function pickLaunchedAgent(
  before: AgentSummary[],
  after: AgentSummary[],
  name: string,
): AgentSummary | null {
  const known = new Set(before.filter((a) => a.name === name).map((a) => a.sessionId));
  const candidates = after.filter((a) => a.name === name && !known.has(a.sessionId));
  if (candidates.length === 0) return null;

  // Newest first, so a repeated name still resolves to this launch.
  return candidates.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
}

/**
 * Launch a background agent and confirm it registered.
 *
 * `claude --bg` returns silently, so exit code 0 is not evidence that a
 * session exists. The launch is only complete once a new entry under the
 * requested name appears in the agent list; its daemon-assigned session id is
 * returned to the caller.
 */
export async function launchBackgroundAgent(
  options: LaunchOptions,
  io: LaunchIoOptions = {},
): Promise<AgentSummary> {
  const executable = io.executable ?? DEFAULT_CLAUDE_EXECUTABLE;
  const pollAttempts = io.pollAttempts ?? 30;
  const pollIntervalMs = io.pollIntervalMs ?? 1000;

  const args = buildLaunchArgs(options);
  const before = await listAgents(executable);

  await spawnDetached(executable, args, options.cwd);

  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    const agent = pickLaunchedAgent(before, await listAgents(executable), options.name);
    if (agent) return agent;
    await delay(pollIntervalMs);
  }

  throw new Error(
    `エージェントの起動を確認できませんでした: name=${options.name}\n` +
      `claude --bg は無言で返るため、一覧に現れないことが唯一の失敗の証拠です。`,
  );
}

function spawnDetached(executable: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: buildExecEnv(),
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Value coercion ─────────────────────────────────────────────────

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

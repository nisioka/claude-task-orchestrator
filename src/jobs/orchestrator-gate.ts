import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadCoreConfig } from "../lib/core-config.js";
import { loadOrchestratorConfig, parseAgentName } from "../lib/orchestrator-config.js";
import { isRunningAgent, listDaemonJobs, tryListAgents } from "../lib/agent-runtime.js";
import { createTaskProvider } from "../lib/tasks/factory.js";
import { loadWorkflow, offTheQueueStatuses } from "../lib/tasks/workflow.js";
import { classifySchedules } from "./orchestrator-status.js";
import {
  buildGateHeartbeat,
  decideGate,
  EMPTY_GATE_STATE,
  findLastPatrol,
  formatDecision,
  parseGateState,
  type GateSnapshot,
  type GateState,
} from "../lib/patrol-gate.js";

const execFileAsync = promisify(execFile);

/** Search results stop here; a list that reaches it may be missing the PR that changed. */
const PULL_REQUEST_LIMIT = 200;

/**
 * Run at the end of the resident session's wait, before it wakes to patrol.
 *
 * Prints exactly one line on stdout, `巡回ゲート: skip …` or
 * `巡回ゲート: patrol …`. On skip the gate has already written the heartbeat,
 * so the session only re-arms its wait. Everything else — including this job
 * failing — means patrol, which is why errors are turned into a patrol verdict
 * here rather than thrown.
 */
export async function runOrchestratorGate(): Promise<void> {
  const config = loadOrchestratorConfig();
  const statePath = join(config.stateDir, "patrol-gate.json");
  const now = new Date();

  let snapshot: GateSnapshot;
  try {
    snapshot = await takeSnapshot();
  } catch (error) {
    console.log(`巡回ゲート: patrol — 状態を読めなかった (${error instanceof Error ? error.message : String(error)})`);
    return;
  }

  const [state, heartbeatRaw] = await Promise.all([readState(statePath), readText(config.heartbeatPath)]);
  const lastPatrol = findLastPatrol(heartbeatRaw);
  const decision = decideGate({
    snapshot,
    state,
    lastPatrol,
    now,
    fullPatrolSeconds: config.fullPatrolSeconds,
  });

  try {
    await writeState(statePath, decision.state);
    if (decision.verdict === "skip") {
      await mkdir(dirname(config.heartbeatPath), { recursive: true });
      await appendFile(config.heartbeatPath, `${buildGateHeartbeat(now)}\n`);
    }
  } catch (error) {
    // Without the heartbeat the supervisor would call a healthy session stalled.
    console.log(`巡回ゲート: patrol — 記録を書けなかった (${error instanceof Error ? error.message : String(error)})`);
    return;
  }

  console.log(formatDecision(decision, lastPatrol, now));
}

async function takeSnapshot(): Promise<GateSnapshot> {
  const appConfig = loadCoreConfig();
  const config = loadOrchestratorConfig();
  const workflow = loadWorkflow();
  const tasks = createTaskProvider(appConfig);
  const now = new Date();

  const [agents, heldByDaemon, aiIssues, openPullRequests] = await Promise.all([
    tryListAgents(config.claudeExecutable),
    listDaemonJobs(),
    tasks.list({ assignee: "ai", excludeStatuses: offTheQueueStatuses(workflow), withDescription: true }),
    listOpenPullRequests(),
  ]);
  if (agents === null) throw new Error("エージェント一覧を取得できない");

  const aiIssueIds = new Set(aiIssues.map((issue) => issue.id));
  const running = agents.flatMap((agent) => {
    const parsed = parseAgentName(agent.name);
    if (!parsed || parsed.role === "orchestrator" || !isRunningAgent(agent, heldByDaemon)) return [];
    return [{ agent, issueId: parsed.issueIdentifier }];
  });
  const runningChildren = running.map(({ agent }) => `${agent.name}|${agent.state ?? "?"}`);
  const activeChildren = running
    .filter(({ agent, issueId }) => agent.state !== "blocked" && aiIssueIds.has(issueId))
    .map(({ agent }) => agent.name);

  return {
    aiIssues: aiIssues.map((issue) => `${issue.id}|${issue.status}|${issue.updatedAt}`),
    scheduledPending: classifySchedules(aiIssues, now, workflow).pending.map(({ issue }) => issue.id),
    openPullRequests,
    runningChildren,
    activeChildren,
  };
}

/** The human's open pull requests across every repository, or `null` when `gh` cannot answer. */
async function listOpenPullRequests(): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "search", "prs",
        "--author", "@me",
        "--state", "open",
        "--limit", String(PULL_REQUEST_LIMIT),
        "--json", "repository,number",
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const rows = JSON.parse(stdout) as { repository?: { nameWithOwner?: string }; number?: number }[];
    if (rows.length >= PULL_REQUEST_LIMIT) return null;
    return rows.map((row) => `${row.repository?.nameWithOwner ?? "?"}#${row.number ?? "?"}`);
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function readState(path: string): Promise<GateState> {
  const raw = await readText(path);
  return raw === "" ? EMPTY_GATE_STATE : parseGateState(raw);
}

async function writeState(path: string, state: GateState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

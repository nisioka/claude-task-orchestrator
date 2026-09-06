import { loadCoreConfig } from "../lib/core-config.js";
import { loadOrchestratorConfig, ORCHESTRATOR_SESSION_NAME, parseAgentName } from "../lib/orchestrator-config.js";
import {
  classifyRun,
  isHeartbeatStale,
  isTerminalState,
  listAgents,
  readJobState,
  readLastHeartbeat,
  type AgentJobState,
  type AgentSummary,
  type HeartbeatRecord,
} from "../lib/agent-runtime.js";
import { createTaskProvider } from "../lib/tasks/factory.js";
import { fetchUsage, getAccessToken, type UsageResponse } from "../lib/claude-usage.js";
import {
  assessContext,
  formatContext,
  readContextSample,
  type ContextSample,
} from "../lib/session-context.js";
import { parseStartAfter } from "../lib/orchestrator-schedule.js";
import type { Task } from "../lib/tasks/types.js";
import {
  humanBallStatuses,
  humanDutyByStatus,
  loadWorkflow,
  offTheQueueStatuses,
  type WorkflowStatuses,
} from "../lib/tasks/workflow.js";

/**
 * A read-only snapshot of the whole system, printed to stdout.
 *
 * The orchestrator answers "how are things going?" in conversation, but that
 * assumes the session is alive and responsive. This job answers the same
 * question from outside — which is precisely what is needed when the
 * orchestrator is the thing that broke.
 */

// ─── Ownership vocabulary ───────────────────────────────────────────

/*
 * The status names themselves live in `lib/tasks/workflow.ts`, loaded from
 * configuration. What stays here is only the shape of the two queues.
 *
 * There is deliberately no AI-side counterpart to the human's ball. The AI's
 * ball is decided by assignee alone; an allowlist of "statuses the AI may hold"
 * would hide anything the human handed over without also moving the status.
 * `humanDutyByStatus` survives because it only labels a queue for display — it
 * gates nothing.
 */

const OTHER_DUTY = "その他";

// ─── Formatting ─────────────────────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A duration in Japanese, coarse enough to read at a glance. */
function coarseDuration(ms: number): string {
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}分`;

  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours}時間` : `${hours}時間${minutes}分`;
  }

  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  return hours === 0 ? `${days}日` : `${days}日${hours}時間`;
}

/** Elapsed time in Japanese, coarse enough to read at a glance. */
export function formatAge(fromIso: string, now: Date): string {
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) return "不明";

  const elapsed = now.getTime() - from;
  if (elapsed < MINUTE_MS) return "1分未満";
  return coarseDuration(elapsed);
}

/** Time remaining until a future instant, in Japanese. */
export function formatUntil(to: Date, now: Date): string {
  const remaining = to.getTime() - now.getTime();
  if (Number.isNaN(remaining)) return "不明";
  if (remaining <= 0) return "まもなく";
  if (remaining < MINUTE_MS) return "1分未満";
  return coarseDuration(remaining);
}

function issueLine(issue: Task, now: Date): string {
  return `    ${issue.id}  ${issue.title}  (${formatAge(issue.updatedAt, now)})`;
}

function byOldestFirst(a: Task, b: Task): number {
  return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
}

/**
 * The human's queue, grouped by duty and ordered longest-wait-first — the
 * ordering that matches what is being optimised, which is the human's waiting
 * time rather than the AI's throughput.
 */
export function renderHumanQueue(
  issues: Task[],
  now: Date,
  workflow: WorkflowStatuses,
): string[] {
  if (issues.length === 0) return ["  なし"];

  const duties = humanDutyByStatus(workflow);
  return renderGrouped(issues, (issue) => duties[issue.status] ?? OTHER_DUTY, now);
}

/** The AI's own queue, grouped by status. */
export function renderAiQueue(issues: Task[], now: Date): string[] {
  if (issues.length === 0) return ["  なし"];

  return renderGrouped(issues, (issue) => issue.status, now);
}

function renderGrouped(
  issues: Task[],
  groupOf: (issue: Task) => string,
  now: Date,
): string[] {
  const groups = new Map<string, Task[]>();
  for (const issue of issues) {
    const key = groupOf(issue);
    const bucket = groups.get(key);
    if (bucket) bucket.push(issue);
    else groups.set(key, [issue]);
  }

  const lines: string[] = [];
  for (const [group, members] of groups) {
    lines.push(`  ${group} (${members.length}件)`);
    for (const issue of [...members].sort(byOldestFirst)) {
      lines.push(issueLine(issue, now));
    }
  }
  return lines;
}

// ─── Scheduled dispatch (start-after) ───────────────────────────────

export interface ScheduledIssue {
  issue: Task;
  at: Date;
}

export interface InvalidSchedule {
  issue: Task;
  raw: string;
}

export interface ScheduleView {
  /** Todo issues whose start-after is still in the future. */
  pending: ScheduledIssue[];
  /** Issues whose start-after value could not be parsed. */
  invalid: InvalidSchedule[];
}

/**
 * Split the AI's Todo issues by their start-after marker.
 *
 * A start-after in the past is not surfaced: the issue is an ordinary dispatch
 * candidate again and already shows up under "AIのボール". Only what the human
 * cannot otherwise see is reported here — work deferred to a future time, and
 * markers the orchestrator will bounce back for being unparseable.
 */
export function classifySchedules(
  issues: Task[],
  now: Date,
  workflow: WorkflowStatuses,
): ScheduleView {
  const pending: ScheduledIssue[] = [];
  const invalid: InvalidSchedule[] = [];

  for (const issue of issues) {
    if (issue.status !== workflow.queued) continue;
    const schedule = parseStartAfter(issue.description ?? "");
    if (schedule.kind === "scheduled" && schedule.at.getTime() > now.getTime()) {
      pending.push({ issue, at: schedule.at });
    } else if (schedule.kind === "invalid") {
      invalid.push({ issue, raw: schedule.raw });
    }
  }

  return { pending, invalid };
}

/** Upcoming scheduled dispatches, plus a warning line per unparseable marker. */
export function renderScheduled(view: ScheduleView, now: Date): string[] {
  if (view.pending.length === 0 && view.invalid.length === 0) return ["  なし"];

  const lines: string[] = [];
  for (const { issue, at } of [...view.pending].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    lines.push(`  ${issue.id}  ${issue.title}`);
    lines.push(`    開始予定: ${formatInstant(at.toISOString())} (あと${formatUntil(at, now)})`);
  }
  for (const { issue, raw } of view.invalid) {
    lines.push(`  ⚠ ${issue.id}  ${issue.title}`);
    lines.push(`    start-after の値が不正: "${raw}" — 人間へ差し戻してください`);
  }
  return lines;
}

export function renderAgent(
  agent: AgentSummary,
  state: AgentJobState | null,
  now: Date,
  context: ContextSample | null = null,
  contextLimitTokens: number | null = null,
): string[] {
  const parsed = parseAgentName(agent.name);
  const subject = parsed && "issueIdentifier" in parsed ? parsed.issueIdentifier : agent.name;
  const runningFor = agent.startedAt === null
    ? "不明"
    : formatAge(new Date(agent.startedAt).toISOString(), now);

  const lines = [
    `  ${agent.name}  [${state?.state ?? agent.state ?? "不明"}]  対象: ${subject}`,
    `    現況: ${state?.detail ?? "不明"}`,
    // The job state's own `tokens` is deliberately not shown: measured against
    // live sessions it reports roughly a third of the context that is actually
    // re-read each turn, so quoting it invites the wrong decision.
    `    経過: ${runningFor}  文脈: ${formatContext(context, contextLimitTokens)}`,
    `    作業場所: ${agent.cwd || "不明"}`,
    // `--resume` is refused while a --bg session is live; the TUI is the only
    // way in. Session id is kept for after it ends.
    `    参加: claude agents で選択  (終了後は claude --resume ${
      state?.resumeSessionId ?? agent.sessionId
    })`,
  ];

  if (assessContext(context, contextLimitTokens) === "over") {
    lines.push(
      "    ⚠ 文脈が上限を超えました。引き継ぎを書かせて終了させ、引き継ぎファイルで入れ替えてください",
    );
  }

  return lines;
}

export function renderOrchestrator(
  agent: AgentSummary | null,
  heartbeat: HeartbeatRecord | null,
  now: Date,
  maxIntervalSeconds = 1800,
  context: ContextSample | null = null,
  contextLimitTokens: number | null = null,
): string[] {
  if (!agent) {
    return [
      "  停止しています。次回の orchestrator-supervisor の実行で起動されます。",
      heartbeat ? `  最終ハートビート: ${formatAge(heartbeat.at, now)}前` : "  ハートビートなし",
    ];
  }

  const lines = [
    `  稼働中  [${agent.state ?? "不明"}]  経過: ${
      agent.startedAt === null ? "不明" : formatAge(new Date(agent.startedAt).toISOString(), now)
    }  文脈: ${formatContext(context, contextLimitTokens)}`,
    `  参加: claude agents で選択  (終了後は claude --resume ${agent.sessionId})`,
  ];

  if (assessContext(context, contextLimitTokens) === "over") {
    // Says it before the supervisor acts, so a restart in the middle of a
    // conversation does not look like a crash.
    lines.push("  ♻ 文脈が上限に達しました。次回の orchestrator-supervisor で入れ替わります");
  }

  if (!heartbeat) {
    lines.push("  ハートビートなし（起動直後か、まだ1巡回が終わっていない）");
    return lines;
  }

  lines.push(`  最終ハートビート: ${formatAge(heartbeat.at, now)}前  ${heartbeat.note ?? ""}`.trimEnd());
  if (isHeartbeatStale(heartbeat, now, maxIntervalSeconds)) {
    // Present but not progressing — the failure a liveness check cannot see.
    lines.push("  ⚠ 巡回が止まっている可能性があります");
  }
  return lines;
}

/**
 * Usage is reported, never acted on.
 *
 * On a subscription the binding constraint is quota rather than money, and the
 * per-model consumption ratio is not published. Keeping both windows on screen
 * is what makes "can this keep running?" a question with a daily answer.
 */
export function renderUsage(usage: UsageResponse | null): string[] {
  if (!usage) return ["  使用量を取得できませんでした"];

  return [
    `  5時間枠: ${usage.five_hour.utilization}%  (リセット: ${formatInstant(usage.five_hour.resets_at)})`,
    `  7日枠:   ${usage.seven_day.utilization}%  (リセット: ${formatInstant(usage.seven_day.resets_at)})`,
  ];
}

function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "不明";
  return date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

// ─── Job ────────────────────────────────────────────────────────────

export async function runOrchestratorStatus(): Promise<void> {
  const appConfig = loadCoreConfig();
  const config = loadOrchestratorConfig();
  const workflow = loadWorkflow();
  const now = new Date();

  const tasks = createTaskProvider(appConfig);

  const [agents, heartbeat, aiIssues, humanIssues, usage] = await Promise.all([
    listAgents(config.claudeExecutable),
    readLastHeartbeat(config.heartbeatPath),
    // AIのボールは担当者だけで決まる。ステータスでは絞らず、Backlog と終了系だけを型で外す
    tasks.list({ assignee: "ai", excludeStatuses: offTheQueueStatuses(workflow), withDescription: true }),
    // 当事者は2人しかいないので、「AI以外に割り当て済み」は「人間に割り当て済み」と同じ
    tasks.list({ assignee: "human", statuses: humanBallStatuses(workflow) }),
    readUsage(),
  ]);

  const orchestrator =
    agents.find(
      (a) => a.name === ORCHESTRATOR_SESSION_NAME && (a.state === null || !isTerminalState(a.state)),
    ) ?? null;

  const children = agents.filter((a) => {
    const parsed = parseAgentName(a.name);
    if (!parsed || parsed.role === "orchestrator") return false;
    // Listed by definition here, so this separates running from finished.
    return classifyRun({ listed: true, jobState: a.state }) === "running";
  });

  const childStates = await Promise.all(
    children.map((child) => (child.id ? readJobState(child.id) : Promise.resolve(null))),
  );
  const childContexts = await Promise.all(childStates.map(readContextOf));

  const orchestratorState = orchestrator?.id ? await readJobState(orchestrator.id) : null;
  const orchestratorContext = await readContextOf(orchestratorState);

  const schedule = classifySchedules(aiIssues, now, workflow);

  const lines = [
    `AIタスクオーケストレータ 状態  (${now.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })})`,
    "",
    "■ 常駐オーケストレータ",
    ...renderOrchestrator(
      orchestrator,
      heartbeat,
      now,
      config.maxIntervalSeconds,
      orchestratorContext,
      config.maxSessionContextTokens,
    ),
    "",
    `■ 実行中の子エージェント (${children.length}件)`,
    ...(children.length === 0
      ? ["  なし"]
      : children.flatMap((child, index) =>
          renderAgent(
            child,
            childStates[index],
            now,
            childContexts[index],
            config.childContextLimitTokens,
          ),
        )),
    "",
    `■ AIのボール (${aiIssues.length}件)`,
    ...renderAiQueue(aiIssues, now),
    "",
    `■ 予約投入 (${schedule.pending.length}件${
      schedule.invalid.length > 0 ? ` / 不正 ${schedule.invalid.length}件` : ""
    })`,
    ...renderScheduled(schedule, now),
    "",
    `■ あなたのボール (${humanIssues.length}件)`,
    ...renderHumanQueue(humanIssues, now, workflow),
    "",
    "■ 使用量",
    ...renderUsage(usage),
  ];

  console.log(lines.join("\n"));
}

/** The transcript is named by the job state, so an absent state means no measurement. */
async function readContextOf(state: AgentJobState | null): Promise<ContextSample | null> {
  return state?.transcriptPath ? readContextSample(state.transcriptPath) : null;
}

async function readUsage(): Promise<UsageResponse | null> {
  try {
    return await fetchUsage(await getAccessToken());
  } catch {
    // Reporting only — a usage lookup failure must not hide the rest.
    return null;
  }
}

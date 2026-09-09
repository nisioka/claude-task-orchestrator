import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { loadCoreConfig } from "../lib/core-config.js";
import {
  loadOrchestratorConfig,
  ORCHESTRATOR_SESSION_NAME,
  type OrchestratorConfig,
} from "../lib/orchestrator-config.js";
import {
  isHeartbeatStale,
  isTerminalState,
  launchBackgroundAgent,
  listAgents,
  readJobState,
  readLastHeartbeat,
  terminateSessionAndWait,
  type AgentSummary,
  type HeartbeatRecord,
} from "../lib/agent-runtime.js";
import { readContextSample } from "../lib/session-context.js";
import { renderPrompts } from "../lib/prompt-render.js";
import { loadWorkflow, promptNames } from "../lib/tasks/workflow.js";
import { sendNotifications } from "../lib/notification.js";
import { truncateFieldValue } from "../lib/types.js";
import type { DiscordPayload } from "../lib/types.js";

const execFileAsync = promisify(execFile);

/**
 * Keeps the resident orchestrator session alive. This is the only cron-driven
 * job in the system: it checks health and starts a session, and does nothing
 * else. Patrol, judgement and dispatch belong to the session itself — moving
 * any of it here would turn every tick into a cold start, which is the
 * expensive case.
 */

// ─── Health ─────────────────────────────────────────────────────────

export type HealthVerdict =
  | { kind: "healthy" }
  | { kind: "absent" }
  | { kind: "stalled"; lastHeartbeatAt: string | null };

export interface HealthInput {
  sessionListed: boolean;
  jobState: string | null;
  lastHeartbeat: HeartbeatRecord | null;
  startedAt: number | null;
  now: Date;
  maxIntervalSeconds: number;
  graceSeconds: number;
}

/**
 * Judge the session from the outside.
 *
 * The failure specific to a resident design is not the process dying, it is
 * the loop quietly stopping while the process stays up. A liveness check
 * reports such a session as healthy forever, and the human reads the silence
 * as "nothing to do". So presence alone is not enough: the heartbeat has to be
 * fresh too.
 */
export function assessHealth(input: HealthInput): HealthVerdict {
  if (!input.sessionListed) return { kind: "absent" };
  if (input.jobState !== null && isTerminalState(input.jobState)) return { kind: "absent" };

  // The grace period exists for a session that has not reported yet, so it only
  // applies while every heartbeat on file predates this session's start. A
  // heartbeat written *after* the start means this session has patrolled, and
  // its silence since then is the real signal.
  if (input.startedAt !== null && heartbeatPredatesStart(input)) {
    const ageSeconds = (input.now.getTime() - input.startedAt) / 1000;
    if (ageSeconds < input.graceSeconds) return { kind: "healthy" };
  }

  if (!isHeartbeatStale(input.lastHeartbeat, input.now, input.maxIntervalSeconds)) {
    return { kind: "healthy" };
  }

  return { kind: "stalled", lastHeartbeatAt: input.lastHeartbeat?.at ?? null };
}

// ─── Recycling ──────────────────────────────────────────────────────

export interface RecycleInput {
  /** `null` when the transcript could not be measured. */
  contextTokens: number | null;
  ageSeconds: number | null;
  maxContextTokens: number | null;
  maxAgeSeconds: number | null;
}

export type RecycleVerdict =
  | { kind: "keep" }
  | { kind: "recycle"; cause: "context"; contextTokens: number }
  | { kind: "recycle"; cause: "age"; ageSeconds: number };

/**
 * Decide whether a *healthy* session has outlived its economics.
 *
 * This is separate from `assessHealth` on purpose. Health asks whether the
 * loop is still turning; this asks what the next turn will cost. A session can
 * be perfectly healthy and still be the most expensive thing running, because
 * context only grows and every patrol re-reads all of it.
 *
 * Context is checked first because it is the quantity that actually drives the
 * bill. Age is the fallback for when context cannot be measured — it is a
 * proxy, and a poor one: a quiet day and a busy one reach very different sizes
 * in the same 24 hours.
 */
export function assessRecycle(input: RecycleInput): RecycleVerdict {
  if (
    input.maxContextTokens !== null &&
    input.contextTokens !== null &&
    input.contextTokens >= input.maxContextTokens
  ) {
    return { kind: "recycle", cause: "context", contextTokens: input.contextTokens };
  }

  if (
    input.maxAgeSeconds !== null &&
    input.ageSeconds !== null &&
    input.ageSeconds >= input.maxAgeSeconds
  ) {
    return { kind: "recycle", cause: "age", ageSeconds: input.ageSeconds };
  }

  return { kind: "keep" };
}

function heartbeatPredatesStart(input: HealthInput): boolean {
  if (!input.lastHeartbeat) return true;
  const at = new Date(input.lastHeartbeat.at).getTime();
  if (Number.isNaN(at)) return true;
  return at < (input.startedAt ?? 0);
}

// ─── Residency prerequisites (requirement 5.12) ─────────────────────

export interface PrerequisiteReport {
  satisfied: boolean;
  problems: string[];
}

/**
 * Report only what the human can actually act on.
 *
 * Claude Code 2.1.223 disables daemon service install outright ("the daemon
 * runs on demand and exits when the last client disconnects"), so on such a
 * version a missing service unit is not a misconfiguration and must not be
 * reported as one — a warning nobody can clear is noise that trains the human
 * to ignore the whole notification.
 */
export function evaluatePrerequisites(input: {
  serviceInstallSupported: boolean;
  serviceEnabled: boolean;
  lingerEnabled: boolean;
}): PrerequisiteReport {
  const problems: string[] = [];

  if (input.serviceInstallSupported && !input.serviceEnabled) {
    problems.push(
      "Claude Code デーモンがユーザーサービスとして登録されていません。" +
        "対話端末を全て閉じるとデーモンごと常駐セッションが失われます。" +
        "対処: `claude daemon` のサービス登録を有効にしてください。",
    );
  }
  if (!input.lingerEnabled) {
    problems.push(
      "ログイン残留（linger）が無効です。ログアウトでユーザープロセスが停止します。" +
        `対処: \`loginctl enable-linger ${safeUsername()}\` を実行してください。`,
    );
  }

  return { satisfied: problems.length === 0, problems };
}

export async function checkResidencyPrerequisites(
  executable = "claude",
): Promise<PrerequisiteReport> {
  // The CLI states its own capability; trust that over guessing from the
  // absence of a unit file, which cannot distinguish "unsupported" from
  // "supported but not installed".
  const daemonHelp = await commandOutput(executable, ["daemon", "--help"]);

  return evaluatePrerequisites({
    serviceInstallSupported: !daemonHelp.includes("Service install is disabled"),
    serviceEnabled: await commandSucceeds("systemctl", [
      "--user",
      "is-enabled",
      "com.anthropic.claude-daemon.service",
    ]),
    lingerEnabled: (await commandOutput("loginctl", [
      "show-user",
      safeUsername(),
      "--property=Linger",
    ])).includes("Linger=yes"),
  });
}

// ─── Prompt and notifications ───────────────────────────────────────

/**
 * Only the instruction path and the runtime settings travel on the command
 * line. Putting the full instructions in argv would hit the exec argument
 * limit and expose issue content in the process table; keeping them in a file
 * also means changing the orchestrator's behaviour is an edit, not a release.
 */
export function buildBootstrapPrompt(config: OrchestratorConfig): string {
  return [
    `あなたは常駐オーケストレータです。指示ファイル ${config.instructionPath} を読み、`,
    `その内容に従って巡回を開始してください。`,
    `確認間隔: 下限 ${config.minIntervalSeconds}秒 / 目標 ${config.targetIntervalSeconds}秒 / 上限 ${config.maxIntervalSeconds}秒。`,
    `ハートビート追記先: ${config.heartbeatPath}。`,
    `実装エージェントのモデル: ${config.implementModel}（effort ${config.implementEffort}）。`,
    `判断エージェントのモデル: ${config.judgementModel}。`,
  ].join("");
}

export type StartReason =
  | "初回起動"
  | "再起動"
  | "停滞のため再起動"
  | "指示ファイル反映のため再起動"
  | "文脈が上限に達したため再起動"
  | "稼働時間が上限に達したため再起動";

export function buildStartedPayload(
  sessionId: string,
  model: string,
  effort: string,
  reason: StartReason,
  prerequisites: PrerequisiteReport,
): DiscordPayload {
  const fields = [
    { name: "モデル", value: `${model} (effort: ${effort})`, inline: true },
    // Live --bg sessions refuse `--resume`; the agent TUI is the way in.
    {
      name: "参加",
      value: `\`claude agents\` で選択 (終了後は \`claude --resume ${sessionId}\`)`,
      inline: false,
    },
  ];
  if (!prerequisites.satisfied) {
    fields.push({
      name: "⚠ 常駐の前提条件が未達",
      value: truncateFieldValue(prerequisites.problems.join("\n\n")),
      inline: false,
    });
  }

  return {
    embeds: [
      {
        title: `🤖 オーケストレータを起動しました (${reason})`,
        color: 0x4caf50,
        fields,
        footer: { text: sessionId },
      },
    ],
  };
}

export function buildStalledPayload(
  lastHeartbeatAt: string | null,
  terminated = true,
): DiscordPayload {
  const description = [
    "セッションは生きていますが巡回が止まっています。終了させて再起動します。",
    `最終ハートビート: ${lastHeartbeatAt ?? "記録なし"}`,
  ];
  if (!terminated) {
    // Two loops on the same issues is worse than a stalled one, so say it now
    // rather than leaving it to next tick's duplicate warning.
    description.push(
      "⚠ 旧セッションを終了できませんでした。二重に稼働する可能性があるため、" +
        "`claude agents` で残っていないか確認してください。",
    );
  }

  return {
    embeds: [
      {
        title: "⚠ オーケストレータが停滞しています",
        description: description.join("\n"),
        color: 0xffa000,
      },
    ],
  };
}

export function buildStartFailedPayload(message: string): DiscordPayload {
  return {
    embeds: [
      {
        title: "❌ オーケストレータを起動できませんでした",
        description: message,
        color: 0xff4444,
      },
    ],
  };
}

export function buildReloadPayload(sessionId: string, terminated: boolean): DiscordPayload {
  const description = [
    "指示ファイルを反映するため、稼働中のセッションを終了して起動し直します。",
    `終了したセッション: \`${sessionId}\``,
    "進行中の子エージェントは終了しません。新しいセッションが命名規約で照合して引き継ぎます。",
  ];
  if (!terminated) {
    description.push(
      "⚠ 旧セッションを終了できませんでした。二重に稼働する可能性があるため、" +
        "`claude agents` で残っていないか確認してください。",
    );
  }

  return {
    embeds: [
      {
        title: "🔄 オーケストレータを再起動します (指示ファイル反映)",
        description: description.join("\n"),
        color: 0x2196f3,
      },
    ],
  };
}

export function buildRecyclePayload(
  sessionId: string,
  verdict: Extract<RecycleVerdict, { kind: "recycle" }>,
  terminated: boolean,
): DiscordPayload {
  const measure =
    verdict.cause === "context"
      ? `文脈: ${Math.round(verdict.contextTokens / 1000)}k トークン`
      : `稼働: ${Math.round(verdict.ageSeconds / 3600)}時間`;

  const description = [
    "巡回は正常ですが、1巡回あたりの費用が上限に達したので入れ替えます。",
    measure,
    `終了したセッション: \`${sessionId}\``,
    "進行中の子エージェントは終了しません。新しいセッションが命名規約で照合して引き継ぎます。",
  ];
  if (!terminated) {
    description.push(
      "⚠ 旧セッションを終了できませんでした。二重に稼働する可能性があるため、" +
        "`claude agents` で残っていないか確認してください。",
    );
  }

  return {
    embeds: [
      {
        title: `♻ オーケストレータを入れ替えます (${
          verdict.cause === "context" ? "文脈の肥大" : "稼働時間の上限"
        })`,
        description: description.join("\n"),
        color: 0x2196f3,
      },
    ],
  };
}

/**
 * Sent only for the duplicates that survived being terminated.
 *
 * The supervisor resolves the ordinary case itself, so a message here means the
 * state does not settle without a person: two sessions taking the same issues,
 * and one of them refusing to go.
 */
export function buildDuplicatePayload(sessionIds: string[]): DiscordPayload {
  return {
    embeds: [
      {
        title: "⚠ オーケストレータの二重稼働を解消できませんでした",
        description:
          `${ORCHESTRATOR_SESSION_NAME} の余分なセッション ${sessionIds.length} 個を` +
          "終了できませんでした。同じイシューを取り合う可能性があります。\n" +
          "`claude agents` で確認して、手で終了してください。\n" +
          sessionIds.map((id) => `\`${id}\``).join("\n"),
        color: 0xffa000,
      },
    ],
  };
}

// ─── Job ────────────────────────────────────────────────────────────

export interface SupervisorOptions {
  /**
   * Restart even when the session is healthy.
   *
   * The instruction file is read once at launch, so an edit to it does not
   * reach a running session. Re-reading in place leaves the superseded text in
   * the session's context, which is fine for an addition but unsafe for a rule
   * that reverses an earlier one — both versions would be present with nothing
   * to say which wins. A fresh context is the only way to retire the old rule.
   */
  forceRestart?: boolean;
}

/** Read the command line. Only `--restart` changes what the supervisor does. */
export function parseSupervisorArgs(argv: string[]): SupervisorOptions {
  return { forceRestart: argv.includes("--restart") };
}

/**
 * The checks that reach outside the process.
 *
 * Only the residency check is here, and only because it shells out to
 * `systemctl` and `loginctl`: their answers differ between a developer's
 * machine and CI, which made "did the supervisor stay quiet?" depend on where
 * the test ran rather than on the code.
 */
export interface SupervisorIo {
  checkPrerequisites(): Promise<PrerequisiteReport>;
}

export const REAL_SUPERVISOR_IO: SupervisorIo = {
  checkPrerequisites: () => checkResidencyPrerequisites(),
};

/**
 * Keep exactly one resident session alive, and replace it when it stops being
 * worth keeping.
 *
 * Three things end a session: it stalled (present and answering, but no longer
 * patrolling — which a liveness check alone would call healthy forever), its
 * context grew past what a patrol should cost, or the instruction file changed
 * and the old text has to be retired from its context.
 *
 * Only the first of those is worth telling anyone about. The other two happen
 * on schedule and finish on their own, so they pass without a word unless the
 * old session refused to die, which risks two loops on the same issues.
 */
export async function runOrchestratorSupervisor(
  options: SupervisorOptions = {},
  io: SupervisorIo = REAL_SUPERVISOR_IO,
): Promise<void> {
  const appConfig = loadCoreConfig();
  const config = loadOrchestratorConfig();
  const notify = (payload: DiscordPayload) => sendNotifications(appConfig, payload);
  const terminate = (session: AgentSummary) =>
    session.id === null
      ? Promise.resolve(false)
      : terminateSessionAndWait(session.id, session.sessionId, {
          executable: config.claudeExecutable,
        });

  // Render before the check below: the instruction file the session reads is an
  // output of this step, not something kept in the repository.
  await renderPrompts(
    config.promptSourceDirs,
    config.renderedPromptDir,
    promptNames(loadWorkflow()),
    config.repoDir,
  );

  if (!(await fileExists(config.instructionPath))) {
    const message =
      `指示ファイルが見つかりません: ${config.instructionPath}\n` +
      `ORCHESTRATOR_INSTRUCTION_PATH を確認してください。`;
    await notify(buildStartFailedPayload(message));
    throw notified(new Error(message));
  }

  const agents = await listAgents(config.claudeExecutable);
  // Layers 2 and 4 of the double-launch guard. `liveOrchestrators` matches our
  // name exactly — a partial match would depend on the wording of the launch
  // prompt — so an unrecorded session under that name is adopted rather than
  // duplicated, and anything left over is terminated rather than announced.
  const live = await reconcileDuplicates(liveOrchestrators(agents), config, notify, terminate);

  const current = live[0] ?? null;
  const now = new Date();
  const verdict = assessHealth({
    sessionListed: current !== null,
    jobState: current?.state ?? null,
    lastHeartbeat: await readLastHeartbeat(config.heartbeatPath),
    startedAt: current?.startedAt ?? null,
    now,
    maxIntervalSeconds: config.maxIntervalSeconds,
    graceSeconds: config.startupGraceSeconds,
  });

  const recycle = current
    ? assessRecycle({
        contextTokens: await readSessionContextTokens(config, current),
        ageSeconds: current.startedAt === null ? null : (now.getTime() - current.startedAt) / 1000,
        maxContextTokens: config.maxSessionContextTokens,
        maxAgeSeconds: config.maxSessionAgeSeconds,
      })
    : ({ kind: "keep" } as RecycleVerdict);

  if (verdict.kind === "healthy" && !options.forceRestart && recycle.kind === "keep") {
    // Silent on success, following the convention wait-reminder established.
    if (current) await recordSessionId(config, current.sessionId);
    return;
  }

  let reason: StartReason = "初回起動";

  // **入れ替えの報せは、その判断をした分岐が持つ。** 起動そのものは後始末なので、
  // 分岐が口を開いた（あるいは黙ると決めた）なら重ねて言わない。1つの出来事に
  // 2通出ると、通知そのものが読み飛ばされるようになる。
  //
  // だから分岐が何も担当しなかったとき——初回起動と、セッションが消えていた
  // ときだけ——起動を知らせる。
  let announceStart = true;

  if (options.forceRestart && current) {
    // 終了できたなら何も起きていないのと同じ。できなかったときだけ、
    // 二重稼働になりうることを言う。
    const terminated = await terminate(current);
    if (!terminated) await notify(buildReloadPayload(current.sessionId, terminated));
    announceStart = false;
    reason = "指示ファイル反映のため再起動";
  } else if (verdict.kind === "healthy" && recycle.kind === "recycle" && current) {
    const terminated = await terminate(current);
    if (!terminated) await notify(buildRecyclePayload(current.sessionId, recycle, terminated));
    announceStart = false;
    reason =
      recycle.cause === "context"
        ? "文脈が上限に達したため再起動"
        : "稼働時間が上限に達したため再起動";
  } else if (verdict.kind === "stalled" && current) {
    // Layer 3: stop the old one first. Leaving it running would put two loops
    // on the same issues.
    //
    // 停滞は異常なので必ず言う。ただし言うのはこの1通だけで、この後の起動は
    // 黙る。停滞の報せが「終了させて再起動します」まで含んでいる。
    const terminated = await terminate(current);
    await notify(buildStalledPayload(verdict.lastHeartbeatAt, terminated));
    announceStart = false;
    reason = "停滞のため再起動";
  } else if (await readRecordedSessionId(config)) {
    reason = "再起動";
  }

  const prerequisites = await io.checkPrerequisites();

  let launched: AgentSummary;
  try {
    launched = await launchBackgroundAgent(
      {
        prompt: buildBootstrapPrompt(config),
        cwd: process.cwd(),
        model: config.orchestratorModel,
        effort: config.orchestratorEffort,
        name: ORCHESTRATOR_SESSION_NAME,
        // Lets the session raise a question with the human on its own.
        brief: true,
      },
      { executable: config.claudeExecutable },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await notify(buildStartFailedPayload(message));
    throw notified(error instanceof Error ? error : new Error(message));
  }

  await recordSessionId(config, launched.sessionId);

  // **前提条件が未達なら、分岐が何を決めていようと喋る。** 常駐が成立して
  // いない状態を黙って起動すると、動いているつもりの空回りが続く。
  if (announceStart || !prerequisites.satisfied) {
    await notify(
      buildStartedPayload(
        launched.sessionId,
        config.orchestratorModel,
        config.orchestratorEffort,
        reason,
        prerequisites,
      ),
    );
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Leave exactly one orchestrator standing, and say so only when that failed.
 *
 * Duplicates used to be reported and nothing else, which made them permanent:
 * `liveOrchestrators` sorts newest first, so every later branch — recycle,
 * stall, restart — acted on the newest session, and the stranded older one was
 * never a candidate for termination again. A session that had already blown its
 * context limit could keep patrolling forever while the supervisor measured the
 * replacement's context and called the pair healthy.
 *
 * So this converges rather than warns, the way `container-sweep` does: read the
 * state, act on the evidence, and let the next tick pick up whatever did not
 * settle. The newest survives — it is the one the supervisor launched on
 * purpose, and the stranded one is typically the exhausted session the swap was
 * started to retire. Children outlive the session that dispatched them, so
 * nothing in flight is lost.
 *
 * **Only what can be proved older is terminated.** Without a `startedAt` there
 * is no order, and without an `id` there is nothing to address; either way the
 * session is left alone and reported rather than guessed at.
 */
export async function reconcileDuplicates(
  live: AgentSummary[],
  config: OrchestratorConfig,
  notify: (payload: DiscordPayload) => Promise<void>,
  terminate: (session: AgentSummary) => Promise<boolean>,
): Promise<AgentSummary[]> {
  if (live.length <= 1) return live;

  const [survivor, ...rest] = live as [AgentSummary, ...AgentSummary[]];
  const provablyOlder = (a: AgentSummary): boolean =>
    a.id !== null &&
    a.startedAt !== null &&
    survivor.startedAt !== null &&
    a.startedAt < survivor.startedAt;

  const stranded: AgentSummary[] = [];
  for (const session of rest) {
    if (!provablyOlder(session) || !(await terminate(session))) stranded.push(session);
  }

  if (stranded.length === 0) {
    // Resolved without anyone needing to act, so nothing is sent. The record
    // goes to stdout, where cron keeps it.
    console.log(
      `二重稼働を解消しました: ${rest.length}件を終了し、${survivor.sessionId} を残しました`,
    );
    return [survivor];
  }

  // Only the ones still standing are worth a human's attention.
  await notify(buildDuplicatePayload(stranded.map((a) => a.sessionId)));
  return liveOrchestrators(await listAgents(config.claudeExecutable));
}

/** Sessions under our exact name that have not reached a terminal state. */
export function liveOrchestrators(agents: AgentSummary[]): AgentSummary[] {
  return agents
    .filter((a) => a.name === ORCHESTRATOR_SESSION_NAME)
    .filter((a) => a.state === null || !isTerminalState(a.state))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * How big the running session's context is, or `null` if it cannot be told.
 *
 * The daemon names the transcript in its job state; nothing else does. When
 * either is unavailable the session simply falls through to the age backstop —
 * a supervisor that guessed here would kill healthy sessions on no evidence.
 */
async function readSessionContextTokens(
  config: OrchestratorConfig,
  agent: AgentSummary,
): Promise<number | null> {
  if (config.maxSessionContextTokens === null || !agent.id) return null;

  const jobState = await readJobState(agent.id);
  if (!jobState?.transcriptPath) return null;

  const sample = await readContextSample(jobState.transcriptPath);
  return sample?.contextTokens ?? null;
}

async function recordSessionId(config: OrchestratorConfig, sessionId: string): Promise<void> {
  await mkdir(dirname(config.sessionIdPath), { recursive: true });
  await writeFile(config.sessionIdPath, `${sessionId}\n`, "utf-8");
}

async function readRecordedSessionId(config: OrchestratorConfig): Promise<string | null> {
  try {
    const value = (await readFile(config.sessionIdPath, "utf-8")).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function notified(error: Error): Error {
  (error as Error & { notified?: boolean }).notified = true;
  return error;
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "$USER";
  }
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function commandOutput(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 10_000 });
    return stdout;
  } catch {
    return "";
  }
}

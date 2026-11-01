/**
 * Sweep verification containers whose work is over.
 *
 * A cron job rather than something the orchestrator session does, for the same
 * reason the sweep does not key on the merge event: sessions are replaced every
 * few hours and pull requests take days, so anything remembered inside a
 * session is gone by the time it would be needed. This runs on a timer, decides
 * from evidence that outlives every session, and converges — a run that misses
 * something is corrected by the next one.
 *
 * See `src/lib/container-sweep.ts` for the decision rules.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadCoreConfig } from "../lib/core-config.js";
import { sendNotifications } from "../lib/notification.js";
import { createTaskProvider } from "../lib/tasks/factory.js";
import { truncateFieldValue, type DiscordEmbed, type DiscordPayload } from "../lib/types.js";
import {
  DEFAULT_SWEEP_OPTIONS,
  decideProject,
  findTaskForWorktree,
  gatherContext,
  groupByProject,
  listContainers,
  tearDownProject,
  type SweepDecision,
  type SweepOptions,
} from "../lib/container-sweep.js";

export interface ContainerSweepArgs extends SweepOptions {
  /** Decide and report, tear nothing down. */
  dryRun: boolean;
  /**
   * How long a `report` stays quiet after it has been sent once.
   *
   * A stack nobody can decide on stays undecidable for days, and the sweep runs
   * hourly. Repeating the same line every hour does not make anyone act sooner;
   * it teaches them that the channel repeats itself. Once a day is a reminder.
   */
  reportIntervalHours: number;
  /** Where the sweep remembers what it has already reported. */
  statePath: string;
}

export const DEFAULT_REPORT_INTERVAL_HOURS = 24;

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CONTAINER_SWEEP_STATE_PATH) return env.CONTAINER_SWEEP_STATE_PATH;
  const stateDir = env.ORCHESTRATOR_STATE_DIR || join(homedir(), ".local/state/ai-orchestrator");
  return join(stateDir, "container-sweep.json");
}

export function defaultContainerSweepArgs(): ContainerSweepArgs {
  return {
    ...DEFAULT_SWEEP_OPTIONS,
    dryRun: false,
    reportIntervalHours: DEFAULT_REPORT_INTERVAL_HOURS,
    statePath: defaultStatePath(),
  };
}

/**
 * Read the command line, falling back to the defaults for anything absent.
 *
 * An unknown flag is a typo, and a typo that is ignored silently reads as a
 * successful run that swept nothing — so it stops here instead.
 */
export function parseContainerSweepArgs(argv: string[]): ContainerSweepArgs {
  const args = defaultContainerSweepArgs();
  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const grace = arg.match(/^--grace-hours=(\d+(?:\.\d+)?)$/);
    if (grace) {
      args.graceHours = Number(grace[1]);
      continue;
    }
    const report = arg.match(/^--report-after-days=(\d+(?:\.\d+)?)$/);
    if (report) {
      args.reportAfterDays = Number(report[1]);
      continue;
    }
    const interval = arg.match(/^--report-interval-hours=(\d+(?:\.\d+)?)$/);
    if (interval) {
      args.reportIntervalHours = Number(interval[1]);
      continue;
    }
    throw new Error(`不明な引数: ${arg}`);
  }
  return args;
}

/**
 * Read the running stacks, decide each one on its own evidence, and tear down
 * the ones whose work is finished.
 *
 * Nothing here remembers who started a container: the compose label points at
 * the worktree, so the chain back to a branch and its PR is rebuilt from the
 * machine's own state every run. That is what lets a stack outlive the session
 * that created it and still be collected — and why a missed one simply comes
 * back next run rather than being lost.
 */
export async function runContainerSweep(
  args: ContainerSweepArgs = defaultContainerSweepArgs(),
  now: Date = new Date(),
): Promise<void> {
  const projects = groupByProject(await listContainers());
  const decisions: SweepDecision[] = [];

  for (const project of projects) {
    const ctx = await gatherContext(project);
    decisions.push(decideProject(ctx, now, args));
  }

  const reap = decisions.filter((d) => d.action === "reap");
  const report = decisions.filter((d) => d.action === "report");
  const keep = decisions.filter((d) => d.action === "keep");

  for (const d of decisions) {
    if (d.action === "skip") continue;
    console.log(`[${d.action}] ${d.project.project} (${d.project.containers}件) — ${d.reason}`);
  }

  const failures: Array<{ decision: SweepDecision; error: string }> = [];
  for (const d of reap) {
    try {
      await tearDownProject(d.project.project, { dryRun: args.dryRun });
      console.log(`  停止${args.dryRun ? "（dry-run）" : ""}: ${d.project.project}`);
    } catch (err) {
      // One project failing must not strand the rest. It comes back next run,
      // and the notification says which one needs looking at.
      const message = (err as Error).message.split("\n")[0];
      failures.push({ decision: d, error: message });
      console.error(`  停止に失敗: ${d.project.project} — ${message}`);
    }
  }

  console.log(
    `対象 ${decisions.filter((d) => d.action !== "skip").length} プロジェクト: ` +
      `停止 ${reap.length - failures.length} / 保留 ${keep.length} / 要確認 ${report.length} / 失敗 ${failures.length}`,
  );

  const torndown = reap.filter((d) => !failures.some((f) => f.decision === d));

  if (!needsAttention(report, failures)) {
    if (!args.dryRun) {
      await saveReportState(args.statePath, pruneReportState(await loadReportState(args.statePath), report));
    }
    return;
  }

  const config = loadCoreConfig();
  const previous = await loadReportState(args.statePath);
  const due = selectReportsToNotify(report, previous, now, args.reportIntervalHours * HOUR_MS);
  if (due.length > 0) await attachTasks(due, config);
  const held = report.length - due.length;
  if (held > 0) {
    console.log(`  要確認 ${held} 件は前回の通知から ${args.reportIntervalHours} 時間未満のため通知しない`);
  }

  if (due.length === 0 && failures.length === 0) {
    if (!args.dryRun) await saveReportState(args.statePath, pruneReportState(previous, report));
    return;
  }

  const payload = buildSweepPayload(torndown, due, failures, args.dryRun);
  if (args.dryRun) {
    // A rehearsal shows what would be said; it sends nothing and remembers nothing.
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  await sendNotifications(config, payload);
  // Only what the reader actually saw counts as reported. Anything behind the
  // "ほか N 件" line never had its text delivered, so it is still due next run.
  await saveReportState(
    args.statePath,
    recordReports(pruneReportState(previous, report), due.slice(0, MAX_REPORT_FIELDS), now),
  );
}

const HOUR_MS = 60 * 60 * 1000;

/** How many undecidable stacks one notification spells out in full. */
export const MAX_REPORT_FIELDS = 5;

/**
 * Name the task behind each undecidable stack.
 *
 * Only `report` pays for the task-source round trip, and a failure to reach
 * the task source must not stop the sweep: the stack is still named by its
 * worktree and branch, which is what the reader had before.
 */
async function attachTasks(
  report: SweepDecision[],
  config: ReturnType<typeof loadCoreConfig>,
): Promise<void> {
  try {
    const tasks = await createTaskProvider(config).list({ withDescription: true });
    for (const d of report) {
      d.task = d.worktree ? findTaskForWorktree(tasks, d.worktree) : null;
    }
  } catch (err) {
    console.error(`  タスクの照合に失敗（通知には worktree とブランチだけ載せる）: ${(err as Error).message.split("\n")[0]}`);
  }
}

// ─── Report state (pure where it can be) ────────────────────────────

/** Per project: what was last said about it, and when. */
export interface ReportState {
  reported: Record<string, { reason: string; at: string }>;
}

const EMPTY_STATE: ReportState = { reported: {} };

/**
 * The reports worth sending this run: never sent, sent long enough ago, or
 * saying something different from last time. A changed reason is a changed
 * situation — `gh` recovering, a PR appearing — and the reader should hear
 * about it even if the previous line went out an hour ago.
 */
export function selectReportsToNotify(
  report: readonly SweepDecision[],
  state: ReportState,
  now: Date,
  intervalMs: number,
): SweepDecision[] {
  return report.filter((d) => {
    const last = state.reported[d.project.project];
    if (!last) return true;
    if (last.reason !== d.reason) return true;
    return now.getTime() - new Date(last.at).getTime() >= intervalMs;
  });
}

/** Forget projects that are no longer undecidable, so a stack that comes back later is reported afresh. */
export function pruneReportState(state: ReportState, report: readonly SweepDecision[]): ReportState {
  const live = new Set(report.map((d) => d.project.project));
  const reported: ReportState["reported"] = {};
  for (const [project, entry] of Object.entries(state.reported)) {
    if (live.has(project)) reported[project] = entry;
  }
  return { reported };
}

export function recordReports(state: ReportState, sent: readonly SweepDecision[], now: Date): ReportState {
  const reported = { ...state.reported };
  for (const d of sent) reported[d.project.project] = { reason: d.reason, at: now.toISOString() };
  return { reported };
}

async function loadReportState(path: string): Promise<ReportState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ReportState>;
    return { reported: parsed.reported ?? {} };
  } catch {
    // Absent or unreadable: the worst outcome is one extra notification.
    return EMPTY_STATE;
  }
}

async function saveReportState(path: string, state: ReportState): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    // Write beside and rename, so a crash mid-write leaves the old file whole
    // instead of a truncated one that reads back as "nothing reported yet".
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch (err) {
    // The sweep itself succeeded. Losing the record only brings the next
    // reminder forward; it never stops or repeats a teardown.
    console.error(`  通知の記録を書けませんでした: ${path} — ${(err as Error).message.split("\n")[0]}`);
  }
}

// ─── Notification (pure) ─────────────────────────────────────────────

/**
 * Whether the run produced anything a person has to look at.
 *
 * A successful teardown is not one of those. It happens on schedule, finishes
 * on its own, and leaves nothing to decide — so announcing it every hour only
 * trains the reader to skip the channel, which is where the `report` line that
 * did need them goes past unread. What was stopped is on stdout, and the cron
 * log keeps it.
 */
export function needsAttention(
  report: readonly SweepDecision[],
  failures: readonly unknown[],
): boolean {
  return report.length > 0 || failures.length > 0;
}

/**
 * One undecidable stack, written so the reader can act without opening a
 * terminal first: which ticket it belongs to, what state it is in, and what
 * resolves it. The ticket comes first because that is how a person recognises
 * the work; the compose project name means nothing to them.
 */
export function describeReport(d: SweepDecision): string {
  const lines: string[] = [];

  if (d.task) {
    const who = d.task.assignee ? `担当 ${d.task.assignee}` : "担当なし";
    lines.push(`チケット: [${d.task.id} ${d.task.title}](${d.task.url}) — ${d.task.status} / ${who}`);
  } else if (d.task === null) {
    lines.push("チケット: この worktree を説明文に持つタスクは見つからない");
  }

  const { containers, running } = d.project;
  const state =
    running === 0
      ? `コンテナ ${containers} 件はすべて停止済み（削除されず残っている）`
      : running === containers
        ? `コンテナ ${containers} 件が起動中`
        : `コンテナ ${containers} 件中 ${running} 件が起動中`;
  lines.push(`状態: ${d.reason}。${state}`);

  if (d.branch) lines.push(`ブランチ: \`${d.branch}\``);
  lines.push(`worktree: \`${d.worktree ?? d.project.workingDir}\``);
  lines.push(`確認すること: ${adviceFor(d)}`);

  return truncateFieldValue(lines.join("\n"));
}

/** What would make the next run decide this one on its own. */
export function adviceFor(d: SweepDecision): string {
  const down = `\`docker compose -p ${d.project.project} down --volumes\``;
  const reason = d.reason;

  if (reason.startsWith("PRが無いまま")) {
    return (
      "作業を続けるなら何もしなくてよい（PR ができれば次回から判定できる）。" +
      `終わっているなら worktree を消す（次の巡回で停止する）か、${down} を実行する`
    );
  }
  if (reason.startsWith("PRの状態を引けなかった")) {
    return "worktree で `gh auth status` と `gh pr list` が通るか確かめる。直れば次の巡回で判定し直す";
  }
  if (reason.startsWith("detached HEAD")) {
    return `ブランチを checkout すれば次の巡回で判定できる。不要なら ${down} を実行する`;
  }
  if (reason.startsWith("git の作業ツリーの外")) {
    return `手で立てたスタック。使っていなければ ${down} を実行する`;
  }
  return `判定に使える証拠が無い。不要なら ${down} を実行する`;
}

/**
 * Report only what a person has to look at.
 *
 * `keep` and successful teardowns are both absent: they are the steady state,
 * and a notification that lists them every run is one nobody reads by the third
 * day — which is exactly when the one line that mattered goes past unread. What
 * was torn down stays as a count, so a message about a failure still says how
 * much of the run succeeded.
 */
export function buildSweepPayload(
  reaped: SweepDecision[],
  report: SweepDecision[],
  failures: Array<{ decision: SweepDecision; error: string }>,
  dryRun: boolean,
): DiscordPayload {
  const containers = reaped.reduce((sum, d) => sum + d.project.containers, 0);
  const title = dryRun
    ? `\u{1F9F9} 検証用コンテナの掃除（dry-run）`
    : `\u{1F9F9} 検証用コンテナに要確認があります`;

  const fields: NonNullable<DiscordEmbed["fields"]> = [];

  for (const d of report.slice(0, MAX_REPORT_FIELDS)) {
    fields.push({
      name: `⚠️ 要確認: ${d.task ? d.task.id : d.project.project}`,
      value: describeReport(d),
    });
  }
  if (report.length > MAX_REPORT_FIELDS) {
    fields.push({
      name: "ほか",
      value: `要確認があと ${report.length - MAX_REPORT_FIELDS} 件。cron のログに全件ある`,
    });
  }
  for (const f of failures.slice(0, 5)) {
    fields.push({
      name: `❌ 停止失敗: ${f.decision.project.project}`,
      value: f.error.slice(0, 900),
    });
  }

  return {
    embeds: [
      {
        title,
        description:
          reaped.length > 0
            ? `${reaped.length} プロジェクト / ${containers} コンテナ${dryRun ? "が対象です" : "を停止しました"}。`
            : "停止した対象はありません。",
        color: failures.length > 0 ? 0xff4444 : 0xffa000,
        fields: fields.length > 0 ? fields : undefined,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

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

import { loadCoreConfig } from "../lib/core-config.js";
import { sendNotifications } from "../lib/notification.js";
import type { DiscordEmbed, DiscordPayload } from "../lib/types.js";
import {
  DEFAULT_SWEEP_OPTIONS,
  decideProject,
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
}

/**
 * Read the command line, falling back to the defaults for anything absent.
 *
 * An unknown flag is a typo, and a typo that is ignored silently reads as a
 * successful run that swept nothing — so it stops here instead.
 */
export function parseContainerSweepArgs(argv: string[]): ContainerSweepArgs {
  const args: ContainerSweepArgs = { ...DEFAULT_SWEEP_OPTIONS, dryRun: false };
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
  args: ContainerSweepArgs = { ...DEFAULT_SWEEP_OPTIONS, dryRun: false },
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

  if (!needsAttention(report, failures)) return;

  const config = loadCoreConfig();
  await sendNotifications(config,
    buildSweepPayload(torndown, report, failures, args.dryRun),
  );
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

  for (const d of report.slice(0, 5)) {
    fields.push({
      name: `⚠️ 要確認: ${d.project.project}`,
      value: `${d.reason}\n\`${d.branch ?? d.project.workingDir}\``,
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

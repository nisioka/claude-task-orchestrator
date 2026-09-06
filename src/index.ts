import { sendErrorNotifications } from "./lib/notification.js";
import { loadCoreConfig } from "./lib/core-config.js";
import { runOrchestratorSupervisor, parseSupervisorArgs } from "./jobs/orchestrator-supervisor.js";
import { runOrchestratorStatus } from "./jobs/orchestrator-status.js";
import { runContainerSweep, parseContainerSweepArgs } from "./jobs/container-sweep.js";

/**
 * The core's own entry point, so it runs without a host repository.
 *
 * A repository that embeds the core has a dispatcher of its own and lists these
 * alongside its own jobs; this one exists so the core is usable, and testable,
 * on its own terms.
 */

export type CoreJobName = "orchestrator-supervisor" | "orchestrator-status" | "container-sweep";

// The orchestrator itself is deliberately absent: it is a resident session,
// not a job. Only its supervisor and its status view are cron-shaped.
const JOBS: Record<CoreJobName, () => Promise<void>> = {
  "orchestrator-supervisor": () =>
    runOrchestratorSupervisor(parseSupervisorArgs(process.argv.slice(3))),
  "orchestrator-status": runOrchestratorStatus,
  "container-sweep": () => runContainerSweep(parseContainerSweepArgs(process.argv.slice(3))),
};

function isValidJobName(name: string): name is CoreJobName {
  return name in JOBS;
}

function printUsage(): void {
  console.error(`Usage: tsx src/index.ts <job-name>

Available jobs:
  orchestrator-supervisor  常駐オーケストレータの健全性確認と起動 (--restart で指示ファイル反映のため強制再起動)
  orchestrator-status      オーケストレータ・子エージェント・待ち案件・使用量の状態表示
  container-sweep          PRが完了した worktree の検証用コンテナを停止する
                           (--dry-run で判定だけ / --grace-hours=N / --report-after-days=N)`);
}

export async function main(): Promise<void> {
  const jobName = process.argv[2];

  if (!jobName || !isValidJobName(jobName)) {
    printUsage();
    process.exit(1);
  }

  try {
    await JOBS[jobName]();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`ジョブ実行エラー [${jobName}]:`, err.message);

    // ジョブが自分で通知済みなら二重に送らない
    const alreadyNotified =
      typeof error === "object" && error !== null && (error as { notified?: boolean }).notified === true;
    if (!alreadyNotified) {
      try {
        await sendErrorNotifications(loadCoreConfig(), jobName, err);
      } catch {
        // 設定の読み込み自体が失敗することもある。stderr には既に出ている
      }
    }

    process.exit(1);
  }
}

/* istanbul ignore next -- auto-invocation guard for testing */
if (process.env["VITEST"] === undefined) {
  main();
}

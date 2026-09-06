import { loadCoreConfig } from "../lib/core-config.js";
import { createTaskProvider } from "../lib/tasks/factory.js";

function parseArgs(argv: string[]): { identifier: string; status: string } {
  let identifier: string | null = null;
  let status: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith("--id=")) {
      identifier = arg.slice("--id=".length);
    } else if (arg.startsWith("--status=")) {
      status = arg.slice("--status=".length);
    }
  }

  if (!identifier) throw new Error("--id=<IDENTIFIER> が必要です (例: --id=TASK-16)");
  if (!status) throw new Error('--status=<STATUS_NAME> が必要です (例: --status="In Review")');

  return { identifier, status };
}

async function main() {
  const { identifier, status } = parseArgs(process.argv.slice(2));

  const tasks = createTaskProvider(loadCoreConfig());

  const task = await tasks.get(identifier);
  if (!task) {
    throw new Error(`Issue ${identifier} が見つかりません`);
  }

  await tasks.update(identifier, { status });

  process.stdout.write(`Success: ${identifier} のステータスを "${status}" に更新しました\n${task.url}\n`);
}

main().catch((err) => {
  process.stderr.write(`Failure: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

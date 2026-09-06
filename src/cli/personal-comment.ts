import { loadCoreConfig } from "../lib/core-config.js";
import { createTaskProvider } from "../lib/tasks/factory.js";

function parseArgs(argv: string[]): { identifier: string; body: string; updateLatest: boolean } {
  let identifier: string | null = null;
  let body: string | null = null;
  let updateLatest = false;

  for (const arg of argv) {
    if (arg.startsWith("--id=")) {
      identifier = arg.slice("--id=".length);
    } else if (arg.startsWith("--body=")) {
      body = arg.slice("--body=".length);
    } else if (arg === "--update-latest") {
      updateLatest = true;
    }
  }

  if (!identifier) throw new Error("--id=<IDENTIFIER> が必要です (例: --id=TASK-16)");
  if (!body) throw new Error("--body=<TEXT> が必要です");

  return { identifier, body, updateLatest };
}

async function main() {
  const { identifier, body, updateLatest } = parseArgs(process.argv.slice(2));

  const tasks = createTaskProvider(loadCoreConfig());

  const task = await tasks.get(identifier);
  if (!task) {
    throw new Error(`Issue ${identifier} が見つかりません`);
  }

  if (updateLatest) {
    await tasks.updateLatestComment(identifier, body);
    process.stdout.write(`Success: ${identifier} の最新コメントを更新しました\n${task.url}\n`);
    return;
  }

  await tasks.comment(identifier, body);
  process.stdout.write(`Success: コメントを ${identifier} に追加しました\n${task.url}\n`);
}

main().catch((err) => {
  process.stderr.write(`Failure: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

import { loadCoreConfig } from "../lib/core-config.js";
import { createTaskProvider } from "../lib/tasks/factory.js";

/**
 * Records a named value on a task.
 *
 * For the one thing a person looks *up* rather than reads: where the worktree
 * is. A comment holds the same text, but only a field can be seen without
 * scrolling the thread, and only a field survives the thread growing.
 *
 * Usage:
 *   tsx src/cli/personal-field.ts --id=<ISSUE-ID> --name=worktree --value=/abs/path
 */

export interface FieldArgs {
  identifier: string;
  name: string;
  value: string;
}

export function parseArgs(argv: string[]): FieldArgs {
  let identifier: string | null = null;
  let name: string | null = null;
  let value: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith("--id=")) identifier = arg.slice("--id=".length);
    else if (arg.startsWith("--name=")) name = arg.slice("--name=".length);
    // 値に `=` が入りうるので slice で切る。split すると途中で割れる
    else if (arg.startsWith("--value=")) value = arg.slice("--value=".length);
    else throw new Error(`不明な引数です: ${arg}`);
  }

  if (!identifier) throw new Error("--id=<ISSUE-ID> が必要です");
  if (!name) throw new Error("--name=<項目名> が必要です (例: --name=worktree)");
  if (value === null) throw new Error("--value=<値> が必要です");

  return { identifier, name, value };
}

async function main(): Promise<void> {
  const { identifier, name, value } = parseArgs(process.argv.slice(2));
  const tasks = createTaskProvider(loadCoreConfig());

  const task = await tasks.get(identifier);
  if (!task) throw new Error(`${identifier} が見つかりません`);

  await tasks.update(identifier, { fields: { [name]: value } });

  process.stdout.write(`Success: ${identifier} の "${name}" を設定しました\n${task.url}\n`);
}

if (process.env["VITEST"] === undefined) {
  main().catch((err) => {
    process.stderr.write(`Failure: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

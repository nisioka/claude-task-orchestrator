import { loadCoreConfig } from "../lib/core-config.js";
import { createTaskProvider } from "../lib/tasks/factory.js";
import { upsertHeader } from "../lib/tasks/header.js";

/**
 * Records a named value in the block at the top of a task's description.
 *
 * For the things a person looks *up* rather than reads: where the worktree is,
 * which PR came out of it. A comment holds the same text, but it is found by
 * scrolling; the top of the description is found by looking.
 *
 * Usage:
 *   tsx src/cli/personal-field.ts --id=<ISSUE-ID> --name=worktree --value=/abs/path
 *   tsx src/cli/personal-field.ts --id=<ISSUE-ID> --name=worktree --value=      # 消す
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
  if (value === null) throw new Error("--value=<値> が必要です（空文字を渡すと消えます）");
  if (name.includes(":")) throw new Error(`項目名に ":" は使えません: ${name}`);
  if (name.includes("\n") || value.includes("\n")) {
    throw new Error("項目名と値に改行は使えません（1行1項目のため）");
  }

  return { identifier, name, value };
}

async function main(): Promise<void> {
  const { identifier, name, value } = parseArgs(process.argv.slice(2));
  const tasks = createTaskProvider(loadCoreConfig());

  // 本文ごと書き戻すので、いまの本文を読んでから重ねる
  const task = await tasks.get(identifier);
  if (!task) throw new Error(`${identifier} が見つかりません`);

  await tasks.update(identifier, {
    description: upsertHeader(task.description, { [name]: value }),
  });

  const what = value === "" ? "を消しました" : `を "${value}" にしました`;
  process.stdout.write(`Success: ${identifier} の ${name} ${what}\n${task.url}\n`);
}

if (process.env["VITEST"] === undefined) {
  main().catch((err) => {
    process.stderr.write(`Failure: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

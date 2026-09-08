import { loadCoreConfig } from "../lib/core-config.js";
import { createTaskProvider } from "../lib/tasks/factory.js";

/**
 * Adds labels to a task, creating any that do not exist yet.
 *
 * Triage ends by tagging the task with the repository it belongs to, so every
 * triage run needs this. There was no CLI for it: the child prompts pointed at
 * `scripts/orch-apply.ts` in the parent repository, which still imported
 * `src/lib/linear.js` (gone) and parsed identifiers as `TEAM-<number>` (a Linear
 * shape the ClickUp backend does not have). It threw before reaching the API, so
 * every triage child failed at its last step and had to be talked through a
 * backend-specific workaround.
 *
 * Removal is deliberately absent. Labels here are classification, never state
 * (§3 of the orchestrator instructions), so they accumulate rather than toggle;
 * a wrong one is rare enough to be worth a human's click.
 *
 * Usage:
 *   tsx src/cli/personal-label.ts --id=<ISSUE-ID> --label=webapp-frontend
 *   tsx src/cli/personal-label.ts --id=<ISSUE-ID> --label=work --label=urgent
 */

export interface LabelArgs {
  identifier: string;
  labels: string[];
}

export function parseArgs(argv: string[]): LabelArgs {
  let identifier: string | null = null;
  const labels: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--id=")) identifier = arg.slice("--id=".length);
    else if (arg.startsWith("--label=")) {
      const raw = arg.slice("--label=".length);
      // 1つの --label にカンマ区切りで渡す形も受ける。区切りで空になった要素は捨てる
      for (const name of raw.split(",")) {
        const trimmed = name.trim();
        if (trimmed !== "") labels.push(trimmed);
      }
    } else throw new Error(`不明な引数です: ${arg}`);
  }

  if (!identifier) throw new Error("--id=<ISSUE-ID> が必要です");
  if (labels.length === 0) throw new Error("--label=<ラベル名> が必要です (例: --label=webapp-backend)");

  // 大文字で作ると Linear では別ラベルになる（GraphQL のフィルタが大小を区別するため）。
  // ClickUp は保存時に小文字化するので、揃えておかないと backend ごとに違う名前が残る
  return { identifier, labels: labels.map((name) => name.toLowerCase()) };
}

async function main(): Promise<void> {
  const { identifier, labels } = parseArgs(process.argv.slice(2));
  const tasks = createTaskProvider(loadCoreConfig());

  const task = await tasks.get(identifier);
  if (!task) throw new Error(`${identifier} が見つかりません`);

  await tasks.update(identifier, { addLabels: labels });

  process.stdout.write(`Success: ${identifier} に ${labels.join(", ")} を付けました\n${task.url}\n`);
}

if (process.env["VITEST"] === undefined) {
  main().catch((err) => {
    process.stderr.write(`Failure: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

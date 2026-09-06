import { loadCoreConfig } from "../lib/core-config.js";
import { createTaskProvider } from "../lib/tasks/factory.js";
import type { TaskDetail } from "../lib/tasks/types.js";

/**
 * Print an issue's description and recent comments.
 *
 * `orchestrator-status` answers "what is waiting", but deciding what to do
 * next needs the actual content — the orchestrator posts its proposal and its
 * questions as a Linear comment, and that is where the decision points live.
 *
 * Usage: tsx src/cli/personal-issue-detail.ts TASK-1101 [TASK-1198 ...] [--comments=3]
 */

export function parseDetailArgs(argv: string[]): { identifiers: string[]; commentCount: number } {
  const identifiers: string[] = [];
  let commentCount = 3;

  for (const arg of argv) {
    if (arg.startsWith("--comments=")) {
      const value = Number(arg.slice("--comments=".length));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--comments には1以上の整数を指定してください: "${arg}"`);
      }
      commentCount = value;
    } else if (arg.trim()) {
      identifiers.push(arg.trim());
    }
  }

  if (identifiers.length === 0) {
    throw new Error("イシュー識別子を1つ以上指定してください (例: TASK-1101)");
  }
  return { identifiers, commentCount };
}

export function renderIssue(task: TaskDetail): string {
  const lines = [
    `=== ${task.id}  ${task.title}`,
    `  status   : ${task.status}`,
    `  assignee : ${task.assignee?.name ?? "(未設定)"}`,
    `  updated  : ${task.updatedAt}`,
    `  url      : ${task.url}`,
    "",
    "--- description",
    task.description.trim() || "(空)",
  ];

  // Newest last, so the most recent proposal reads at the bottom.
  const comments = [...task.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const comment of comments) {
    lines.push("", `--- comment ${comment.createdAt} by ${comment.author}`, comment.body.trim());
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { identifiers, commentCount } = parseDetailArgs(process.argv.slice(2));
  const tasks = createTaskProvider(loadCoreConfig());

  const found = await tasks.getMany(identifiers, { comments: commentCount });
  if (found.length === 0) {
    console.error(`イシューが見つかりません: ${identifiers.join(", ")}`);
    process.exit(1);
  }

  console.log(found.map(renderIssue).join("\n\n"));
}

/* istanbul ignore next -- auto-invocation guard for testing */
if (process.env["VITEST"] === undefined) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}

import "dotenv/config";
// Reassign a personal-Linear issue between the AI user and the human.
//
// Handing the ball over is how the orchestrator stops. Changing the assignee is
// what actually reaches the human (Linear's own notification); moving only the
// status notifies nobody. Sessions kept re-deriving this call from
// updateIssueAssignee because no CLI existed, so it lives here.
//
//   tsx personal-assignee.ts --id=TASK-123 --to=human
//   tsx personal-assignee.ts --id=TASK-123 --to=ai
//   tsx personal-assignee.ts --id=TASK-123 --to=<user-uuid>
import { loadCoreConfig } from "../lib/core-config.js";
import { createTaskProvider } from "../lib/tasks/factory.js";

async function main() {
  let identifier: string | null = null;
  let to: string | null = null;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--id=")) identifier = arg.slice("--id=".length);
    else if (arg.startsWith("--to=")) to = arg.slice("--to=".length);
  }

  if (!identifier) throw new Error("--id=<IDENTIFIER> が必要です (例: --id=TASK-123)");
  if (!to) throw new Error("--to=<ai|human|UUID> が必要です (例: --to=human)");

  const tasks = createTaskProvider(loadCoreConfig());

  const task = await tasks.get(identifier);
  if (!task) throw new Error(`Issue ${identifier} が見つかりません`);

  const label =
    to === "ai" || to === "human"
      ? `${to === "ai" ? "AI" : "人間"} (${(await tasks.actor(to)).name})`
      : to;

  await tasks.update(identifier, { assignee: to as "ai" | "human" | string });

  process.stdout.write(`Success: ${identifier} の担当者を ${label} に変更しました\n${task.url}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

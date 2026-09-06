import "dotenv/config";
// Create a personal Linear issue. --body-file to avoid arg length limits.
import { readFileSync } from "node:fs";
import { loadCoreConfig } from "../lib/core-config.js";
import { createTaskProvider } from "../lib/tasks/factory.js";
import { loadWorkflow } from "../lib/tasks/workflow.js";

async function main() {
  let title: string | null = null;
  let bodyFile: string | null = null;
  let status = loadWorkflow().question;
  let assign = "human";
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--title=")) title = arg.slice(8);
    else if (arg.startsWith("--body-file=")) bodyFile = arg.slice(12);
    else if (arg.startsWith("--status=")) status = arg.slice(9);
    else if (arg.startsWith("--assign=")) assign = arg.slice(9);
  }
  if (!title || !bodyFile) throw new Error("--title= と --body-file= が必要です");

  const tasks = createTaskProvider(loadCoreConfig());

  const created = await tasks.create({
    title,
    description: readFileSync(bodyFile, "utf8"),
    group: "work",
    status,
    assignee: assign === "human" ? "human" : "ai",
  });

  process.stdout.write(`Success: ${created.id} を作成しました\n${created.url}\n`);
}

main().catch((err) => {
  process.stderr.write(`Failure: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

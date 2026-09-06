import { loadCoreConfig } from "../lib/core-config.js";
import { createTaskProvider } from "../lib/tasks/factory.js";
import { activeOrder, loadWorkflow } from "../lib/tasks/workflow.js";

/** 表示順。列挙の順がそのまま優先順位になる。 */
const ORDER = activeOrder(loadWorkflow());

const STATUS_ORDER: Record<string, number> = Object.fromEntries(
  ORDER.map((status, index) => [status, index]),
);

function parseArgs(argv: string[]): { statuses: string[]; includePrivate: boolean } {
  let statuses = ORDER;
  let includePrivate = false;

  for (const arg of argv) {
    if (arg.startsWith("--status=")) {
      statuses = arg.slice("--status=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--include-private") {
      includePrivate = true;
    }
  }

  return { statuses, includePrivate };
}

async function main() {
  const { statuses, includePrivate } = parseArgs(process.argv.slice(2));

  const tasks = createTaskProvider(loadCoreConfig());

  let issues = await tasks.list({ statuses });
  if (!includePrivate) {
    issues = issues.filter((task) => task.group !== "private");
  }

  issues.sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 99;
    const sb = STATUS_ORDER[b.status] ?? 99;
    if (sa !== sb) return sa - sb;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  process.stdout.write(JSON.stringify(issues, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`Failure: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

import "dotenv/config";
import { loadCoreConfig } from "../lib/core-config.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadRepositoryConfig, findRepositoryByLabel } from "../lib/repositories.js";
import {
  classifyConflicts,
  rebaseRulesFor,
  renderPlan,
  type RebaseRules,
} from "../lib/rebase-triage.js";

const execFileAsync = promisify(execFile);

/**
 * Print how to resolve the conflicts in a worktree that is mid-rebase.
 *
 * Run this *before* opening any conflicted file. Most of what a rebase throws
 * up is generated code and migration numbering, and reading those is where a
 * rebase turns into hundreds of model turns. The exit code carries the
 * decision so the caller does not have to interpret the text:
 *
 *   0  a plan was printed (or there was nothing to resolve)
 *   2  too much of it needs judgement — hand the rebase to a human
 *   1  the command could not run at all
 */

interface Options {
  worktree: string;
  label: string | null;
  configPath: string | null;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { worktree: process.cwd(), label: null, configPath: null };

  for (const arg of argv) {
    if (arg.startsWith("--worktree=")) options.worktree = arg.slice("--worktree=".length);
    else if (arg.startsWith("--label=")) options.label = arg.slice("--label=".length);
    else if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length);
    else if (!arg.startsWith("--")) options.worktree = arg;
  }

  return options;
}

/** Paths git reports as unmerged. Empty output means the rebase is clean. */
export function parseConflictPaths(stdout: string): string[] {
  return [...new Set(stdout.split("\n").map((line) => line.trim()).filter(Boolean))].sort();
}

async function resolveRules(options: Options): Promise<{ rules: RebaseRules; source: string }> {
  if (!options.label) return { rules: rebaseRulesFor(undefined), source: "既定のみ（--label 未指定）" };

  const config = await loadRepositoryConfig(
    options.configPath ?? loadCoreConfig().repositoriesPath,
  );
  const repository = findRepositoryByLabel(config, options.label);
  if (!repository) {
    throw new Error(`設定にラベル "${options.label}" のリポジトリがありません`);
  }

  return {
    rules: rebaseRulesFor(repository.rebase),
    source: repository.rebase ? options.label : `${options.label}（rebase 設定なし・既定のみ）`,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { rules, source } = await resolveRules(options);

  const { stdout } = await execFileAsync(
    "git",
    ["-C", options.worktree, "diff", "--name-only", "--diff-filter=U"],
    { maxBuffer: 10 * 1024 * 1024 },
  );

  const paths = parseConflictPaths(stdout);
  const result = classifyConflicts(paths, rules);

  console.log(`rebase コンフリクトの仕分け (${paths.length}件)  ルール: ${source}`);
  console.log("");
  console.log(renderPlan(result, rules).join("\n"));

  if (result.verdict === "handToHuman") process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

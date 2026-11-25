import {
  DEFAULT_REVIEW_BOTS,
  DEFAULT_TIMEOUT_MINUTES,
  NO_RUNS_MINUTES,
  POLL_SECONDS,
  runGh,
  waitForCi,
  type Target,
} from "../lib/ci-wait.js";

/**
 * Wait for CI and print one summary when it is over.
 *
 *   tsx src/cli/ci-wait.ts --pr=<number> [--repo=<owner/name>] [--timeout-min=90]
 *   tsx src/cli/ci-wait.ts --branch=<name> [--repo=<owner/name>] [--timeout-min=90]
 *
 * Meant to be started once in the background by an agent, which is told when it
 * exits. It prints nothing until then, so the agent reads CI exactly once.
 * Without `--repo` the repository of the current directory is used; without
 * `--pr` or `--branch`, the pull request of the current branch.
 *
 * The first line of the output is `結果: <outcome>`. Exit codes:
 *
 *   0  success
 *   2  any other outcome: failure, cancelled, timeout, conflict, no-runs, closed
 *   1  the command could not run, or GitHub could not be read
 */

export interface Options {
  repo: string | null;
  pr: number | null;
  branch: string | null;
  timeoutMinutes: number;
  intervalSeconds: number;
}

function positive(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} には正の数を渡してください: ${value}`);
  return n;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    repo: null,
    pr: null,
    branch: null,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    intervalSeconds: POLL_SECONDS,
  };
  for (const arg of argv) {
    const [key, ...rest] = arg.split("=");
    const value = rest.join("=");
    if (key === "--repo") options.repo = value;
    else if (key === "--pr") options.pr = positive("--pr", value.replace(/^#/, ""));
    else if (key === "--branch") options.branch = value;
    else if (key === "--timeout-min") options.timeoutMinutes = positive("--timeout-min", value);
    else if (key === "--interval-sec") options.intervalSeconds = positive("--interval-sec", value);
    else throw new Error(`知らない引数です: ${arg}`);
  }
  if (options.pr !== null && options.branch !== null) throw new Error("--pr と --branch はどちらか1つだけ渡してください");
  // The pull request of the current branch is looked up in the current directory's repository, not in --repo.
  if (options.repo !== null && options.pr === null && options.branch === null) {
    throw new Error("--repo を渡すときは --pr か --branch も渡してください");
  }
  if (options.repo !== null && !/^[\w.-]+\/[\w.-]+$/.test(options.repo)) {
    throw new Error(`--repo は owner/name の形で渡してください: ${options.repo}`);
  }
  return options;
}

async function resolveTarget(options: Options): Promise<Target> {
  const repo = options.repo ?? (await runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  if (options.branch !== null) return { repo, branch: options.branch };
  if (options.pr !== null) return { repo, pr: options.pr };
  const pr = Number((await runGh(["pr", "view", "--json", "number", "--jq", ".number"])).trim());
  if (!Number.isInteger(pr) || pr <= 0) throw new Error("今のブランチの PR が見つかりません。--pr か --branch を渡してください");
  return { repo, pr };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const target = await resolveTarget(options);
  const result = await waitForCi(
    target,
    {
      timeoutMs: options.timeoutMinutes * 60_000,
      noRunsMs: NO_RUNS_MINUTES * 60_000,
      reviewBots: DEFAULT_REVIEW_BOTS,
      intervalMs: options.intervalSeconds * 1000,
      maxReadFailures: 5,
    },
    { gh: runGh, now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  );
  console.log(result.summary);
  process.exit(result.outcome === "success" ? 0 : 2);
}

if (process.env["VITEST"] === undefined) {
  main().catch((err) => {
    console.error(`結果: error\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

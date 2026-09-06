import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The single source of truth for the PATH handed to child processes.
 *
 * cron's default PATH resolves neither `claude` nor `pnpm`, so a child spawned
 * from a cron-driven job dies on its very first command with "not found".
 * Every spawn point goes through here rather than assembling its own PATH.
 */

/** Directories that must be reachable, in priority order. */
export function extraPathEntries(
  home: string = homedir(),
  nodeBinDir: string = dirname(process.execPath),
): string[] {
  const entries = [
    join(home, ".local", "bin"), // claude
    join(home, ".local", "share", "pnpm"), // pnpm
    nodeBinDir, // node / npx of the running interpreter
  ];
  return dedupe(entries);
}

/** Prepend the required entries to `currentPath`, dropping duplicates and blanks. */
export function buildPath(
  currentPath: string | undefined,
  home: string = homedir(),
  nodeBinDir: string = dirname(process.execPath),
): string {
  const inherited = (currentPath ?? "").split(":");
  return dedupe([...extraPathEntries(home, nodeBinDir), ...inherited]).join(":");
}

/** A copy of `base` with PATH replaced. The base object is left untouched. */
export function buildExecEnv(
  base: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  nodeBinDir: string = dirname(process.execPath),
): NodeJS.ProcessEnv {
  return { ...base, PATH: buildPath(base.PATH, home, nodeBinDir) };
}

function dedupe(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

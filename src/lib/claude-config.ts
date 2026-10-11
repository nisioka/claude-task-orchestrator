import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where the Claude Code CLI keeps its state for the account in use.
 *
 * The CLI honours `CLAUDE_CONFIG_DIR`: credentials, the background daemon and
 * the job state files all move with it. That is what makes it possible to run
 * one orchestrator per account on the same machine — and it is also why nothing
 * here may assume `~/.claude`. A reader that looks in the default directory
 * while the CLI writes to another one does not fail; it just sees nothing, and
 * "no job state" reads the same as "the job is gone".
 */
export function claudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (!configured) return join(home, ".claude");
  if (configured === "~") return home;
  if (configured.startsWith("~/")) return join(home, configured.slice(2));
  return resolve(configured);
}

/**
 * The directory name the daemon of one config dir uses for its sockets.
 *
 * Observed, not documented: the daemon keys its socket directory by the first
 * eight hex digits of the SHA-256 of the config directory's path. Callers must
 * treat a miss as "cannot tell which daemon is ours", never as "no daemon".
 */
export function daemonSocketDirName(configDir: string): string {
  return createHash("sha256").update(configDir).digest("hex").slice(0, 8);
}

import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";

export interface RepositoryMapping {
  label: string;
  path: string;
  baseBranch: string;
  setupPrompt?: string;
  cleanupPrompt?: string;

  // Optional, for the orchestrator. All additions are optional so existing
  // config files keep working untouched.

  /**
   * Command that builds the work environment, including creating the worktree.
   * Per-repository setup scripts fit here unmodified —
   * which is why the worktree path is asked of git afterwards rather than
   * assumed from a naming convention.
   */
  setupCommand?: string;
  /** Branch name prefix; the Linear issue identifier is appended. */
  branchPrefix?: string;
  /**
   * A local-only patch this repository applies to its worktrees. The tracked
   * files it touches are made unstageable right after setup, so they cannot
   * reach a PR. The paths are derived from the patch at run time.
   */
  localPatch?: string;
  /** Overrides the implementation model for this repository. */
  model?: string;
  /**
   * Which conflict classes this repository resolves by command rather than by
   * reading. Absent means "only the built-in lock-file rules apply", which is
   * the safe reading: a path wrongly listed here gets overwritten.
   */
  rebase?: RebaseSettings;
}

export interface RebaseSettings {
  /** Globs of committed build artefacts. Conflicts are regenerated, not merged. */
  generatedPaths?: string[];
  /** Command that regenerates them, run after the rebase completes. */
  regenerateCommand?: string;
  /** Globs of sequentially numbered migrations. */
  migrationPaths?: string[];
  /** Command that renumbers them against the base branch. */
  renumberCommand?: string;
  /** Hand-resolve files above this count make the rebase a human's job. */
  handLimit?: number;
}

export interface RepositoryConfig {
  repositories: RepositoryMapping[];
}

const DEFAULT_CONFIG_PATH = resolve(homedir(), ".config/ai-orchestrator/repositories.json");

export async function loadRepositoryConfig(configPath?: string): Promise<RepositoryConfig> {
  const path = configPath || DEFAULT_CONFIG_PATH;

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(`設定ファイルを読み込めません: ${path} (${(err as Error).message})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`設定ファイルのJSONが不正です: ${path}`);
  }

  const config = parsed as Record<string, unknown>;

  if (!config.repositories || !Array.isArray(config.repositories)) {
    throw new Error("設定ファイルに repositories 配列がありません");
  }

  if (config.repositories.length === 0) {
    throw new Error("repositories が空です。少なくとも1つのリポジトリマッピングが必要です");
  }

  const seenLabels = new Set<string>();
  const repositories: RepositoryMapping[] = [];

  for (const entry of config.repositories as Record<string, unknown>[]) {
    if (!entry.label || typeof entry.label !== "string") {
      throw new Error("各リポジトリマッピングには label (文字列) が必要です");
    }
    if (!entry.path || typeof entry.path !== "string") {
      throw new Error(`リポジトリマッピング "${entry.label}" に path が必要です`);
    }
    if (!entry.baseBranch || typeof entry.baseBranch !== "string") {
      throw new Error(`リポジトリマッピング "${entry.label}" に baseBranch が必要です`);
    }

    if (!isAbsolute(entry.path)) {
      throw new Error(`リポジトリパスは絶対パスである必要があります: ${entry.path} (ラベル: ${entry.label})`);
    }

    if (seenLabels.has(entry.label)) {
      throw new Error(`ラベル "${entry.label}" が重複しています`);
    }
    seenLabels.add(entry.label);

    try {
      await access(entry.path, constants.R_OK);
    } catch {
      throw new Error(`リポジトリパスが存在しません: ${entry.path} (ラベル: ${entry.label})`);
    }

    repositories.push({
      label: entry.label,
      path: entry.path,
      baseBranch: entry.baseBranch,
      setupPrompt: typeof entry.setupPrompt === "string" ? entry.setupPrompt : undefined,
      cleanupPrompt: typeof entry.cleanupPrompt === "string" ? entry.cleanupPrompt : undefined,
      setupCommand: typeof entry.setupCommand === "string" ? entry.setupCommand : undefined,
      branchPrefix: typeof entry.branchPrefix === "string" ? entry.branchPrefix : undefined,
      localPatch: typeof entry.localPatch === "string" ? entry.localPatch : undefined,
      model: typeof entry.model === "string" ? entry.model : undefined,
      rebase: parseRebaseSettings(entry.rebase, entry.label),
    });
  }

  return { repositories };
}

/**
 * Reject a malformed `rebase` block instead of silently ignoring it.
 *
 * These lists decide which files get overwritten by a regeneration. A typo
 * that quietly turns into "no rules" would send the agent back to merging
 * generated code by hand — the exact failure this exists to prevent, and one
 * that looks like ordinary slowness rather than a misconfiguration.
 */
function parseRebaseSettings(value: unknown, label: string): RebaseSettings | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`リポジトリマッピング "${label}" の rebase はオブジェクトである必要があります`);
  }

  const entry = value as Record<string, unknown>;
  const settings: RebaseSettings = {
    generatedPaths: parseGlobList(entry.generatedPaths, label, "generatedPaths"),
    migrationPaths: parseGlobList(entry.migrationPaths, label, "migrationPaths"),
    regenerateCommand:
      typeof entry.regenerateCommand === "string" ? entry.regenerateCommand : undefined,
    renumberCommand: typeof entry.renumberCommand === "string" ? entry.renumberCommand : undefined,
  };

  if (entry.handLimit !== undefined) {
    if (typeof entry.handLimit !== "number" || !Number.isInteger(entry.handLimit) || entry.handLimit < 0) {
      throw new Error(`リポジトリマッピング "${label}" の rebase.handLimit は0以上の整数です`);
    }
    settings.handLimit = entry.handLimit;
  }

  return settings;
}

function parseGlobList(value: unknown, label: string, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`リポジトリマッピング "${label}" の rebase.${field} は文字列の配列です`);
  }
  return value as string[];
}

export function findRepositoryByLabel(
  config: RepositoryConfig,
  label: string,
): RepositoryMapping | undefined {
  return config.repositories.find((r) => r.label === label);
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The `--settings` files the resident session and its children start with.
 *
 * `--settings` takes one file, and what it holds is merged key by key over the
 * user's and the project's own settings (measured: a plugin set to `false`
 * there disappears while the others stay). So each kind of session gets one
 * file, written here on every supervisor tick:
 *
 * - `impl.json`: the repository's local settings plus the instance overlay. A
 *   child starts in another repository's worktree, so without this it would
 *   lose the permission rules it has always had
 * - `judge.json`: the same, plus the repository's own `CLAUDE.md` left out. A
 *   judgement child starts here, and that file is the orchestrator's design
 *   document — read on every turn, used on none. The rules a judgement child
 *   does need live in its prompt instead
 * - `orchestrator.json`: only the `CLAUDE.md` exclusion. The session starts
 *   here, so it already has the local settings; the overlay is for children
 *
 * The overlay is the instance's to write (`ORCHESTRATOR_CHILD_SETTINGS_PATH`),
 * typically the plugins no child uses. Plugin names belong to the machine, so
 * the core ships no default: without the file nothing is turned off.
 */

export type SettingsObject = Record<string, unknown>;

export interface ChildSettingsPaths {
  /** `null` when there is nothing to pass: no local settings and no overlay. */
  impl: string | null;
  judge: string;
  orchestrator: string;
}

/** The repository's own instruction files, by absolute path. */
export function repositoryClaudeMdFiles(repoDir: string): string[] {
  return [join(repoDir, "CLAUDE.md"), join(repoDir, "CLAUDE.local.md")];
}

function isPlainObject(value: unknown): value is SettingsObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Layer settings the way the CLI layers its sources: a later object wins per
 * key, nested objects are merged one level down (`permissions`,
 * `enabledPlugins`), and arrays are joined without repeats.
 */
export function mergeSettings(...layers: (SettingsObject | null)[]): SettingsObject {
  const out: SettingsObject = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      const current = out[key];
      if (Array.isArray(current) && Array.isArray(value)) {
        out[key] = [...new Set([...current, ...value])];
      } else if (isPlainObject(current) && isPlainObject(value)) {
        out[key] = mergeSettings(current, value);
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

/** A settings file, or `null` when it does not exist. A broken one is an error, not an absence. */
export async function readSettingsFile(path: string | null): Promise<SettingsObject | null> {
  if (!path) return null;
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error(`設定ファイルが JSON のオブジェクトではありません: ${path}`);
  return parsed;
}

export function composeChildSettings(input: {
  local: SettingsObject | null;
  overlay: SettingsObject | null;
  repoDir: string;
}): { impl: SettingsObject | null; judge: SettingsObject; orchestrator: SettingsObject } {
  const exclude = { claudeMdExcludes: repositoryClaudeMdFiles(input.repoDir) };
  const impl = input.local || input.overlay ? mergeSettings(input.local, input.overlay) : null;
  return {
    impl,
    judge: mergeSettings(input.local, input.overlay, exclude),
    orchestrator: exclude,
  };
}

/** Write the three files under `<stateDir>/child-settings/` and return their paths. */
export async function writeChildSettings(input: {
  stateDir: string;
  repoDir: string;
  overlayPath: string | null;
}): Promise<ChildSettingsPaths> {
  const composed = composeChildSettings({
    local: await readSettingsFile(join(input.repoDir, ".claude", "settings.local.json")),
    overlay: await readSettingsFile(input.overlayPath),
    repoDir: input.repoDir,
  });
  const dir = join(input.stateDir, "child-settings");
  await mkdir(dir, { recursive: true });
  const write = async (name: string, settings: SettingsObject) => {
    const path = join(dir, name);
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
    return path;
  };
  return {
    impl: composed.impl ? await write("impl.json", composed.impl) : null,
    judge: await write("judge.json", composed.judge),
    orchestrator: await write("orchestrator.json", composed.orchestrator),
  };
}

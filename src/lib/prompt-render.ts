import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Renders the prompt sources into the files the sessions actually read.
 *
 * Two things in a prompt cannot be written down once and be right everywhere:
 *
 *   - **Absolute paths.** The prompts tell the session where to `cd` and which
 *     CLI to run. Writing one machine's home directory into a file that is meant
 *     to be published puts an individual's paths in a public repository, and it
 *     is wrong for everyone else regardless.
 *   - **Status names.** The prompts name statuses in running prose — 「`In
 *     Review` のままAIに振る」 — about a hundred times. A different task source
 *     spells them differently: ClickUp calls the same two statuses `to do` and
 *     `deploy & test`.
 *
 * So the sources are written in one fixed vocabulary and rendered against the
 * configured one. Rendering happens on every supervisor run rather than by hand,
 * because a step someone has to remember is a step that stops happening — and
 * the failure is silent, since a stale rendered prompt still reads perfectly.
 */

/** Where the core's own CLIs live. Derived, so no config can be wrong. */
export const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RenderContext {
  /** Renames from the vocabulary the sources use to the configured one. */
  names: Record<string, string>;
  /** Absolute path of the directory the rendered prompts are written to. */
  promptDir: string;
  /**
   * Absolute path of the repository that embeds the core.
   *
   * Distinct from `coreDir` because the two stop being the same the moment the
   * core is consumed as a submodule: a prompt shipped by the embedding
   * repository points at that repository's own scripts, while the core's own
   * prompts point at the core's CLIs. One placeholder for both would send one
   * of them to a path that does not exist. Defaults to `coreDir`, which is
   * correct when the core runs on its own.
   */
  repoDir?: string;
  /** Absolute path of the core itself. */
  coreDir?: string;
  /** The child rule table, already rendered. */
  childRules?: string;
  /** Sections contributed by the embedding repositories, already concatenated. */
  extraSections?: string;
}

/**
 * One kind of child agent, and the rule file that describes it.
 *
 * Declared by whoever ships the rule file, in a `child/rules.json` next to it.
 * The core's own prompt must not name the kinds a private integration adds —
 * `company-mirror-triage` and `sentry-common` were written into the core
 * prompt's table, which made the core carry the vocabulary of one employer's
 * tooling and was the last thing standing between here and a clean extraction.
 */
export interface ChildRule {
  /** Path of the rule file, relative to the prompt root (`child/impl.md`). */
  file: string;
  /** What the kind is for, as one line of the table. */
  purpose: string;
}

/**
 * A status name is replaced only inside backticks or double quotes.
 *
 * The prompts are disciplined about this — every status name appears either as
 * `` `Test` `` in prose or as `--status="Test"` in a command — and the
 * restriction is what makes the substitution safe: `Test`, `Wait` and `Done` are
 * ordinary English words that would otherwise be rewritten wherever they occur.
 */
function renameStatuses(text: string, names: Record<string, string>): string {
  const keys = Object.keys(names);
  if (keys.length === 0) return text;

  // Longest first so a name that is a prefix of another cannot shadow it.
  const alternation = keys
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  // One pass, so a renamed value is never renamed again by a later rule.
  return text.replace(new RegExp(`(["\`])(${alternation})\\1`, "g"), (_m, quote, name) => {
    return `${quote}${names[name]}${quote}`;
  });
}

/**
 * Fills in the placeholders, without touching status names.
 *
 * Separate from `renderPromptText` because an appended section has to be
 * substituted *before* it is inserted — a placeholder inside it would otherwise
 * arrive after every replacement has already run, and survive into the rendered
 * file. Statuses stay out of this pass so they are renamed exactly once, over
 * the finished document: a mapping whose target is another mapping's source
 * would otherwise be applied twice to the appended text.
 */
export function substitutePaths(text: string, context: RenderContext): string {
  const coreDir = context.coreDir ?? CORE_DIR;
  return text
    .replaceAll("{{coreDir}}", coreDir)
    .replaceAll("{{repoDir}}", context.repoDir ?? coreDir)
    .replaceAll("{{promptDir}}", context.promptDir)
    .replaceAll("{{childRules}}", context.childRules ?? "")
    .replaceAll("{{extraSections}}", context.extraSections ?? "");
}

export function renderPromptText(text: string, context: RenderContext): string {
  return renameStatuses(substitutePaths(text, context), context.names);
}

/** The registered child kinds as a markdown table, absolute paths and all. */
export function renderChildRules(rules: ChildRule[], promptDir: string): string {
  const rows = rules.map((r) => `| \`${promptDir}/${r.file}\` | ${r.purpose} |`);
  return ["| ファイル | 用途 |", "|---|---|", ...rows].join("\n");
}

const RULES_MANIFEST = "child/rules.json";

/**
 * A prompt source's own additions to the orchestrator's instructions.
 *
 * The core's instruction file is one document, so a repository that embeds the
 * core cannot overlay half of it — replacing the whole file would fork the very
 * thing it is consuming. Instead the core ends with `{{extraSections}}`, and
 * each source may append to it. The Slack intake rules moved out this way: they
 * name a CLI and a workspace the core has never heard of.
 */
const EXTRA_SECTIONS = "orchestrator-extra.md";

/** Reads one source's appended sections. Missing is normal. */
async function readExtraSections(sourceDir: string): Promise<string | null> {
  try {
    return await readFile(join(sourceDir, EXTRA_SECTIONS), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Reads one source's `child/rules.json`. Missing is normal: not every source adds a kind. */
async function readRules(sourceDir: string): Promise<ChildRule[]> {
  let text: string;
  try {
    text = await readFile(join(sourceDir, RULES_MANIFEST), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`${join(sourceDir, RULES_MANIFEST)} は配列である必要があります`);
  }
  return parsed.map((entry, index) => {
    const rule = entry as Partial<ChildRule>;
    if (typeof rule.file !== "string" || typeof rule.purpose !== "string") {
      throw new Error(
        `${join(sourceDir, RULES_MANIFEST)} の ${index} 番目に file / purpose がありません`,
      );
    }
    return { file: rule.file, purpose: rule.purpose };
  });
}

/** Every `.md` under a directory, relative to it, in a stable order. */
async function markdownFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await markdownFiles(join(dir, entry.name), rel)));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

/**
 * Renders every prompt under the source directories into `outDir`.
 *
 * Sources are layered: a later one overwrites a file of the same relative path
 * from an earlier one, and its registered child kinds are appended to the
 * table. That is how a private repository adds child kinds and overrides a
 * rule without the core having to know it exists.
 *
 * Returns the relative paths written, so the caller can report what it did.
 */
export async function renderPrompts(
  sourceDirs: string | string[],
  outDir: string,
  names: Record<string, string>,
  repoDir: string = CORE_DIR,
  coreDir: string = CORE_DIR,
): Promise<string[]> {
  const sources = typeof sourceDirs === "string" ? [sourceDirs] : sourceDirs;

  const rules: ChildRule[] = [];
  const extras: string[] = [];
  for (const dir of sources) {
    rules.push(...(await readRules(dir)));
    const extra = await readExtraSections(dir);
    if (extra) extras.push(extra.trim());
  }

  const context: RenderContext = {
    names,
    promptDir: outDir,
    repoDir,
    coreDir,
    childRules: renderChildRules(rules, outDir),
  };
  context.extraSections = extras.map((text) => substitutePaths(text, context)).join("\n\n");

  // 後の source が同じ相対パスを上書きする。書いた順ではなく、最終的な集合を返す
  const written = new Map<string, string>();
  for (const dir of sources) {
    // `orchestrator-extra.md` is a fragment of another file, not a prompt.
    for (const rel of await markdownFiles(dir)) {
      if (rel !== EXTRA_SECTIONS) written.set(rel, dir);
    }
  }

  for (const [rel, dir] of written) {
    const target = join(outDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      renderPromptText(await readFile(join(dir, rel), "utf-8"), context),
      "utf-8",
    );
  }
  return [...written.keys()].sort();
}

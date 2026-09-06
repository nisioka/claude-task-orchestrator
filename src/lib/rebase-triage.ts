/**
 * Sort rebase conflicts into the ones a command resolves and the ones a person
 * has to read.
 *
 * Rebasing is the most expensive thing this system does, and almost none of
 * that cost is judgement. One BE rebase ran to 3,142 model turns because the
 * conflicts were in generated code — a jOOQ `Keys.kt` whose 500 entries shift
 * position on every regeneration, and migrations whose only conflict is their
 * number. Merging those by hand is not just slow, it is wrong: the correct
 * resolution is to throw both sides away and regenerate.
 *
 * So the rule is: a generated file is never merged, and a numbered migration
 * is never renumbered by hand. What is left over is real code, and if there is
 * a lot of it the rebase is not a mechanical task at all and belongs to a
 * human.
 *
 * Classification is deliberately explicit per repository. A path wrongly
 * called "generated" gets overwritten, so the built-in defaults cover only
 * lock files, which are generated everywhere.
 */

import type { RebaseSettings } from "./repositories.js";

// ─── Types ──────────────────────────────────────────────────────────

export type ConflictClass = "regenerate" | "renumber" | "hand";

export interface RebaseRules {
  /** Globs whose conflicts are resolved by regenerating, never by merging. */
  generatedPaths: string[];
  /** Command that regenerates them, run after the rebase completes. */
  regenerateCommand: string | null;
  /** Globs holding sequentially numbered migrations. */
  migrationPaths: string[];
  /** Command that renumbers them against the base branch. */
  renumberCommand: string | null;
  /**
   * How many hand-resolve files make this someone else's job.
   *
   * Not a measure of difficulty — a measure of what an agent is good for. Past
   * this many, the cheap outcome is to stop and say so rather than to grind
   * through it and be wrong somewhere in the middle.
   */
  handLimit: number;
}

export interface TriageResult {
  regenerate: string[];
  renumber: string[];
  hand: string[];
  /** `handToHuman` when the hand-resolve set is over the limit. */
  verdict: "clean" | "mechanical" | "mixed" | "handToHuman";
}

/**
 * Lock files are generated in every ecosystem, so they are safe to classify
 * without repository-specific configuration. Nothing else is.
 */
export const DEFAULT_GENERATED_PATHS = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/Cargo.lock",
  "**/go.sum",
  "**/composer.lock",
  "**/Gemfile.lock",
];

export const DEFAULT_HAND_LIMIT = 10;

export function defaultRebaseRules(): RebaseRules {
  return {
    generatedPaths: [...DEFAULT_GENERATED_PATHS],
    regenerateCommand: null,
    migrationPaths: [],
    renumberCommand: null,
    handLimit: DEFAULT_HAND_LIMIT,
  };
}

/**
 * Repository settings on top of the built-in rules. The lock-file defaults are
 * kept rather than replaced: a repository that names its jOOQ output has not
 * thereby said its lock file is hand-written.
 */
export function rebaseRulesFor(settings: RebaseSettings | undefined): RebaseRules {
  return {
    generatedPaths: [...DEFAULT_GENERATED_PATHS, ...(settings?.generatedPaths ?? [])],
    regenerateCommand: settings?.regenerateCommand ?? null,
    migrationPaths: settings?.migrationPaths ?? [],
    renumberCommand: settings?.renumberCommand ?? null,
    handLimit: settings?.handLimit ?? DEFAULT_HAND_LIMIT,
  };
}

// ─── Classification ─────────────────────────────────────────────────

export function classifyConflict(path: string, rules: RebaseRules): ConflictClass {
  if (matchesAny(path, rules.generatedPaths)) return "regenerate";
  if (matchesAny(path, rules.migrationPaths)) return "renumber";
  return "hand";
}

export function classifyConflicts(paths: string[], rules: RebaseRules): TriageResult {
  const result: TriageResult = { regenerate: [], renumber: [], hand: [], verdict: "clean" };

  for (const path of paths) {
    result[classifyConflict(path, rules)].push(path);
  }

  result.verdict = judge(result, rules);
  return result;
}

function judge(result: TriageResult, rules: RebaseRules): TriageResult["verdict"] {
  const total = result.regenerate.length + result.renumber.length + result.hand.length;
  if (total === 0) return "clean";
  if (result.hand.length > rules.handLimit) return "handToHuman";
  if (result.hand.length === 0) return "mechanical";
  return "mixed";
}

// ─── Plan ───────────────────────────────────────────────────────────

/**
 * The plan is printed rather than executed.
 *
 * Resolving a conflict is a write to someone's work in progress, and the
 * commands differ per repository. What this saves is not the typing — it is
 * the reading: the agent runs these without ever opening a 500-entry generated
 * file, which is where the tokens went.
 */
export function renderPlan(result: TriageResult, rules: RebaseRules): string[] {
  if (result.verdict === "clean") return ["コンフリクトはありません。"];

  const lines: string[] = [];

  if (result.verdict === "handToHuman") {
    lines.push(
      `⚠ 手で解決すべきファイルが ${result.hand.length} 件あります（上限 ${rules.handLimit} 件）。`,
      "これは機械的な rebase ではありません。**着手せず人間へ渡してください。**",
      "Linearコメントに、次を残してください:",
      "  - コンフリクトしているファイルの一覧（下記）",
      "  - 現在のブランチと worktree の絶対パス",
      "  - force push 前のリモート先端SHA（`git rev-parse origin/<branch>`）",
      "",
    );
  }

  if (result.regenerate.length > 0) {
    lines.push(
      `■ 生成物 (${result.regenerate.length}件) — 中身を読まない。マージもしない`,
      ...result.regenerate.map((path) => `    ${path}`),
      "  どちらの版を採っても構いません（再生成で上書きされます）。衝突だけ潰して先へ進めます。",
      "  rebase 中の --theirs は「今リプレイしている自分のコミット側」です（マージのときと逆）。",
      `    git checkout --theirs -- ${quoteAll(result.regenerate)}`,
      `    git add -- ${quoteAll(result.regenerate)}`,
      rules.regenerateCommand
        ? `  rebase 完了後: ${rules.regenerateCommand}`
        : "  ⚠ 再生成コマンドが設定されていません（config の rebase.regenerateCommand）。" +
          "リポジトリの生成手順を確認してください。",
      "",
    );
  }

  if (result.renumber.length > 0) {
    lines.push(
      `■ 採番 (${result.renumber.length}件) — 手で番号を振り直さない`,
      ...result.renumber.map((path) => `    ${path}`),
      rules.renumberCommand
        ? `  rebase 完了後: ${rules.renumberCommand}`
        : "  ⚠ 採番コマンドが設定されていません（config の rebase.renumberCommand）。",
      "  番号だけの衝突なら、自分の版を残してから上のコマンドで振り直します。",
      "",
    );
  }

  if (result.hand.length > 0) {
    lines.push(
      `■ 手で解決 (${result.hand.length}件)`,
      ...result.hand.map((path) => `    ${path}`),
      "  ここだけが判断の要る差分です。どちらの変更も捨てないこと。",
      "",
    );
  }

  return lines;
}

// ─── Glob matching ──────────────────────────────────────────────────

/**
 * A deliberately small subset: `*` within a segment, `**` across segments.
 * Anything richer would be a second pattern language to get wrong, and these
 * patterns are written by hand in a config file.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const expression = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return escapeRegExp(part);
    })
    .join("");

  return new RegExp(`^${expression}$`).test(path);
}

/**
 * Positive patterns select, `!` patterns exclude, and exclusion wins.
 *
 * Generated trees are not pure: `client/**` is orval output except for
 * `client/mutator/custom-instance.ts`, which is hand-written and feeds the
 * generator. Without a way to carve that out, the choice would be between
 * regenerating over someone's code and reading a thousand generated files.
 */
function matchesAny(path: string, patterns: string[]): boolean {
  let selected = false;

  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (matchesGlob(path, pattern.slice(1))) return false;
    } else if (matchesGlob(path, pattern)) {
      selected = true;
    }
  }

  return selected;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteAll(paths: string[]): string {
  return paths.map((path) => `'${path}'`).join(" ");
}

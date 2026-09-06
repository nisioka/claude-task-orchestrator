/**
 * A small block at the top of a task's description, holding the pointers a
 * person needs at a glance.
 *
 * The values it carries — where the worktree is, which PR came out of it — are
 * looked *up*, not read. Buried in a comment thread they are found by
 * scrolling; at the top of the description they are found by looking.
 *
 * This lives in the description rather than in the backend's own custom fields
 * because those are metered: ClickUp's free plan stops accepting values after
 * about sixty tasks, and Linear has no per-issue fields at all. A description
 * is text on every backend, so one rule covers both.
 *
 * **Everything here is plain text, including the delimiters.** ClickUp rewrites
 * a description on save, and an HTML comment sitting in the same description as
 * a URL makes it escape and re-link that URL on every write, compounding until
 * it is unreadable — measured at three round trips. Replace the comment with
 * bare words and the same description survives repeated rewriting untouched,
 * headings, bullets, code fences and all.
 *
 * A markdown link whose text differs from its URL is unsafe for the same
 * reason, so values go in bare. ClickUp normalises a bare URL to `[url](url)`
 * once and then leaves it alone; `readHeader` undoes that so a caller gets back
 * what it wrote.
 */

const BEGIN = "orchestrator:begin";
const END = "orchestrator:end";

/** The whole block, delimiters included, wherever it sits. */
const BLOCK = /^[ \t]*orchestrator:begin[ \t]*$([\s\S]*?)^[ \t]*orchestrator:end[ \t]*$\n*/m;

/**
 * One `name: value` line inside the block.
 *
 * The optional bullet is for reading only: ClickUp turns a `- ` into `*   `,
 * and older blocks were written with bullets.
 */
const ENTRY = /^\s*(?:[-*]\s+)?([^:\n]+?)\s*:\s*(.*?)\s*$/;

/** `[url](url)`, which is what ClickUp makes of a bare URL. */
const SELF_LINK = /^\[([^\]]+)\]\(\1\)$/;

export type HeaderEntries = Record<string, string>;

/** Undoes ClickUp's auto-linking, so a value reads back as it was written. */
function unlink(value: string): string {
  return SELF_LINK.exec(value)?.[1] ?? value;
}

/**
 * The entries currently in the block. Empty when there is no block.
 *
 * Order is preserved, so a rewrite does not move the line someone was looking
 * at.
 */
export function readHeader(description: string | null | undefined): HeaderEntries {
  const block = BLOCK.exec(description ?? "");
  if (!block) return {};

  const entries: HeaderEntries = {};
  for (const line of block[1].split("\n")) {
    const match = ENTRY.exec(line);
    if (!match) continue;
    const [, name, value] = match;
    if (value !== "") entries[name] = unlink(value);
  }
  return entries;
}

/** The body with the block removed, so callers can rebuild it. */
export function stripHeader(description: string | null | undefined): string {
  return (description ?? "").replace(BLOCK, "").replace(/^\s+/, "");
}

/**
 * A description with `updates` merged into its block.
 *
 * Existing entries keep their position; new ones are appended. An empty value
 * removes an entry, so a worktree that has been folded can be cleared rather
 * than left pointing at a directory that is gone. When nothing is left, the
 * block goes with it — an empty block is noise.
 */
export function upsertHeader(
  description: string | null | undefined,
  updates: HeaderEntries,
): string {
  const merged: HeaderEntries = { ...readHeader(description) };
  for (const [name, value] of Object.entries(updates)) {
    if (value === "") delete merged[name];
    else merged[name] = value;
  }

  const body = stripHeader(description);
  const lines = Object.entries(merged).map(([name, value]) => `${name}: ${value}`);
  if (lines.length === 0) return body;

  return [BEGIN, ...lines, END, "", body].join("\n").trimEnd() + "\n";
}

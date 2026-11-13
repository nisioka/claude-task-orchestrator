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
 * The same rule applies to what the block replaces: writing a name into it
 * removes that name's old comment from the body, so the two can never disagree.
 *
 * A markdown link whose text differs from its URL is unsafe for the same
 * reason, so values go in bare. ClickUp normalises a bare URL to `[url](url)`
 * once and then leaves it alone; `readHeader` undoes that so a caller gets back
 * what it wrote.
 *
 * ClickUp also stores the block as markdown, so it backslash-escapes the
 * punctuation markdown would read as syntax: `a_b` comes back as `a\_b`, in a
 * name as well as in a value, and in the text of an auto-link but not in its
 * URL. `readHeader` undoes that too. Nothing here writes a backslash, so the
 * escapes are always ClickUp's.
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

/**
 * The comment form this block replaced, for one given name.
 *
 * Only ever removed, never written. Writing a name into the block has to take
 * the old comment with it: an entry that is deleted leaves nothing behind, so a
 * surviving `<!-- start-after: … -->` would quietly reinstate the reservation
 * that was just cancelled — and while both are present, every save compounds
 * the escaping damage the block exists to avoid.
 */
function legacyComment(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<!--[ \\t]*${escaped}[ \\t]*:[\\s\\S]*?-->[ \\t]*\\n?`, "gi");
}

/**
 * `[text](url)`, the shape ClickUp gives a bare URL.
 *
 * Only a link whose text, once unescaped, is its own URL is ClickUp's work;
 * anything else is read as plain text.
 */
const LINK = /^\[(.+)\]\((.+)\)$/;

/** A backslash before ASCII punctuation: a markdown escape. */
const ESCAPE = /\\([!-\/:-@[-`{-~])/g;

export type HeaderEntries = Record<string, string>;

/** Undoes markdown's backslash escapes, so `a\_b` reads back as `a_b`. */
function unescapeMarkdown(text: string): string {
  return text.replace(ESCAPE, "$1");
}

/**
 * Undoes what ClickUp does to a value on save — auto-linking and escaping — so
 * it reads back as it was written.
 */
function restore(value: string): string {
  const link = LINK.exec(value);
  if (link) {
    const [, text, url] = link;
    if (unescapeMarkdown(text) === unescapeMarkdown(url)) return unescapeMarkdown(url);
  }
  return unescapeMarkdown(value);
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
    if (value !== "") entries[unescapeMarkdown(name)] = restore(value);
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
 *
 * Every name written here also loses its old `<!-- name: … -->` comment from the
 * body, so the block is the only place that name is answered from.
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

  let body = stripHeader(description);
  for (const name of Object.keys(updates)) body = body.replace(legacyComment(name), "");
  body = body.replace(/^\s+/, "");

  const lines = Object.entries(merged).map(([name, value]) => `${name}: ${value}`);
  if (lines.length === 0) return body;

  return [BEGIN, ...lines, END, "", body].join("\n").trimEnd() + "\n";
}

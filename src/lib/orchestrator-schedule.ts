/**
 * "start-after" scheduling marker.
 *
 * A ticket can defer its own dispatch by carrying an entry in the block at the
 * top of its description:
 *
 *   orchestrator:begin
 *   start-after: 2026-08-12T14:00
 *   orchestrator:end
 *
 * The orchestrator treats a `Todo` issue whose start-after is still in the
 * future as not-yet-dispatchable, and picks it up on the first patrol at or
 * after the time. Strictness is deliberately not guaranteed — "at or after" is
 * the whole contract, so a delay of up to one patrol interval is expected and
 * fine.
 *
 * It lives in the description, not in a field or a label: Linear's due date is
 * date-only (no time of day), labels are reserved for classification and cannot
 * carry a value (requirement 3.10), and per-issue custom fields are metered on
 * ClickUp's free plan. The description is also what the orchestrator already
 * reads.
 *
 * The older `<!-- start-after: … -->` comment is still read, so a ticket written
 * before the block existed keeps its reservation, but nothing writes one any
 * more: an HTML comment sharing a description with a URL makes ClickUp corrupt
 * both on every save (see `tasks/header.ts`).
 *
 * A missing timezone offset is read as JST, because the human who writes the
 * marker thinks in JST (requirement 11). An explicit offset is honoured as
 * written. A value that does not parse is reported as `invalid` rather than
 * silently ignored, so the orchestrator can hand the issue back to the human
 * instead of dispatching it at the wrong time (or never).
 */

import { readHeader } from "./tasks/header.js";

/** JST. Applied when the marker omits an offset. */
const JST_OFFSET = "+09:00";

/** The entry name in the block. */
const START_AFTER_KEY = "start-after";

/** The older comment form. Read only. First occurrence wins. */
const LEGACY_MARKER = /<!--\s*start-after:\s*(.+?)\s*-->/i;

/**
 * Structured datetime: `YYYY-MM-DD`, optional `THH:MM[:SS]` (space accepted in
 * place of `T`), optional offset (`Z`, `+09:00`, `+0900`). Natural language is
 * intentionally not accepted — it falls through to `invalid` so the human is
 * asked rather than guessed at.
 */
const DATETIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(:\d{2})?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

export type StartAfter =
  | { kind: "none" }
  | { kind: "scheduled"; at: Date; raw: string }
  | { kind: "invalid"; raw: string };

/**
 * Parse the start-after value out of an issue description.
 *
 * Returns `none` when there is no marker at all, `scheduled` with the resolved
 * instant when the value parses, and `invalid` (carrying the offending text)
 * when a marker is present but its value cannot be understood.
 */
export function parseStartAfter(description: string | null | undefined): StartAfter {
  if (!description) return { kind: "none" };

  const raw = (readHeader(description)[START_AFTER_KEY] ?? LEGACY_MARKER.exec(description)?.[1] ?? "")
    .trim();
  if (raw === "") return { kind: "none" };

  const at = parseDateTime(raw);
  if (!at) return { kind: "invalid", raw };
  return { kind: "scheduled", at, raw };
}

function parseDateTime(value: string): Date | null {
  const match = DATETIME_PATTERN.exec(value);
  if (!match) return null;

  const date = match[1];
  const time = match[2] ?? "00:00";
  const seconds = match[3] ?? ":00";
  const offset = normalizeOffset(match[4]);

  // The ISO parser rejects out-of-range fields (month 13, hour 25) by returning
  // NaN, but it silently *rolls over* a non-existent day — "2026-02-30" becomes
  // March 2 rather than an error. Validate the calendar date ourselves so such
  // a typo is reported as invalid (and handed back) instead of firing two days
  // late.
  if (!isRealCalendarDate(date)) return null;

  const parsed = new Date(`${date}T${time}${seconds}${offset}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** True when `YYYY-MM-DD` names a day that actually exists (rejects Feb 30). */
function isRealCalendarDate(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number);
  // UTC to keep the check offset-independent; only the calendar date matters.
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** No offset → JST. `+0900` → `+09:00`. `Z` is left as-is. */
function normalizeOffset(offset: string | undefined): string {
  if (!offset) return JST_OFFSET;
  if (offset === "Z") return "Z";
  if (/^[+-]\d{4}$/.test(offset)) return `${offset.slice(0, 3)}:${offset.slice(3)}`;
  return offset;
}

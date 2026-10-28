/**
 * A one-line marker each job run writes to its log, so a line further down can
 * be dated by the nearest marker above it.
 *
 * Jobs print without timestamps, and cron appends every run to the same file.
 * Without a marker, an error from days ago and one from the last run read the
 * same.
 *
 * Written to stderr, and only when stderr is not a terminal: cron redirects it
 * into the log, a person at the terminal does not need it, and a caller that
 * reads stdout (the patrol gate prints exactly one line there) is unaffected.
 */

const MARKER = "==== run";

export function formatRunMarker(job: string, at: Date): string {
  return `${MARKER} ${localIso(at)} ${job} ====`;
}

/** The run's start time, or `null` when the line is not a marker. */
export function parseRunMarker(line: string): { at: string; job: string } | null {
  const m = line.match(/^==== run (\S+) (\S+) ====$/);
  if (!m) return null;
  const at = new Date(m[1]);
  return Number.isNaN(at.getTime()) ? null : { at: at.toISOString(), job: m[2] };
}

export function writeRunMarker(job: string, at = new Date()): void {
  if (process.stderr.isTTY) return;
  process.stderr.write(`${formatRunMarker(job, at)}\n`);
}

/** ISO 8601 in the machine's own offset, so the log reads in local time. */
function localIso(at: Date): string {
  const offsetMinutes = -at.getTimezoneOffset();
  const local = new Date(at.getTime() + offsetMinutes * 60 * 1000).toISOString().slice(0, 19);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
}

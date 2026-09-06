import { open } from "node:fs/promises";

/**
 * How large a session's context has grown, read from its own transcript.
 *
 * Context size is the thing that decides what a session costs. Every turn
 * re-reads the whole context, so a session that has grown to 600k tokens pays
 * roughly fifteen times per turn what it paid at 40k — for the same work. The
 * spend of a long-lived session is therefore dominated by how big it got, not
 * by how much it produced.
 *
 * The daemon's own `tokens` field in `~/.claude/jobs/<id>/state.json` is not
 * that number: measured against three live sessions it reported 106k / 135k /
 * 77k where the billed context was 350k / 328k / 267k. Whatever it counts, it
 * is not what gets re-read each turn, so the transcript is the only honest
 * source. Only the tail is read, so the cost stays flat as the file grows.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface ContextSample {
  /** Timestamp of the assistant message this was measured from. */
  at: string;
  /** Tokens re-read on that turn: fresh input + cache writes + cache reads. */
  contextTokens: number;
}

export type ContextVerdict = "unknown" | "ok" | "over";

/** 256 KiB covers hundreds of turns; a single record never approaches it. */
const DEFAULT_TAIL_BYTES = 256 * 1024;

// ─── Pure parsing ───────────────────────────────────────────────────

/**
 * Take the last usage report out of a transcript tail.
 *
 * Reading from the end means the first line is usually cut mid-record, and a
 * transcript may carry entries this parser has never seen. Both degrade to
 * "skip the line": losing one sample costs a tick of accuracy, throwing would
 * cost the caller its whole report.
 */
export function parseContextSample(tail: string): ContextSample | null {
  const lines = tail.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"usage"')) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== "assistant") continue;

    const message = isRecord(entry.message) ? entry.message : null;
    const usage = message && isRecord(message.usage) ? message.usage : null;
    if (!usage) continue;

    const contextTokens =
      numberOf(usage.input_tokens) +
      numberOf(usage.cache_creation_input_tokens) +
      numberOf(usage.cache_read_input_tokens);
    if (contextTokens === 0) continue;

    const at = typeof entry.timestamp === "string" ? entry.timestamp : "";
    return { at, contextTokens };
  }

  return null;
}

/**
 * Judge a sample against a limit.
 *
 * An unreadable transcript is `unknown`, never `over`: a missing measurement
 * must not by itself end a healthy session.
 */
export function assessContext(
  sample: ContextSample | null,
  limitTokens: number | null,
): ContextVerdict {
  if (!sample) return "unknown";
  if (limitTokens === null) return "ok";
  return sample.contextTokens >= limitTokens ? "over" : "ok";
}

/** Human-facing rendering, e.g. `348k / 上限 400k`. */
export function formatContext(
  sample: ContextSample | null,
  limitTokens: number | null,
): string {
  if (!sample) return "不明";
  const size = `${Math.round(sample.contextTokens / 1000)}k`;
  return limitTokens === null ? size : `${size} / 上限 ${Math.round(limitTokens / 1000)}k`;
}

// ─── IO ─────────────────────────────────────────────────────────────

export async function readContextSample(
  transcriptPath: string,
  tailBytes: number = DEFAULT_TAIL_BYTES,
): Promise<ContextSample | null> {
  let handle;
  try {
    handle = await open(transcriptPath, "r");
  } catch {
    return null;
  }

  try {
    const { size } = await handle.stat();
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return parseContextSample(buffer.toString("utf-8"));
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

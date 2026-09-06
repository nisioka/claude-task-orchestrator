import { describe, it, expect } from "vitest";
import {
  assessContext,
  formatContext,
  parseContextSample,
  readContextSample,
} from "../session-context.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assistantLine(overrides: {
  at?: string;
  input?: number;
  cacheWrite?: number;
  cacheRead?: number;
  type?: string;
}): string {
  return JSON.stringify({
    type: overrides.type ?? "assistant",
    timestamp: overrides.at ?? "2026-08-24T00:00:00.000Z",
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: overrides.input ?? 2,
        cache_creation_input_tokens: overrides.cacheWrite ?? 0,
        cache_read_input_tokens: overrides.cacheRead ?? 0,
        output_tokens: 100,
      },
    },
  });
}

// ─── parseContextSample ─────────────────────────────────────────────

describe("parseContextSample", () => {
  it("sums everything the turn re-read, not just the fresh input", () => {
    const tail = assistantLine({ input: 2, cacheWrite: 19_148, cacheRead: 327_645 });

    expect(parseContextSample(tail)).toEqual({
      at: "2026-08-24T00:00:00.000Z",
      contextTokens: 346_795,
    });
  });

  it("takes the last sample, since context only grows", () => {
    const tail = [
      assistantLine({ at: "2026-08-24T00:00:00.000Z", cacheRead: 100_000 }),
      assistantLine({ at: "2026-08-24T01:00:00.000Z", cacheRead: 300_000 }),
    ].join("\n");

    expect(parseContextSample(tail)?.contextTokens).toBe(300_002);
  });

  it("skips the truncated first line a tail read produces", () => {
    const tail = ['ache_read_input_tokens":999}}', assistantLine({ cacheRead: 200_000 })].join("\n");

    expect(parseContextSample(tail)?.contextTokens).toBe(200_002);
  });

  it("ignores entries that are not assistant turns", () => {
    const tail = [
      assistantLine({ cacheRead: 200_000 }),
      assistantLine({ cacheRead: 900_000, type: "user" }),
    ].join("\n");

    expect(parseContextSample(tail)?.contextTokens).toBe(200_002);
  });

  it("returns null rather than throwing when there is no usable sample", () => {
    expect(parseContextSample("")).toBeNull();
    expect(parseContextSample("not json at all\n{}\n")).toBeNull();
  });
});

// ─── assessContext ──────────────────────────────────────────────────

describe("assessContext", () => {
  const sample = { at: "2026-08-24T00:00:00.000Z", contextTokens: 300_000 };

  it("reports over at the limit, not only past it", () => {
    expect(assessContext(sample, 300_000)).toBe("over");
  });

  it("reports ok below the limit", () => {
    expect(assessContext(sample, 400_000)).toBe("ok");
  });

  it("treats a missing measurement as unknown, never as over", () => {
    expect(assessContext(null, 100_000)).toBe("unknown");
  });

  it("treats a disabled limit as ok", () => {
    expect(assessContext(sample, null)).toBe("ok");
  });
});

// ─── formatContext ──────────────────────────────────────────────────

describe("formatContext", () => {
  it("renders the size against the limit", () => {
    expect(formatContext({ at: "", contextTokens: 348_400 }, 400_000)).toBe("348k / 上限 400k");
  });

  it("drops the limit when there is none", () => {
    expect(formatContext({ at: "", contextTokens: 348_400 }, null)).toBe("348k");
  });

  it("says so when there is no measurement", () => {
    expect(formatContext(null, 400_000)).toBe("不明");
  });
});

// ─── readContextSample ──────────────────────────────────────────────

describe("readContextSample", () => {
  it("reads only the tail, and still finds the last sample", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-context-"));
    const path = join(dir, "transcript.jsonl");
    const filler = Array.from({ length: 500 }, (_, i) =>
      assistantLine({ at: "2026-08-24T00:00:00.000Z", cacheRead: 1_000 + i }),
    );
    await writeFile(path, [...filler, assistantLine({ cacheRead: 640_000 })].join("\n"), "utf-8");

    const sample = await readContextSample(path, 4 * 1024);

    expect(sample?.contextTokens).toBe(640_002);
  });

  it("returns null for a transcript that is not there", async () => {
    expect(await readContextSample("/nonexistent/transcript.jsonl")).toBeNull();
  });
});

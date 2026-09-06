import { describe, it, expect } from "vitest";
import { parseStartAfter } from "../orchestrator-schedule.js";

describe("parseStartAfter", () => {
  it("returns none when there is no description", () => {
    expect(parseStartAfter(null)).toEqual({ kind: "none" });
    expect(parseStartAfter(undefined)).toEqual({ kind: "none" });
    expect(parseStartAfter("")).toEqual({ kind: "none" });
  });

  it("returns none when the description has no marker", () => {
    expect(parseStartAfter("ただの本文です。\n開始時刻は書かれていません。")).toEqual({
      kind: "none",
    });
  });

  it("reads a bare datetime as JST", () => {
    const result = parseStartAfter("<!-- start-after: 2026-08-12T14:00 -->");
    expect(result.kind).toBe("scheduled");
    if (result.kind !== "scheduled") throw new Error("expected scheduled");
    // 14:00 JST == 05:00 UTC
    expect(result.at.toISOString()).toBe("2026-08-12T05:00:00.000Z");
    expect(result.raw).toBe("2026-08-12T14:00");
  });

  it("accepts a space in place of T", () => {
    const result = parseStartAfter("<!-- start-after: 2026-08-12 14:00 -->");
    expect(result.kind).toBe("scheduled");
    if (result.kind !== "scheduled") throw new Error("expected scheduled");
    expect(result.at.toISOString()).toBe("2026-08-12T05:00:00.000Z");
  });

  it("accepts seconds", () => {
    const result = parseStartAfter("<!-- start-after: 2026-08-12T14:00:30 -->");
    expect(result.kind).toBe("scheduled");
    if (result.kind !== "scheduled") throw new Error("expected scheduled");
    expect(result.at.toISOString()).toBe("2026-08-12T05:00:30.000Z");
  });

  it("honours an explicit offset", () => {
    const withColon = parseStartAfter("<!-- start-after: 2026-08-12T14:00+09:00 -->");
    const withoutColon = parseStartAfter("<!-- start-after: 2026-08-12T14:00+0900 -->");
    const utc = parseStartAfter("<!-- start-after: 2026-08-12T05:00Z -->");
    for (const r of [withColon, withoutColon, utc]) {
      expect(r.kind).toBe("scheduled");
      if (r.kind !== "scheduled") throw new Error("expected scheduled");
      expect(r.at.toISOString()).toBe("2026-08-12T05:00:00.000Z");
    }
  });

  it("reads a date without a time as JST midnight", () => {
    const result = parseStartAfter("<!-- start-after: 2026-08-12 -->");
    expect(result.kind).toBe("scheduled");
    if (result.kind !== "scheduled") throw new Error("expected scheduled");
    // 00:00 JST on 08-12 == 15:00 UTC on 08-11
    expect(result.at.toISOString()).toBe("2026-08-11T15:00:00.000Z");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    const result = parseStartAfter("前書き\n<!--   START-AFTER:   2026-08-12T14:00   -->\n後書き");
    expect(result.kind).toBe("scheduled");
  });

  it("takes the first marker when several are present", () => {
    const result = parseStartAfter(
      "<!-- start-after: 2026-08-12T14:00 -->\n<!-- start-after: 2027-01-01T00:00 -->",
    );
    if (result.kind !== "scheduled") throw new Error("expected scheduled");
    expect(result.at.toISOString()).toBe("2026-08-12T05:00:00.000Z");
  });

  it("reports natural language as invalid", () => {
    const result = parseStartAfter("<!-- start-after: 明日の朝いちばん -->");
    expect(result).toEqual({ kind: "invalid", raw: "明日の朝いちばん" });
  });

  it("reports out-of-range components as invalid", () => {
    for (const value of ["2026-13-05T00:00", "2026-08-12T25:00", "2026-02-30T09:00"]) {
      const result = parseStartAfter(`<!-- start-after: ${value} -->`);
      expect(result.kind, value).toBe("invalid");
    }
  });

  it("reports a malformed value as invalid, preserving the raw text", () => {
    const result = parseStartAfter("<!-- start-after: 2026/08/12 14時 -->");
    expect(result).toEqual({ kind: "invalid", raw: "2026/08/12 14時" });
  });
});

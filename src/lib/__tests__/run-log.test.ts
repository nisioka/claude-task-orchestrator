import { describe, it, expect } from "vitest";
import { formatRunMarker, parseRunMarker } from "../run-log.js";

describe("run marker", () => {
  it("round-trips the start time and the job name", () => {
    const at = new Date("2026-10-28T03:00:05Z");
    const parsed = parseRunMarker(formatRunMarker("some-job", at));
    expect(parsed).toEqual({ at: "2026-10-28T03:00:05.000Z", job: "some-job" });
  });

  it("ignores ordinary lines", () => {
    expect(parseRunMarker("ジョブ実行エラー [x]: fetch failed")).toBeNull();
    expect(parseRunMarker("==== run not-a-date x ====")).toBeNull();
  });
});

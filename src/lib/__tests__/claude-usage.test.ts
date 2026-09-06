import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UsageResponse, IdleThresholds } from "../claude-usage.js";

// ─── Mocks ────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: (fn: unknown) => fn,
}));

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { getAccessToken, fetchUsage, evaluateIdle } from "../claude-usage.js";

const mockReadFile = vi.mocked(readFile);
const mockExecFile = vi.mocked(execFile);

// ─── Helpers ──────────────────────────────────────────────────────

function makeCredentials(overrides: {
  accessToken?: string;
  expiresAt?: number;
} = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: overrides.accessToken ?? "valid-token",
      refreshToken: "refresh-token",
      expiresAt: overrides.expiresAt ?? Date.now() + 3_600_000, // 1h from now
      scopes: ["user"],
      subscriptionType: "pro",
      rateLimitTier: "standard",
    },
  });
}

function makeUsageResponse(overrides: Partial<{
  fiveHourUtil: number;
  sevenDayUtil: number;
  resetsAt: string;
}>): UsageResponse {
  return {
    five_hour: {
      utilization: overrides.fiveHourUtil ?? 20,
      resets_at: overrides.resetsAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    seven_day: {
      utilization: overrides.sevenDayUtil ?? 30,
      resets_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

const defaultThresholds: IdleThresholds = {
  thresholdPercent: 50,
  highThresholdPercent: 80,
  soonResetMinutes: 30,
  weeklyCapPercent: 80,
};

// ─── getAccessToken ───────────────────────────────────────────────

describe("getAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns token when valid and not expired", async () => {
    mockReadFile.mockResolvedValueOnce(makeCredentials({
      accessToken: "my-valid-token",
      expiresAt: Date.now() + 3_600_000,
    }));

    const token = await getAccessToken("/fake/.credentials.json");

    expect(token).toBe("my-valid-token");
    expect(mockReadFile).toHaveBeenCalledOnce();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("triggers refresh when expired (calls claude CLI, re-reads file)", async () => {
    // First read: expired token
    mockReadFile.mockResolvedValueOnce(makeCredentials({
      accessToken: "expired-token",
      expiresAt: Date.now() - 1000, // expired
    }));

    // execFile mock (promisified, so it returns a promise directly)
    mockExecFile.mockResolvedValueOnce({ stdout: "ok", stderr: "" } as never);

    // Second read: refreshed token
    mockReadFile.mockResolvedValueOnce(makeCredentials({
      accessToken: "refreshed-token",
      expiresAt: Date.now() + 3_600_000,
    }));

    const token = await getAccessToken("/fake/.credentials.json");

    expect(token).toBe("refreshed-token");
    expect(mockExecFile).toHaveBeenCalledOnce();
    expect(mockExecFile).toHaveBeenCalledWith("claude", ["-p", "ok", "--print"], {
      timeout: 30_000,
    });
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it("throws when credentials file is missing", async () => {
    const err = new Error("ENOENT: no such file or directory");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    mockReadFile.mockRejectedValueOnce(err);

    await expect(getAccessToken("/fake/.credentials.json")).rejects.toThrow(
      "ENOENT",
    );
  });

  it("throws when token refresh fails", async () => {
    mockReadFile.mockResolvedValueOnce(makeCredentials({
      expiresAt: Date.now() - 1000,
    }));

    mockExecFile.mockRejectedValueOnce(new Error("CLI not found"));

    await expect(getAccessToken("/fake/.credentials.json")).rejects.toThrow(
      "トークンリフレッシュに失敗しました: CLI not found",
    );
  });

  it("throws when refreshed creds still invalid", async () => {
    // First read: expired
    mockReadFile.mockResolvedValueOnce(makeCredentials({
      expiresAt: Date.now() - 1000,
    }));

    // CLI succeeds
    mockExecFile.mockResolvedValueOnce({ stdout: "ok", stderr: "" } as never);

    // Second read: missing accessToken
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      claudeAiOauth: {
        refreshToken: "refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }));

    await expect(getAccessToken("/fake/.credentials.json")).rejects.toThrow(
      "リフレッシュ後のOAuth認証情報が見つかりません",
    );
  });
});

// ─── fetchUsage ───────────────────────────────────────────────────

describe("fetchUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns usage on successful API call", async () => {
    const usageData = makeUsageResponse({ fiveHourUtil: 25, sevenDayUtil: 40 });
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValueOnce(usageData),
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

    const result = await fetchUsage("test-token");

    expect(result.five_hour.utilization).toBe(25);
    expect(result.seven_day.utilization).toBe(40);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      {
        headers: {
          "Authorization": "Bearer test-token",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
    );
  });

  it("throws on non-200 response", async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

    await expect(fetchUsage("bad-token")).rejects.toThrow(
      "使用量API エラー: 401 Unauthorized",
    );
  });

  it("throws on invalid response shape", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValueOnce({ something: "else" }),
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

    await expect(fetchUsage("test-token")).rejects.toThrow(
      "使用量APIのレスポンス形式が不正です",
    );
  });

  it("throws on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Network error"),
    );

    await expect(fetchUsage("test-token")).rejects.toThrow("Network error");
  });
});

// ─── evaluateIdle ─────────────────────────────────────────────────

describe("evaluateIdle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("NOT idle when weekly cap exceeded", () => {
    const usage = makeUsageResponse({ fiveHourUtil: 30, sevenDayUtil: 80 });
    const result = evaluateIdle(usage, defaultThresholds);

    expect(result.idle).toBe(false);
    expect(result.reason).toContain("週間使用率が上限超過");
    expect(result.sevenDayUtilization).toBe(80);
  });

  it("idle when 5h utilization below threshold (genuinely idle)", () => {
    const usage = makeUsageResponse({ fiveHourUtil: 30, sevenDayUtil: 40 });
    const result = evaluateIdle(usage, defaultThresholds);

    expect(result.idle).toBe(true);
    expect(result.reason).toContain("アイドル状態");
    expect(result.fiveHourUtilization).toBe(30);
  });

  it("idle when utilization < highThreshold AND remaining < soonResetMinutes", () => {
    const resetsAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min from now
    const usage = makeUsageResponse({
      fiveHourUtil: 60, // above threshold (50) but below highThreshold (80)
      sevenDayUtil: 40,
      resetsAt,
    });

    const result = evaluateIdle(usage, defaultThresholds);

    expect(result.idle).toBe(true);
    expect(result.reason).toContain("もうすぐリセット");
    expect(result.resetMinutesRemaining).toBe(15);
  });

  it("NOT idle when none of the conditions met", () => {
    const resetsAt = new Date(Date.now() + 120 * 60 * 1000).toISOString(); // 2h from now
    const usage = makeUsageResponse({
      fiveHourUtil: 60, // above threshold
      sevenDayUtil: 40, // below weekly cap
      resetsAt, // far from reset
    });

    const result = evaluateIdle(usage, defaultThresholds);

    expect(result.idle).toBe(false);
    expect(result.reason).toContain("使用中");
  });

  it("boundary: exactly at threshold is NOT idle (uses strict <)", () => {
    const usage = makeUsageResponse({ fiveHourUtil: 50, sevenDayUtil: 40 });
    const result = evaluateIdle(usage, defaultThresholds);

    // fiveHourUtil (50) is NOT < thresholdPercent (50), so not genuinely idle
    // fiveHourUtil (50) IS < highThresholdPercent (80), but reset is far away
    expect(result.idle).toBe(false);
    expect(result.reason).toContain("使用中");
  });

  it("boundary: exactly at weekly cap is NOT idle (uses >=)", () => {
    const usage = makeUsageResponse({ fiveHourUtil: 10, sevenDayUtil: 80 });
    const result = evaluateIdle(usage, defaultThresholds);

    expect(result.idle).toBe(false);
    expect(result.reason).toContain("週間使用率が上限超過");
  });
});

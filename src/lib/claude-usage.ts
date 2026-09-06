import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────

export interface UsageBucket {
  utilization: number;
  resets_at: string;
}

export interface UsageResponse {
  five_hour: UsageBucket;
  seven_day: UsageBucket;
}

interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

interface CredentialsFile {
  claudeAiOauth: ClaudeOAuthCredentials;
}

export interface IdleThresholds {
  thresholdPercent: number;
  highThresholdPercent: number;
  soonResetMinutes: number;
  weeklyCapPercent: number;
}

export interface IdleCheckResult {
  idle: boolean;
  reason: string;
  fiveHourUtilization: number;
  sevenDayUtilization: number;
  resetMinutesRemaining: number;
}

// ─── Constants ────────────────────────────────────────────────────

const CREDENTIALS_PATH = resolve(homedir(), ".claude/.credentials.json");
const USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;

// ─── Public Functions ─────────────────────────────────────────────

export async function getAccessToken(credentialsPath = CREDENTIALS_PATH): Promise<string> {
  const content = await readFile(credentialsPath, "utf-8");
  const creds: CredentialsFile = JSON.parse(content);

  if (!creds.claudeAiOauth?.accessToken) {
    throw new Error("OAuth認証情報が見つかりません: claudeAiOauth.accessToken");
  }

  if (creds.claudeAiOauth.expiresAt < Date.now()) {
    // Token expired, trigger refresh via Claude Code CLI
    try {
      await execFileAsync("claude", ["-p", "ok", "--print"], {
        timeout: TOKEN_REFRESH_TIMEOUT_MS,
      });
    } catch (err) {
      throw new Error(`トークンリフレッシュに失敗しました: ${(err as Error).message}`);
    }

    // Re-read credentials after refresh
    const refreshedContent = await readFile(credentialsPath, "utf-8");
    const refreshedCreds: CredentialsFile = JSON.parse(refreshedContent);

    if (!refreshedCreds.claudeAiOauth?.accessToken) {
      throw new Error("リフレッシュ後のOAuth認証情報が見つかりません");
    }

    return refreshedCreds.claudeAiOauth.accessToken;
  }

  return creds.claudeAiOauth.accessToken;
}

export async function fetchUsage(accessToken: string): Promise<UsageResponse> {
  const response = await fetch(USAGE_API_URL, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });

  if (!response.ok) {
    throw new Error(`使用量API エラー: ${response.status} ${response.statusText}`);
  }

  const data: unknown = await response.json();
  const usage = data as UsageResponse;

  if (!usage.five_hour || !usage.seven_day) {
    throw new Error("使用量APIのレスポンス形式が不正です");
  }

  return usage;
}

export function evaluateIdle(
  usage: UsageResponse,
  thresholds: IdleThresholds,
): IdleCheckResult {
  const fiveHourUtil = usage.five_hour.utilization;
  const sevenDayUtil = usage.seven_day.utilization;
  const resetTime = new Date(usage.five_hour.resets_at).getTime();
  const now = Date.now();
  const remainingMinutes = Math.max(0, (resetTime - now) / (60 * 1000));

  const base = {
    fiveHourUtilization: fiveHourUtil,
    sevenDayUtilization: sevenDayUtil,
    resetMinutesRemaining: Math.round(remainingMinutes),
  };

  // Safety cap: weekly utilization check
  if (sevenDayUtil >= thresholds.weeklyCapPercent) {
    return {
      ...base,
      idle: false,
      reason: `週間使用率が上限超過 (${sevenDayUtil}% >= ${thresholds.weeklyCapPercent}%)`,
    };
  }

  // Genuinely idle
  if (fiveHourUtil < thresholds.thresholdPercent) {
    return {
      ...base,
      idle: true,
      reason: `アイドル状態 (5時間使用率: ${fiveHourUtil}% < ${thresholds.thresholdPercent}%)`,
    };
  }

  // Busy but about to reset
  if (fiveHourUtil < thresholds.highThresholdPercent && remainingMinutes < thresholds.soonResetMinutes) {
    return {
      ...base,
      idle: true,
      reason: `もうすぐリセット (使用率: ${fiveHourUtil}%, リセットまで: ${Math.round(remainingMinutes)}分)`,
    };
  }

  // Not idle
  return {
    ...base,
    idle: false,
    reason: `使用中 (5時間使用率: ${fiveHourUtil}%)`,
  };
}

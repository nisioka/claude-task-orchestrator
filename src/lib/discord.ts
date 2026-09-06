import type { DiscordPayload } from "./types.js";

const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendDiscordMessage(
  webhookUrl: string,
  payload: DiscordPayload,
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Success
    if (response.ok) {
      return;
    }

    // Client errors that should not be retried
    if ([400, 401, 403, 404].includes(response.status)) {
      const errorBody = await response.text();
      throw new Error(
        `Discord API error ${response.status}: ${errorBody}`,
      );
    }

    // Rate limited - retry with backoff
    if (response.status === 429) {
      const body = (await response.json()) as { retry_after?: number };
      const retryAfter = body.retry_after ?? 1;
      lastError = new Error(
        `Discord API rate limited (429). retry_after=${retryAfter}s`,
      );

      if (attempt < MAX_RETRIES - 1) {
        await sleep(retryAfter * 1000);
        continue;
      }
      // Last attempt exhausted — will throw lastError after the loop
      continue;
    }

    // Server errors (5xx) - retry with exponential backoff
    if (response.status >= 500) {
      const errorBody = await response.text();
      lastError = new Error(
        `Discord API error ${response.status}: ${errorBody}`,
      );
      if (attempt < MAX_RETRIES - 1) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      continue;
    }

    // Other errors
    const errorBody = await response.text();
    lastError = new Error(
      `Discord API error ${response.status}: ${errorBody}`,
    );
  }

  throw lastError ?? new Error("sendDiscordMessage failed after retries");
}

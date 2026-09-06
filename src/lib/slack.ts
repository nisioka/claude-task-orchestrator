import type { DiscordPayload } from "./types.js";

// ─── Block Kit Types ────────────────────────────────────────────────

export interface SlackTextObject {
  type: "plain_text" | "mrkdwn";
  text: string;
}

export interface SlackBlock {
  type: "header" | "section" | "context" | "divider";
  text?: SlackTextObject;
  elements?: SlackTextObject[];
}

export interface SlackPayload {
  blocks: SlackBlock[];
}

/** Convert Discord markdown links `[text](url)` to Slack mrkdwn `<url|text>` */
export function convertLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>");
}

/** Convert markdown unordered list markers `- ` to Slack bullet `• ` */
export function convertLists(text: string): string {
  return text.replace(/^- /gm, "• ");
}

// Section text has a 3000 char limit in Block Kit
const SECTION_TEXT_LIMIT = 3000;

/**
 * Convert Discord embed payload to Slack Block Kit payload.
 * Uses header, section, and context blocks for proper mrkdwn rendering.
 */
export function convertDiscordToSlack(payload: DiscordPayload): SlackPayload {
  const blocks: SlackBlock[] = [];

  for (const embed of payload.embeds ?? []) {
    // Title → header block
    if (embed.title) {
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: embed.title },
      });
    }

    // Description → section block
    if (embed.description) {
      const converted = convertLists(convertLinks(embed.description));
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: truncateSection(converted) },
      });
    }

    // Fields → each field becomes a section block with bold header
    if (embed.fields) {
      for (const f of embed.fields) {
        const converted = convertLists(convertLinks(f.value));
        const fieldText = `*${f.name}*\n${converted}`;
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: truncateSection(fieldText) },
        });
      }
    }

    // Footer → context block
    if (embed.footer) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: embed.footer.text }],
      });
    }
  }

  return { blocks };
}

function truncateSection(text: string, max = SECTION_TEXT_LIMIT): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

// ─── HTTP ───────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendSlackMessage(
  webhookUrl: string,
  payload: SlackPayload,
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return;
    }

    if ([400, 401, 403, 404].includes(response.status)) {
      const errorBody = await response.text();
      throw new Error(
        `Slack API error ${response.status}: ${errorBody}`,
      );
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After")) || 1;
      lastError = new Error(
        `Slack API rate limited (429). retry_after=${retryAfter}s`,
      );

      if (attempt < MAX_RETRIES - 1) {
        await sleep(retryAfter * 1000);
        continue;
      }
      continue;
    }

    if (response.status >= 500) {
      const errorBody = await response.text();
      lastError = new Error(
        `Slack API error ${response.status}: ${errorBody}`,
      );
      if (attempt < MAX_RETRIES - 1) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      continue;
    }

    const errorBody = await response.text();
    lastError = new Error(
      `Slack API error ${response.status}: ${errorBody}`,
    );
  }

  throw lastError ?? new Error("sendSlackMessage failed after retries");
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { convertDiscordToSlack, convertLinks, convertLists, sendSlackMessage } from "../slack.js";
import type { DiscordPayload } from "../types.js";
import type { SlackPayload } from "../slack.js";

describe("convertLinks", () => {
  it("converts [text](url) to <url|text>", () => {
    expect(convertLinks("[ENG-42](https://linear.app/issue/ENG-42)")).toBe(
      "<https://linear.app/issue/ENG-42|ENG-42>",
    );
  });

  it("converts multiple links in same text", () => {
    const input = "[A](https://a.com) and [B](https://b.com)";
    expect(convertLinks(input)).toBe("<https://a.com|A> and <https://b.com|B>");
  });

  it("does not convert non-URL patterns", () => {
    expect(convertLinks("[Bug](v2)")).toBe("[Bug](v2)");
  });

  it("preserves text around links", () => {
    expect(convertLinks("See [link](https://example.com) for details")).toBe(
      "See <https://example.com|link> for details",
    );
  });
});

describe("convertLists", () => {
  it("converts '- ' at line start to '• '", () => {
    expect(convertLists("- item 1\n- item 2")).toBe("• item 1\n• item 2");
  });

  it("does not convert hyphens mid-line", () => {
    expect(convertLists("some - text")).toBe("some - text");
  });

  it("converts first line too", () => {
    expect(convertLists("- first")).toBe("• first");
  });
});

describe("convertDiscordToSlack", () => {
  it("converts embed title to header block", () => {
    const discord: DiscordPayload = {
      embeds: [{ title: "Test Title" }],
    };
    const slack = convertDiscordToSlack(discord);

    expect(slack.blocks).toHaveLength(1);
    expect(slack.blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Test Title" },
    });
  });

  it("converts embed description to section block with mrkdwn", () => {
    const discord: DiscordPayload = {
      embeds: [{ description: "Some description" }],
    };
    const slack = convertDiscordToSlack(discord);

    expect(slack.blocks).toHaveLength(1);
    expect(slack.blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "Some description" },
    });
  });

  it("converts embed description links to Slack mrkdwn format", () => {
    const discord: DiscordPayload = {
      embeds: [{
        description: "Check [Linear で開く](https://linear.app/issue/PERS-1) for details",
      }],
    };
    const slack = convertDiscordToSlack(discord);

    expect(slack.blocks[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Check <https://linear.app/issue/PERS-1|Linear で開く> for details",
      },
    });
  });

  it("converts embed fields to section blocks with bold headers and bullet lists", () => {
    const discord: DiscordPayload = {
      embeds: [{
        fields: [
          { name: "Done", value: "- task 1\n- task 2", inline: false },
          { name: "Doing", value: "- task 3", inline: true },
        ],
      }],
    };
    const slack = convertDiscordToSlack(discord);

    expect(slack.blocks).toHaveLength(2);
    expect(slack.blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*Done*\n• task 1\n• task 2" },
    });
    expect(slack.blocks[1]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*Doing*\n• task 3" },
    });
  });

  it("converts links and list markers in field values to Slack mrkdwn format", () => {
    const discord: DiscordPayload = {
      embeds: [{
        fields: [
          { name: "Done", value: "- [ENG-42](https://linear.app/issue/ENG-42): Some task" },
        ],
      }],
    };
    const slack = convertDiscordToSlack(discord);

    expect(slack.blocks[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Done*\n• <https://linear.app/issue/ENG-42|ENG-42>: Some task",
      },
    });
  });

  it("converts embed footer to context block", () => {
    const discord: DiscordPayload = {
      embeds: [{ footer: { text: "Footer text" } }],
    };
    const slack = convertDiscordToSlack(discord);

    expect(slack.blocks).toHaveLength(1);
    expect(slack.blocks[0]).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Footer text" }],
    });
  });

  it("handles full embed with title, description, fields, and footer", () => {
    const discord: DiscordPayload = {
      embeds: [{
        title: "\u23F0 Wait リマインダー",
        description: "概要テキスト",
        fields: [
          {
            name: "[Work] PERS-10",
            value: "Waiting\n期限: 2/20 · [Linear で開く](https://linear.app/workspace/issue/PERS-10)",
            inline: false,
          },
        ],
        footer: { text: "チェック時刻: 09:00" },
      }],
    };
    const slack = convertDiscordToSlack(discord);

    expect(slack.blocks).toHaveLength(4);
    expect(slack.blocks[0].type).toBe("header");
    expect(slack.blocks[0].text!.text).toBe("\u23F0 Wait リマインダー");
    expect(slack.blocks[1].type).toBe("section");
    expect(slack.blocks[1].text!.text).toBe("概要テキスト");
    expect(slack.blocks[2].type).toBe("section");
    expect(slack.blocks[2].text!.text).toContain("<https://linear.app/workspace/issue/PERS-10|Linear で開く>");
    expect(slack.blocks[3].type).toBe("context");
    expect(slack.blocks[3].elements![0].text).toBe("チェック時刻: 09:00");
  });

  it("handles multiple embeds", () => {
    const discord: DiscordPayload = {
      embeds: [
        { title: "Embed 1" },
        { title: "Embed 2" },
      ],
    };
    const slack = convertDiscordToSlack(discord);

    expect(slack.blocks).toHaveLength(2);
    expect(slack.blocks[0].text!.text).toBe("Embed 1");
    expect(slack.blocks[1].text!.text).toBe("Embed 2");
  });

  it("returns empty blocks when no embeds", () => {
    const discord: DiscordPayload = { content: "text only" };
    const slack = convertDiscordToSlack(discord);

    expect(slack.blocks).toEqual([]);
  });

  it("truncates section text exceeding 3000 chars", () => {
    const longText = "x".repeat(3500);
    const discord: DiscordPayload = {
      embeds: [{ description: longText }],
    };
    const slack = convertDiscordToSlack(discord);

    expect(slack.blocks[0].text!.text.length).toBeLessThanOrEqual(3000);
    expect(slack.blocks[0].text!.text.endsWith("...")).toBe(true);
  });
});

describe("sendSlackMessage", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct POST request with JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const webhookUrl = "https://hooks.slack.com/services/T/B/xxx";
    const payload: SlackPayload = {
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Test" } }],
    };

    await sendSlackMessage(webhookUrl, payload);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  });

  it("throws on 400 response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "invalid_payload",
    });

    const webhookUrl = "https://hooks.slack.com/services/T/B/xxx";
    const payload: SlackPayload = { blocks: [] };

    await expect(sendSlackMessage(webhookUrl, payload)).rejects.toThrow(
      "Slack API error 400",
    );
  });

  it("retries on 429 with Retry-After header, then succeeds", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "0.01" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const webhookUrl = "https://hooks.slack.com/services/T/B/xxx";
    const payload: SlackPayload = { blocks: [] };

    await expect(sendSlackMessage(webhookUrl, payload)).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 server error with exponential backoff, then succeeds", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const webhookUrl = "https://hooks.slack.com/services/T/B/xxx";
    const payload: SlackPayload = { blocks: [] };

    await expect(sendSlackMessage(webhookUrl, payload)).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after 3 failed retries on 500", async () => {
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });
    }

    const webhookUrl = "https://hooks.slack.com/services/T/B/xxx";
    const payload: SlackPayload = { blocks: [] };

    await expect(sendSlackMessage(webhookUrl, payload)).rejects.toThrow(
      "Slack API error 500",
    );
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws after 3 failed retries on 429", async () => {
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "0.01" }),
      });
    }

    const webhookUrl = "https://hooks.slack.com/services/T/B/xxx";
    const payload: SlackPayload = { blocks: [] };

    await expect(sendSlackMessage(webhookUrl, payload)).rejects.toThrow("429");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

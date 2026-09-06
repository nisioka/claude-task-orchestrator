import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendDiscordMessage } from "../discord.js";
import type { DiscordPayload } from "../types.js";

describe("sendDiscordMessage", () => {
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

    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    const payload: DiscordPayload = {
      content: "Hello, Discord!",
      username: "Task Bot",
      embeds: [{ title: "Test Embed" }],
    };

    await sendDiscordMessage(webhookUrl, payload);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  });

  it("succeeds on 204 response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
    });

    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    const payload: DiscordPayload = { content: "No content response" };

    await expect(
      sendDiscordMessage(webhookUrl, payload),
    ).resolves.toBeUndefined();
  });

  it("throws on 400 response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"message": "Bad Request"}',
    });

    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    const payload: DiscordPayload = { content: "Bad request" };

    await expect(sendDiscordMessage(webhookUrl, payload)).rejects.toThrow(
      "Discord API error 400",
    );
  });

  it("throws on 401 response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"message": "Unauthorized"}',
    });

    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    const payload: DiscordPayload = { content: "Unauthorized" };

    await expect(sendDiscordMessage(webhookUrl, payload)).rejects.toThrow(
      "Discord API error 401",
    );
  });

  it("retries on 429 with retry_after, then succeeds", async () => {
    // First call: rate limited
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ retry_after: 0.01 }),
    });
    // Second call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    const payload: DiscordPayload = { content: "Rate limited then OK" };

    await expect(
      sendDiscordMessage(webhookUrl, payload),
    ).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 server error with exponential backoff, then succeeds", async () => {
    // First call: server error
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    // Second call: success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    const payload: DiscordPayload = { content: "Server error then OK" };

    await expect(
      sendDiscordMessage(webhookUrl, payload),
    ).resolves.toBeUndefined();

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

    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    const payload: DiscordPayload = { content: "Always server error" };

    await expect(sendDiscordMessage(webhookUrl, payload)).rejects.toThrow(
      "Discord API error 500",
    );

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws after 3 failed retries on 429", async () => {
    // All 3 attempts: rate limited
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ retry_after: 0.01 }),
      });
    }

    const webhookUrl = "https://discord.com/api/webhooks/123/abc";
    const payload: DiscordPayload = { content: "Always rate limited" };

    await expect(sendDiscordMessage(webhookUrl, payload)).rejects.toThrow(
      "429",
    );

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

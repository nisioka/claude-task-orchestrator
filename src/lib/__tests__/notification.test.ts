import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DiscordPayload } from "../types.js";
import type { CoreConfig } from "../core-config.js";
import type { SlackPayload } from "../slack.js";

// ─── Mocks ──────────────────────────────────────────────────────────

const mockSendDiscordMessage = vi.fn<(url: string, payload: DiscordPayload) => Promise<void>>();
vi.mock("../discord.js", () => ({
  sendDiscordMessage: (...args: unknown[]) => mockSendDiscordMessage(...(args as [string, DiscordPayload])),
}));

const mockSendSlackMessage = vi.fn<(url: string, payload: SlackPayload) => Promise<void>>();
const mockConvertDiscordToSlack = vi.fn<(payload: DiscordPayload) => SlackPayload>();
vi.mock("../slack.js", () => ({
  sendSlackMessage: (...args: unknown[]) => mockSendSlackMessage(...(args as [string, SlackPayload])),
  convertDiscordToSlack: (...args: unknown[]) => mockConvertDiscordToSlack(...(args as [DiscordPayload])),
}));

// ─── Helpers ────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    taskSource: "linear" as const, taskSourceApiKey: "task_source_test",
    discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
    ...overrides,
  };
}

const samplePayload: DiscordPayload = {
  embeds: [{ title: "Test", color: 0x5865F2 }],
};

const sampleSlackPayload: SlackPayload = {
  blocks: [{ type: "header", text: { type: "plain_text", text: "Test" } }],
};

// ─── Tests ──────────────────────────────────────────────────────────

describe("sendNotifications", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSendDiscordMessage.mockReset();
    mockSendSlackMessage.mockReset();
    mockConvertDiscordToSlack.mockReset();
    mockSendDiscordMessage.mockResolvedValue(undefined);
    mockSendSlackMessage.mockResolvedValue(undefined);
    mockConvertDiscordToSlack.mockReturnValue(sampleSlackPayload);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("sends Discord only when Discord succeeds (Slack not called even if configured)", async () => {
    const config = makeConfig({ slackWebhookUrl: "https://hooks.slack.com/services/T/B/xxx" });
    const { sendNotifications } = await import("../notification.js");

    await sendNotifications(config, samplePayload);

    expect(mockSendDiscordMessage).toHaveBeenCalledOnce();
    expect(mockSendDiscordMessage).toHaveBeenCalledWith(config.discordWebhookUrl, samplePayload);
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it("sends Discord only when Slack is not configured", async () => {
    const config = makeConfig();
    const { sendNotifications } = await import("../notification.js");

    await sendNotifications(config, samplePayload);

    expect(mockSendDiscordMessage).toHaveBeenCalledOnce();
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it("falls back to Slack when Discord fails", async () => {
    mockSendDiscordMessage.mockRejectedValueOnce(new Error("Discord down"));
    const config = makeConfig({ slackWebhookUrl: "https://hooks.slack.com/services/T/B/xxx" });
    const { sendNotifications } = await import("../notification.js");

    await sendNotifications(config, samplePayload);

    expect(mockSendDiscordMessage).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Discord notification failed, falling back to Slack:",
      expect.any(Error),
    );
    expect(mockConvertDiscordToSlack).toHaveBeenCalledWith(samplePayload);
    expect(mockSendSlackMessage).toHaveBeenCalledOnce();
    expect(mockSendSlackMessage).toHaveBeenCalledWith(config.slackWebhookUrl, sampleSlackPayload);
  });

  it("sends Slack when Discord is not configured", async () => {
    const config = makeConfig({ discordWebhookUrl: undefined, slackWebhookUrl: "https://hooks.slack.com/services/T/B/xxx" });
    const { sendNotifications } = await import("../notification.js");

    await sendNotifications(config, samplePayload);

    expect(mockSendDiscordMessage).not.toHaveBeenCalled();
    expect(mockConvertDiscordToSlack).toHaveBeenCalledWith(samplePayload);
    expect(mockSendSlackMessage).toHaveBeenCalledOnce();
  });

  it("throws when Discord fails and Slack is not configured", async () => {
    mockSendDiscordMessage.mockRejectedValueOnce(new Error("Discord down"));
    const config = makeConfig();
    const { sendNotifications } = await import("../notification.js");

    await expect(sendNotifications(config, samplePayload)).rejects.toThrow(
      "通知の送信に失敗しました: 利用可能な通知チャンネルがありません",
    );
  });

  it("throws when Discord is not configured and Slack is not configured", async () => {
    const config = makeConfig({ discordWebhookUrl: undefined });
    const { sendNotifications } = await import("../notification.js");

    await expect(sendNotifications(config, samplePayload)).rejects.toThrow(
      "通知の送信に失敗しました: 利用可能な通知チャンネルがありません",
    );
  });

  it("propagates Slack error when it is the fallback and fails", async () => {
    mockSendDiscordMessage.mockRejectedValueOnce(new Error("Discord down"));
    mockSendSlackMessage.mockRejectedValueOnce(new Error("Slack also down"));
    const config = makeConfig({ slackWebhookUrl: "https://hooks.slack.com/services/T/B/xxx" });
    const { sendNotifications } = await import("../notification.js");

    await expect(sendNotifications(config, samplePayload)).rejects.toThrow("Slack also down");
  });
});

describe("sendErrorNotifications", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSendDiscordMessage.mockReset();
    mockSendSlackMessage.mockReset();
    mockConvertDiscordToSlack.mockReset();
    mockSendDiscordMessage.mockResolvedValue(undefined);
    mockSendSlackMessage.mockResolvedValue(undefined);
    mockConvertDiscordToSlack.mockReturnValue(sampleSlackPayload);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("sends Discord error notification only when Discord succeeds", async () => {
    const config = makeConfig({ slackWebhookUrl: "https://hooks.slack.com/services/T/B/xxx" });
    const { sendErrorNotifications } = await import("../notification.js");

    await sendErrorNotifications(config, "wait-reminder", new Error("fail"));

    expect(mockSendDiscordMessage).toHaveBeenCalledOnce();
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it("falls back to Slack when Discord fails", async () => {
    mockSendDiscordMessage.mockRejectedValueOnce(new Error("Discord 400"));
    const config = makeConfig({ slackWebhookUrl: "https://hooks.slack.com/services/T/B/xxx" });
    const { sendErrorNotifications } = await import("../notification.js");

    await sendErrorNotifications(config, "progress-report", new Error("original"));

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(mockSendSlackMessage).toHaveBeenCalledOnce();
  });

  it("sends Slack when Discord is not configured", async () => {
    const config = makeConfig({ discordWebhookUrl: undefined, slackWebhookUrl: "https://hooks.slack.com/services/T/B/xxx" });
    const { sendErrorNotifications } = await import("../notification.js");

    await sendErrorNotifications(config, "work-digest", new Error("test error"));

    expect(mockSendDiscordMessage).not.toHaveBeenCalled();
    expect(mockSendSlackMessage).toHaveBeenCalledOnce();
  });

  it("does not throw when both Discord and Slack fail", async () => {
    mockSendDiscordMessage.mockRejectedValueOnce(new Error("Discord down"));
    mockSendSlackMessage.mockRejectedValueOnce(new Error("Slack down"));
    const config = makeConfig({ slackWebhookUrl: "https://hooks.slack.com/services/T/B/xxx" });
    const { sendErrorNotifications } = await import("../notification.js");

    await expect(
      sendErrorNotifications(config, "wait-reminder", new Error("original")),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
  });

  it("does not throw when Discord fails and Slack is not configured", async () => {
    mockSendDiscordMessage.mockRejectedValueOnce(new Error("Discord down"));
    const config = makeConfig();
    const { sendErrorNotifications } = await import("../notification.js");

    await expect(
      sendErrorNotifications(config, "wait-reminder", new Error("original")),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("includes job name and error message in Discord payload", async () => {
    const config = makeConfig();
    const { sendErrorNotifications } = await import("../notification.js");

    await sendErrorNotifications(config, "wait-reminder", new Error("Something broke"));

    const [, payload] = mockSendDiscordMessage.mock.calls[0] as [string, DiscordPayload];
    expect(payload.embeds![0].title).toContain("wait-reminder");
    expect(payload.embeds![0].description).toBe("Something broke");
    expect(payload.embeds![0].color).toBe(0xff4444);
  });
});

import type { CoreConfig } from "./core-config.js";
import type { DiscordPayload } from "./types.js";
import { sendDiscordMessage } from "./discord.js";
import { convertDiscordToSlack, sendSlackMessage } from "./slack.js";

/**
 * Discord優先で通知を送信する。
 * Discord成功 → 完了（Slackには送らない）
 * Discord失敗 or 未設定 → Slackにフォールバック
 */
export async function sendNotifications(
  config: CoreConfig,
  discordPayload: DiscordPayload,
): Promise<void> {
  if (config.discordWebhookUrl) {
    try {
      await sendDiscordMessage(config.discordWebhookUrl, discordPayload);
      return; // Discord成功 → 通知完了
    } catch (e) {
      console.error("Discord notification failed, falling back to Slack:", e);
    }
  }

  // Discordが未設定 or 失敗 → Slackにフォールバック
  if (config.slackWebhookUrl) {
    const slackPayload = convertDiscordToSlack(discordPayload);
    await sendSlackMessage(config.slackWebhookUrl, slackPayload);
  } else {
    throw new Error("通知の送信に失敗しました: 利用可能な通知チャンネルがありません");
  }
}

/**
 * エラー通知を送信する。sendNotificationsと同じフォールバック方式。
 * ただしエラー通知自体の失敗はthrowしない。
 */
export async function sendErrorNotifications(
  config: CoreConfig,
  jobName: string,
  error: Error,
): Promise<void> {
  const payload: DiscordPayload = {
    embeds: [
      {
        title: `❌ ジョブエラー: ${jobName}`,
        description: error.message,
        color: 0xff4444,
        footer: { text: new Date().toISOString() },
      },
    ],
  };

  if (config.discordWebhookUrl) {
    try {
      await sendDiscordMessage(config.discordWebhookUrl, payload);
      return; // Discord成功 → 通知完了
    } catch (e) {
      console.error(
        `Failed to send Discord error notification for job "${jobName}":`,
        e,
      );
    }
  }

  // Discordが未設定 or 失敗 → Slackにフォールバック
  if (config.slackWebhookUrl) {
    try {
      const slackPayload = convertDiscordToSlack(payload);
      await sendSlackMessage(config.slackWebhookUrl, slackPayload);
    } catch (e) {
      console.error(
        `Failed to send Slack error notification for job "${jobName}":`,
        e,
      );
    }
  }
}

import { loadCoreConfig } from "../lib/core-config.js";
import { sendNotifications } from "../lib/notification.js";

/**
 * ワンショットでリマインダーメッセージをDiscord（+ Slackフォールバック）に送信する。
 * 引数でメッセージを指定可能。省略時はデフォルトのリマインダー文言を使用。
 *
 * Usage: tsx src/cli/send-reminder.ts ["カスタムメッセージ"]
 */
const message =
  process.argv.slice(2).join(" ") ||
  "2時間経ちました。今の状況はどうですか？一区切りついたら、少し整理しましょう。";

async function main() {
  const config = loadCoreConfig();
  await sendNotifications(config, { content: message });
  console.log("リマインダーを送信しました。");
}

main().catch((err) => {
  console.error("リマインダー送信に失敗しました:", err);
  process.exit(1);
});

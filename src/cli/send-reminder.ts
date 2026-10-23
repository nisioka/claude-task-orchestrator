import { loadCoreConfig } from "../lib/core-config.js";
import { sendNotifications } from "../lib/notification.js";

/**
 * ワンショットでメッセージをDiscord（+ Slackフォールバック）に送信する。
 *
 * Usage: tsx src/cli/send-reminder.ts "メッセージ"
 *
 * メッセージは必須。既定の文言は持たない。引数を付け忘れた呼び出しが、誰にも何も伝えない定型文を
 * 送ってしまうため。空なら送らずに失敗し、呼び出した側がエラーを見て打ち直せるようにする。
 */
export function parseMessage(argv: string[]): string {
  const message = argv.join(" ").trim();
  if (!message) {
    throw new Error('メッセージが空です。送る内容を引数で渡してください (例: send-reminder.ts "TASK-1: 判断待ちです <URL>")');
  }
  return message;
}

async function main() {
  const message = parseMessage(process.argv.slice(2));
  const config = loadCoreConfig();
  await sendNotifications(config, { content: message });
  console.log("送信しました。");
}

if (process.env["VITEST"] === undefined) {
  main().catch((err) => {
    console.error("送信に失敗しました:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

import { execFileSync } from "node:child_process";

/**
 * fake-claude の取りこぼしを回収するための道具。
 *
 * 子は本番と同じ経路（`spawnDetached` の detached + unref）で起動するため、
 * テスト側には子のハンドルがありません。起動に成功した子はレジストリに pid を
 * 書くので回収できますが、**レジストリに書く前に失敗した子は誰にも回収されません**。
 *
 * 実際にこれで事故が起きています。レジストリ書き込み失敗を再現するために
 * `/proc` 配下を指していたテストがあり、procfs の mkdir が ENOENT を返すため
 * `fs.mkdirSync(dir, { recursive: true })` が「親を作る → 子を作り直す」を
 * 無限に繰り返し、fake-claude が CPU を 100% 回したまま孤児として残り続けました。
 * 1回のテスト実行につき1個、終了しないプロセスが積み上がります。
 *
 * その個別原因は塞ぎましたが、同じ形の漏れは今後も起こりえます。
 * テストの前後で pid の差分を取り、そのテストが生んだ子だけを確実に落とします。
 * アサーションが途中で失敗しても `afterEach` で走るので、取りこぼしません。
 *
 * **必ず `agentName` で絞ってください。** pgrep はプロセス全体を見るので、
 * 絞らないと *他のテストファイルが起動した子* まで SIGKILL の対象になります。
 * fake-claude を起動するファイルは2つあり、vitest はファイルを並列に走らせます。
 * 相手の子を、レジストリへ書き込む前に落としてしまうと、相手側は
 * 「起動を確認できませんでした」で落ちる——実際に CI で断続的に起きていました。
 */

/**
 * 起動中の fake-claude の pid。
 *
 * `--bg` 起動のものだけを見ます（`agents` 問い合わせは即終了するため）。
 * `agentName` を渡すと、その名前で起動した子だけに絞ります。
 */
export function listFakeAgentPids(agentName?: string): Set<number> {
  const pattern = agentName
    ? `fake-claude\\.mjs --bg --name ${agentName}( |$)`
    : "fake-claude\\.mjs --bg";
  try {
    const out = execFileSync("pgrep", ["-f", pattern], {
      encoding: "utf-8",
    });
    return new Set(
      out
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    );
  } catch {
    // pgrep は該当なしで終了コード 1 を返す
    return new Set();
  }
}

/**
 * `before` に含まれない fake-claude を落とす。
 *
 * SIGKILL を使います。暴走した子は同期ループの中にいて SIGTERM のハンドラを
 * 回す機会がないことがあり、また fake-claude には後始末すべきものがありません。
 */
export function reapFakeAgentsSince(before: Set<number>, agentName?: string): void {
  for (const pid of listFakeAgentPids(agentName)) {
    if (before.has(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // すでに終了している
    }
  }
}

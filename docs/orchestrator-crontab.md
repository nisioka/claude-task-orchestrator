# オーケストレータの crontab 設定

常駐オーケストレータは**ジョブではなくセッション**であり、cron には登録しない。
cron が駆動するのは死活監視 (`orchestrator-supervisor`) だけである。巡回・判断・
ディスパッチはセッション内部で回る。cron 起動は毎回コールドスタートになり、それが
コストの上限値になるため、監視に判断を持たせると常駐の意味が失われる。

## 追加するエントリ

既存の `progress-report` / `deploy-notify` のエントリは変更しない。以下を末尾に追記する。

```cron
# orchestrator-supervisor (20分毎, 多重起動をロックで防ぐ)
*/20 * * * * flock -n $HOME/.local/state/ai-orchestrator/supervisor.lock -c 'cd $HOME/git/ai-task-management && npx tsx src/index.ts orchestrator-supervisor' >> $HOME/.local/state/ai-orchestrator/supervisor.log 2>&1
```

適用:

```bash
mkdir -p ~/.local/state/ai-orchestrator
crontab -l > /tmp/crontab.bak            # 退避
crontab -e                                # 上記を追記
crontab -l                                # 反映を確認
```

## 指示ファイルを直したときの反映

`prompts/orchestrator.md` は起動時に一度だけ読まれる。編集しても稼働中のセッションには届かない。
**反映したいときは再起動する。**（描画は巡回のたびに走るが、読むのは起動時だけ。）

```bash
npx tsx src/index.ts orchestrator-supervisor --restart
```

健全なセッションでも終了させて起動し直す。**進行中の子エージェントは終了しない** —
新しいセッションが命名規約（`ai-impl-<ISSUE-ID>`）で照合して引き継ぐ。

セッション自身に更新を検出させて読み直させる方式は採らない。読み直しても**古い版の文章は
文脈に残り続ける**ため、規則を反転させた修正（「するな」→「してよい」等）では両方の記述が
共存し、どちらに従うか保証できない。結局そこは再起動が要る。信頼できない経路をもう一本
持つより、再起動一本に寄せたほうが挙動が読める。指示ファイルは定常状態ではそう頻繁に
変わらないので、再起動の頻度も問題にならない。

反映の急がない修正は、次に `absent` / `stalled` で再起動がかかるときに自然に載る。

### 注意: 描画元は作業ツリーそのもの

セッションが読むのは `~/.local/state/ai-orchestrator/prompts/orchestrator.md`（描画された出力）だが、
**その描画元はメインチェックアウトの作業ツリー**（`<repo>/prompts/`）で、supervisor は巡回のたびに
描画し直す。**ブランチを切り替えると、オーケストレータの指示が足元で入れ替わる。** 古いブランチを
チェックアウトしたまま再起動がかかると、古い指示で動き出す。これを避けたい場合は
`ORCHESTRATOR_PROMPT_SOURCE_DIRS` を作業ツリー外の固定ディレクトリへ向け、反映したいときだけコピーする。

## ログの置き場所

`/tmp` ではなく `~/.local/state/ai-orchestrator/` に置く。WSL では `/tmp` の永続が
保証されず、再起動でセッションIDとハートビートを失う。既存ジョブは `/tmp` にログを
出しているが、あちらは失っても次回実行で復旧するため差し支えない。

## 二重起動の防止は3層

| 層 | 手段 | 防ぐもの |
|---|---|---|
| 1 | crontab の `flock -n` | tick の重複 |
| 2 | 名前 `ai-orchestrator` の完全一致による記録外セッションの検出 | 記録を失ったが実体は動いている場合 |
| 3 | 停滞判定時のデーモン制御ソケット経由の明示的終了 | 古い個体と新しい個体の並走 |

1層目だけでは、状態ファイルが消えたときに2つのループが同じイシューを取り合う。

## 常駐の前提条件

```bash
loginctl show-user "$USER" --property=Linger   # Linger=yes であること
```

未達の場合は `loginctl enable-linger $USER`。ログアウトでユーザープロセスが停止するのを防ぐ。

### デーモンのサービス登録について

**claude 2.1.223 ではサービス登録が無効化されている。** `claude daemon --help` が
次のように明言している。

```
Service install is disabled in this version — the daemon runs on demand
and exits when the last client disconnects.
```

したがって systemd のユーザーサービスとして常駐させることはできず、これは設定漏れ
ではない。`orchestrator-supervisor` はこの事実を検出し、サービス未登録を問題として
報告しない — 解消できない警告を出し続けると、通知そのものが読まれなくなるため。

**この制約は cron が吸収する。** 監視ジョブは対話端末とは独立に20分毎に走り、
常駐セッションが失われていれば `claude --bg` で起動し直す。その起動自体が新しい
デーモンを立てるため、外側の保証は cron 側にある。将来サービス登録が復活した場合は、
`evaluatePrerequisites` が自動的に未登録を問題として報告するようになる。

## 検証用コンテナの回収 (container-sweep)

常駐セッションではなく cron が持つ。**理由は、判定に必要な事実がセッションより長生きするからではなく、
セッションが短命だから**である。コンテナを起動したセッションは、そのPRがマージされる頃には文脈の上限で
入れ替わっている。所有権の記憶をセッションに置く限り、後継は「自分のものだと証明できないものは止めない」
という正しい規則の結果、必ず人間に聞くことになる（仕様は CLAUDE.md）。

```cron
# container-sweep (JST 8:00-23:00 の毎時25分)
25 8-23 * * * npx tsx src/index.ts container-sweep >> /tmp/container-sweep.log 2>&1
```

分は他ジョブと重ならない値を選ぶ。

手で確かめるとき:

```bash
npx tsx src/index.ts container-sweep --dry-run          # 判定だけ。1件も停止しない
npx tsx src/index.ts container-sweep --grace-hours=0    # 完了直後のPRも対象にする
```

`--dry-run` は `docker compose down --dry-run` まで通すので、**どのコンテナが落ちるかが名前で出る**。
挙動を変えたときはこれで確認してから cron に載せる。

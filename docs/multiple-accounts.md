# 複数の Claude アカウントで動かす

1台のマシンで、タスクのグループごとに別の Claude アカウントを使い分けられる。
オーケストレータを**グループごとに1つずつ**起動し、それぞれに別のアカウントを割り当てる。

既定では何も変わらない。以下の設定をしなければ、これまでどおり1つのオーケストレータが
全グループを1つのアカウントで扱う。

## しくみ

Claude Code CLI は `CLAUDE_CONFIG_DIR` に従う。認証情報も、バックグラウンドのデーモンも、
ジョブの状態ファイルも、この設定ディレクトリごとに別になる。つまり設定ディレクトリを分ければ
アカウントが分かれ、エージェント一覧も互いに見えなくなる。

オーケストレータはこの仕組みにそのまま乗る。

- 常駐セッションも子エージェントも、supervisor を起動したときの環境変数を引き継ぐ。
  supervisor に `CLAUDE_CONFIG_DIR` を渡せば、その系統は丸ごとそのアカウントで動く
- エージェント一覧・ジョブ状態・デーモンへの問い合わせは、そのアカウントのものだけを見る
- `ORCHESTRATOR_GROUP` を渡すと、そのグループのタスクだけを読む。他のグループのタスクは
  取得もしないので、「触らないよう気をつける」必要がない

## 設定

系統ごとに、次の4つを分ける。

| 環境変数 | 意味 |
|---|---|
| `CLAUDE_CONFIG_DIR` | その系統が使うアカウントの設定ディレクトリ。先に `claude` を一度起動してログインしておく |
| `ORCHESTRATOR_GROUP` | 扱うタスクのグループ（`work` / `private`） |
| `ORCHESTRATOR_STATE_DIR` | セッションID・ハートビート・描画済みプロンプトの置き場所。**系統ごとに必ず別にする** |
| `ORCHESTRATOR_CLAUDE_BIN` | `claude` 以外を起動したいとき（任意） |

状態ディレクトリを共有すると、2つの常駐セッションが同じハートビートと同じセッションIDの記録を
奪い合い、supervisor は片方を「もう片方の重複」と見て終了させる。

cron は系統ごとに1行ずつ書く。ロックファイルも分ける。

```cron
*/20 * * * * flock -n $HOME/.local/state/ai-orchestrator-a/supervisor.lock -c 'cd /path/to/repo && CLAUDE_CONFIG_DIR=$HOME/.claude-a ORCHESTRATOR_GROUP=work ORCHESTRATOR_STATE_DIR=$HOME/.local/state/ai-orchestrator-a npx tsx src/index.ts orchestrator-supervisor' >> $HOME/.local/state/ai-orchestrator-a/supervisor.log 2>&1
*/20 * * * * flock -n $HOME/.local/state/ai-orchestrator-b/supervisor.lock -c 'cd /path/to/repo && CLAUDE_CONFIG_DIR=$HOME/.claude-b ORCHESTRATOR_GROUP=private ORCHESTRATOR_STATE_DIR=$HOME/.local/state/ai-orchestrator-b npx tsx src/index.ts orchestrator-supervisor' >> $HOME/.local/state/ai-orchestrator-b/supervisor.log 2>&1
```

`orchestrator-status` と `orchestrator-gate` も同じ環境変数で動かす。常駐セッションは環境を
引き継ぐので、セッションの中から呼ぶぶんには何もしなくてよい。人間が端末から状態を見るときは、
見たい系統の環境変数を付ける。

```bash
CLAUDE_CONFIG_DIR=~/.claude-a ORCHESTRATOR_GROUP=work \
  ORCHESTRATOR_STATE_DIR=~/.local/state/ai-orchestrator-a \
  npx tsx src/index.ts orchestrator-status
```

## リポジトリにグループを書く

リポジトリ一覧は系統で共有してよい。各リポジトリに、どちらのグループのものかを書く。

```json
{ "label": "app", "path": "/path/to/app", "baseBranch": "main", "group": "work" }
```

`group` は任意で、書かなければ何も起きない。書いておくと、**グループとリポジトリが食い違う
タスク**を止められる。たとえば `work` のタスクに `private` のリポジトリのラベルが付いていた
場合で、どちらかが付け間違いのはずである。

食い違ったタスクは着手されない。

- タスクの担当者を人間へ戻し、理由をコメントに書き、通知を1通出す
- 常駐セッションが作業を選ぶ一覧（`personal-issues`）にも、`orchestrator-status` の
  「AIのボール」にも出さない

判定はコードで行い、常駐セッションがタスクを読む前に済ませる。supervisor がセッションを
起動する直前と、巡回ゲートが走るたびに見ている。

グループの無いタスク、`group` を書いていないリポジトリは、どちらの側にも属さないものとして
判定の対象にしない。

## 気をつけること

**作業場所の信頼。** `claude --bg` は、そのアカウントで信頼済みになっていないディレクトリでは
起動を拒否する（`Workspace not trusted`）。信頼はアカウントごとに記録されるので、アカウントを
増やしたら、worktree を作る親ディレクトリでそのアカウントの `claude` を一度起動して、信頼の
確認に同意しておく。済ませていないと、子エージェントの起動だけが失敗する。

**子エージェントの環境を変えない。** 子は常駐セッションと同じ `CLAUDE_CONFIG_DIR` で起動する
前提になっている。別の設定ディレクトリで起動した子は、起動に成功していても一覧に現れず、
起動失敗と区別がつかない。

**デーモンは系統ごとに別。** 設定ディレクトリごとに別のデーモンが立ち、ソケットも別になる。
オーケストレータは自分のアカウントのデーモンだけに問い合わせる。見分けられないときは全部に
問い合わせる（アカウントが1つだったときと同じ動き）。

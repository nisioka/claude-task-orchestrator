# claude-task-orchestrator

**常駐する Claude Code のセッションが、単一のタスクソースを巡回し、子エージェントに仕事を配る。**

判断と制御フローはコードではなく、自然言語の指示ファイル（[prompts/orchestrator.md](prompts/orchestrator.md)）に書かれている。
TypeScript の側は3つに徹する。

- セッションを起こし続ける（`orchestrator-supervisor`）
- セッションが使う道具を提供する（タスクソースの読み書き、通知、rebase の仕分け、コンテナの回収）
- **セッションが死んでいても外から状態を読める**（`orchestrator-status`）

## 前提

- [Claude Code](https://claude.com/claude-code) がローカルで動くこと
- Node.js 20 以上
- タスクソース: Linear もしくは ClickUp のワークスペースと、**AI用のアカウント1つ**

## 設計の要点

**所有権は担当者だけで決まる。ステータスは判定に使わない。** 担当者がAIならステータスが何であっても
処理対象で、人間はステータスを動かさずに担当者だけを変えて仕事を渡す。「このステータスはAIが
持つはずがない」という判断をさせない。かつてステータスの許可リストで絞ったために、
`Test` ＋担当者=AI のイシューが状態表示から消え、AIはコメントの指示を読めないまま人間へ
差し戻し続けた。除外するのは `Backlog` と終了系だけで、それは**除外リスト**である。

**AIが詰まったら担当者を人間へ移す。ステータスは動かさない。** どこまで進んだかの記録だから。
`Todo` へ巻き戻すと、実装が終わっていたという情報が消える。

**セッションは巡回が正常でも文脈が上限に達したら入れ替える。** 1ターンの費用は抱えている文脈の
大きさで決まり、文脈は減らない。実測ではコストの85%が文脈の再読だった。

## 使い方

```bash
npm install
cp .env.example .env    # 編集する

# 状況を見る（読み取り専用。オーケストレータが壊れていても答える）
npx tsx src/index.ts orchestrator-status

# 常駐セッションの死活確認と起動（cron から20分ごとに回す）
npx tsx src/index.ts orchestrator-supervisor

# 検証用コンテナの回収
npx tsx src/index.ts container-sweep --dry-run
```

タスクを直に読み書きする CLI は `src/cli/` にある。

```bash
npx tsx src/cli/personal-issues.ts
npx tsx src/cli/personal-issue-detail.ts <ISSUE-ID> --comments=40
npx tsx src/cli/personal-status.ts --id=<ISSUE-ID> --status="In Review"
npx tsx src/cli/personal-assignee.ts --id=<ISSUE-ID> --to=human
npx tsx src/cli/send-reminder.ts "メッセージ"
```

## 設定

| ファイル | 中身 |
|---|---|
| `.env` | APIキーと通知先（[.env.example](.env.example)） |
| `~/.config/ai-orchestrator/repositories.json` | 対象リポジトリ（[docs/repositories.md](docs/repositories.md)） |
| `~/.config/ai-orchestrator/workflow.json` | ステータス名（[docs/workflow.md](docs/workflow.md)。無ければ既定） |

- [docs/task-source.md](docs/task-source.md) — Linear / ClickUp の切り替えと、それぞれの癖
- [docs/orchestrator-crontab.md](docs/orchestrator-crontab.md) — cron への登録と、指示ファイルの反映

## 取り込んで使う

submodule として取り込み、独自のジョブと組み合わせて使える。取り込む側は、
プロンプトを重ねて**子エージェントの種別**を足し、自分のディスパッチャに
core の**ジョブ**を並べる。[docs/embedding.md](docs/embedding.md) を参照。

## 開発

```bash
npm test
npx tsc --noEmit
```

テストは `.env` に汚染される。CI と同じ状態は `DOTENV_CONFIG_PATH=/nonexistent/.env npx vitest run src` で作れる。

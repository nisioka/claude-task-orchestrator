# リポジトリ設定

常駐オーケストレータが扱うリポジトリの一覧は `~/.config/ai-orchestrator/repositories.json` **だけ**が情報源で、
`prompts/orchestrator.md` と `prompts/child/*.md` がこのパスを参照している。

この設定は元々 `idle-auto-exec` というジョブのものだった（`~/.config/idle-auto-exec/config.json`）。
そのジョブは 2026-09-05 に削除し、設定はリポジトリ一覧として現在のパスへ移した。
`linear` キーはどのコードからも読まれていなかったので落とした。

## 設定ファイル

```bash
mkdir -p ~/.config/ai-orchestrator
```

`~/.config/ai-orchestrator/repositories.json` を作成:

```json
{
  "repositories": [
    {
      "label": "ai-task-management",
      "path": "/home/user/git/ai-task-management",
      "baseBranch": "master",
      "setupPrompt": "Run `npm ci` to install dependencies.",
      "cleanupPrompt": "Run `npm run build` to verify the build passes."
    }
  ]
}
```

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `label` | Yes | Linear ラベル名。リポジトリ名そのままを使う（`ai-task-management` 等） |
| `path` | Yes | ローカルリポジトリの絶対パス |
| `baseBranch` | Yes | ベースブランチ名 |
| `setupPrompt` | No | 実装前にClaude Codeへ渡すセットアップ指示 |
| `cleanupPrompt` | No | 実装後にClaude Codeへ渡すクリーンアップ指示 |

以下は常駐オーケストレータだけが解釈する（`prompts/orchestrator.md` 参照）。

| フィールド | 説明 |
|-----------|------|
| `setupCommand` | worktree 作成を含む環境構築コマンド（`app-fe-gw <branch>` 等） |
| `branchPrefix` | ブランチ名の接頭辞 |
| `localPatch` | ローカル専用パッチの所在。適用ファイルは worktree 構築直後にステージング不能にされる |
| `model` | このリポジトリでの実装モデル指定 |
| `rebase` | rebase 時に「読まずにコマンドで解決する」パスとコマンド（下記） |

`rebase` は `src/cli/rebase-triage.ts` が読む。**書かなければロックファイルしか生成物と見なさない。**
誤って `generatedPaths` に入れたパスは再生成で上書きされるため、推測で埋めないこと。

| フィールド | 説明 |
|-----------|------|
| `generatedPaths` | 生成物のグロブ。`*` は1セグメント内、`**` は階層をまたぐ、`!` で除外 |
| `regenerateCommand` | rebase 完了後に生成物を作り直すコマンド |
| `migrationPaths` | 連番マイグレーションのグロブ |
| `renumberCommand` | 既定ブランチ基準で採番し直すコマンド |
| `handLimit` | 手で解決すべきファイルがこの数を超えたら、人間へ渡す（既定 10） |

```json
"rebase": {
  "generatedPaths": ["src/main/kotlin/nu/studer/jooq/**", "client/**", "!client/mutator/**"],
  "regenerateCommand": "make db/flyway/migrate && make generate/orval-client",
  "migrationPaths": ["src/main/resources/db/migration*/**"],
  "renumberCommand": "make db/flyway/reorder/develop",
  "handLimit": 10
}
```

除外（`!`）が要るのは、生成物のツリーが純粋ではないため。`client/mutator/custom-instance.ts` は
orval の出力先に置かれているが手書きで、生成器の入力でもある。

`setupCommand` が無いときの worktree は `~/worktrees/github.com/<リポジトリ名>/<ISSUE-ID>` に、
`origin/<baseBranch>` から `feat/<ISSUE-ID>` ブランチで作られる（`src/lib/worktree.ts`）。

## 対象リポジトリを追加する

対象リポジトリ一覧の情報源は `~/.config/ai-orchestrator/repositories.json` **だけ**で、
常駐オーケストレータと `rebase-triage` がこれを読む（`prompts/orchestrator.md`）。
リポジトリを増やすのにこのリポジトリのコード変更は要らない。作業は2つ。

**1. config にエントリを追加する**

`label` / `path` / `baseBranch` は必須。読めるかどうかは実際にロードして確かめる。

```bash
npx tsx -e 'import("./src/lib/repositories.js").then(async m => {
  const c = await m.loadRepositoryConfig();
  console.log(c.repositories.length, m.findRepositoryByLabel(c, "<label>"));
})'
```

`path` が存在しない・`label` が重複していると、この時点でエラーになる。

**2. 個人 Linear に同名ラベルを作る**

MCP ツールがどの資格情報で動いているかは自明ではないので、ここでは使わない。
以下のどちらかで作る。

ラベルを付ける経路は `TaskProvider.ensureLabel` を通る。未作成なら、そのとき作られる。

グループ（Linear の label group）の配下に置きたい場合は、API を直接叩く必要がある
（`issueLabelCreate` の `parentId` にグループのID）。

**setupPrompt を書くときの注意**

worktree は毎回まっさらなので、`node_modules` は無い。「セットアップ不要」に見えるリポジトリでも、
npm / pnpm 系なら最低限インストール手順の案内が要る。逆に `.env` の要否は思い込みで書かず、
使い捨ての worktree で実際にテストを走らせて確かめる。

```bash
git worktree add ~/worktrees/github.com/<repo>/TMP -b tmp/setup-test origin/<baseBranch>
# ここで install → test → typecheck を実際に流し、必要な手順だけを setupPrompt に書く
git worktree remove ~/worktrees/github.com/<repo>/TMP --force && git branch -D tmp/setup-test
```

# ワークフローのステータス設定

タスクソースのステータス名は `~/.config/ai-orchestrator/workflow.json` **だけ**が持つ。
場所は `ORCHESTRATOR_WORKFLOW_PATH` で変えられる。

**ファイルが無ければ既定の名前を使う。** 既定はこのリポジトリの Linear ワークスペースの名前で、
単一ソースで運用している間は書く必要がない。

## 書式

```json
{
  "backlog": "backlog",
  "queued": "to do",
  "inProgress": "in progress",
  "question": "question",
  "wait": "wait",
  "inReview": "in review",
  "test": "deploy & test",
  "done": "done",
  "canceled": "canceled",
  "duplicate": "duplicate",
  "extraTerminal": ["complete"],
  "extraBacklog": []
}
```

書いたキーだけが既定を上書きする。全部書く必要はない。

| キー | 既定 | 意味 |
|---|---|---|
| `backlog` | `Backlog` | 誰も引いていない置き場。担当者がAIでも触らない |
| `queued` | `Todo` | 新規作成の着地先。予約実行が待つ場所でもある |
| `inProgress` | `In Progress` | AIが着手したときに置く。二重投入の防止を兼ねる |
| `question` | `Question` | 答えを待っている |
| `wait` | `Wait` | 外部要因待ち。人の返答、日時 |
| `inReview` | `In Review` | PRが出ていてレビューとマージ待ち |
| `test` | `Test` | 実機テスト待ち |
| `done` / `canceled` / `duplicate` | 同名 | 終了 |
| `extraTerminal` | `[]` | 上の3つ以外の「終わった」ステータス |
| `extraBacklog` | `[]` | `backlog` 以外の「まだ引いていない」ステータス |

`extraTerminal` があるのは、ソースが終了ステータスを3つより多く持てるからである。ClickUp の
`Closed` グループは兄弟を受け付けないステータスを1つ足すので、`done` に畳めない。

## 種別ではなく名前で持つ理由

ソース側の state type（`backlog` / `started` / `completed` …）で分類する版もあり得たが、type は
ステータスより粗く、「新規作成の着地先はどれか」を表せない。名前は人がボードで見ているものである。

## 判定は許可リストではなく除外リスト

AIのボールかどうかは**担当者だけ**で決まる。ステータスで絞るのは `backlog` と終了系だけで、
これは除外リストである。「AIが持ってよいステータス」の許可リストにすると、人間がステータスを
動かさずに担当者だけ変えて渡したものが一覧から消える。実際に `Test` ＋担当者=AI のイシューが
`orchestrator-status` に出ず、AIはコメントの指示を読めないまま人間へ差し戻し続けた。

除外リストなら、書き漏らしても「一覧に残る」側に倒れる。

## プロンプトへの反映

`prompts/**.md` は既定の名前で書いてあり、`orchestrator-supervisor` が巡回のたびに
`~/.local/state/ai-orchestrator/prompts/` へ描画し直す。設定した名前はそのとき差し替わる。

置換が届くのは**バッククォートか二重引用符で囲まれた名前だけ**である。`Test` / `Wait` / `Done` は
普通の英単語で、地の文まで書き換えると壊れるため。原本に裸の名前を書くと置換されないまま残るので、
テストが弾く（`src/lib/__tests__/prompt-render.test.ts`）。

`{{repoDir}}` と `{{promptDir}}` も同時に差し替わる。プロンプトに個人の絶対パスを書かないため。

**描画された側を編集しない。** 次の巡回で上書きされる。直すのは `prompts/` の側。

## 名前を変えたとき

1. `workflow.json` を直す
2. `npx tsx src/index.ts orchestrator-supervisor --restart`

描画は巡回のたびに走るが、セッションが指示ファイルを読むのは起動時だけなので、再起動が要る。

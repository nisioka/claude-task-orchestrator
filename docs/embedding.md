# 取り込んで使う

このリポジトリは単体でも動くが、submodule として取り込み、独自のジョブと組み合わせて
使うことを想定している。取り込む側が足せるものは2つ。

## 子エージェントの種別

`prompts/orchestrator.md` は子の共通ルールを**名指ししない**。`{{childRules}}` を置いてあり、
描画のときに各プロンプトソースの `child/rules.json` から表を組み立てる。

```json
[
  { "file": "child/mirror-triage.md", "purpose": "上流チケットのミラーのトリアージ" }
]
```

プロンプトソースは `ORCHESTRATOR_PROMPT_SOURCE_DIRS` にカンマ区切りで**重ねる**。
後の方が同じ相対パスのファイルを上書きし、`rules.json` は表の後ろに追加される。

```
ORCHESTRATOR_PROMPT_SOURCE_DIRS=/path/to/core/prompts,/path/to/your-repo/prompts
ORCHESTRATOR_REPO_DIR=/path/to/your-repo
```

プロンプトの中では **`{{coreDir}}` が core、`{{repoDir}}` が取り込んだ側**を指す。
core の CLI を叩くなら `{{coreDir}}/src/cli/…`、取り込んだ側のスクリプトなら
`{{repoDir}}/scripts/…`。単体で動かすときは両方が同じ場所になる。

## ジョブ

`src/index.ts` に相当するディスパッチャを自分で持ち、core のジョブを自分のジョブと並べる。

```ts
import { runOrchestratorSupervisor, parseSupervisorArgs } from "<core>/src/jobs/orchestrator-supervisor.js";
import { runOrchestratorStatus } from "<core>/src/jobs/orchestrator-status.js";
import { runContainerSweep, parseContainerSweepArgs } from "<core>/src/jobs/container-sweep.js";
```

`loadCoreConfig(env)` は環境を引数で受け取る。取り込んだ側が自分の設定オブジェクトの中に
`CoreConfig` を持ち、core にはそれだけを渡す形にできる。

## 依存の向き

**core は取り込んだ側を import しない。** 取り込んだ側は core を import してよい。
逆向きの参照が1つ入ると、次に core を切り出すときに書き直しになる。取り込んだ側で
テストとして守っておくとよい（`ai-task-management` にはそれがある）。

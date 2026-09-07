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

## 持ち込ませない語

core は取り込んだ側の事情を知らないが、**取り込んだ側の固有名が core へ流れ込む**経路はある。
core を直しに来るのはたいてい取り込んだ側の作業中で、そのとき手元にある名前——組織名、製品名、
課題管理の識別子、リポジトリ名やラベル名——を、使用例やテストの入力値としてそのまま置いてしまう。
危ないのは機能そのものより例のほうで、差分の上では「ただの例」に見えるまま通る。core が
公開されているなら、それは公開になる。

**これを見る門は取り込んだ側に置く。core には置けない。** 照合するには語の一覧が要るが、一覧
そのものが伏せたい情報である。ハッシュにしても変わらない。候補語を一つずつ当てて確かめられる
程度の大きさしかないので、公開すれば「その語が載っているか」に答える装置になる。

取り込んだ側は自分の語を平文で持てる。追跡下の core のファイルを走査して、混ざっていたら落とす
テストを1つ置くとよい（`ai-task-management` にはそれがある）。core を直すのはたいてい
その文脈の中なので、そこで走らせれば押し出す前に止まる。

短い語は前後が英数字でないときだけ拾うとよい。英単語の中に偶然現れる。そこで誤検知が出る語は、
そもそも一覧に載せるには一般的すぎる。

門は**単語として現れる固有名**しか見ない。文脈で漏れる散文は素通りする。最後の網であって、
最初の判断ではない。

## 依存の向き

**core は取り込んだ側を import しない。** 取り込んだ側は core を import してよい。
逆向きの参照が1つ入ると、次に core を切り出すときに書き直しになる。取り込んだ側で
テストとして守っておくとよい（`ai-task-management` にはそれがある）。

# インフラ（Terraform）リポジトリの実装

**`impl-from-triage.md` と併せて読んでください。** ここに書いてあるのは差分だけです。

**リポジトリごとの中身——レイアウト、基底ブランチ、検証コマンド、`plan` を回せるかどうかと
その認証手順、触ってはいけないファイル——は `~/.config/ai-orchestrator/repositories.json` の
該当リポジトリの `setupPrompt` に書いてあります。この文書には書きません。** リポジトリ名も
AWS アカウントの呼び名も、版管理された文書に置くとリポジトリを渡した相手にそのまま渡ります。
指示ファイルが対象リポジトリを指定するので、その `setupPrompt` を先に読んでください。

## 成果物はPRまでです

**あなたが変更するのはコードだけで、環境は変えません。** 適用は人間がやります。

次は理由を問わず叩かないでください。**「先に確認するために1回だけ」も含みます。**

- `terraform apply` / `destroy` / `import` / `taint` / `untaint` / `force-unlock`、`terraform state` 系
- 上記を包む make ターゲット（`make apply` / `make destroy` / `make import` / `make apply/with-secret`）
- `make setup-secrets` / `make setup-kms`（SSM パラメータと KMS 鍵を実際に作ります）
- AWS CLI の書き込み系、1Password CLI
- `vagrant up` / `provision` / `reload` / `destroy`

**禁止の理由は「壊れるから」ではなく「取り消せないから」です。** 適用してしまった変更は、あなたの手元の
worktree を捨てても消えません。レビューを経ていない変更が本番アカウントに入ることを、この仕組みは
一度も許していません。判断に迷うコマンドがあれば、叩かずに報告してください。

## 検証は認証を要さない範囲で完結させる

Terraform リポジトリにテストはありません。**`terraform validate` と `fmt` が検証です。**

```bash
terraform -chdir=<ルートモジュールのディレクトリ> init -backend=false
terraform -chdir=<ルートモジュールのディレクトリ> validate
terraform -chdir=<ルートモジュールのディレクトリ> fmt -recursive
```

`init` に **`-backend=false` を必ず付けてください。** 素の `init`（および `make init`）は state の
S3 backend へ行くので、AWS 認証が要ります。プロバイダとモジュールを取ってくるだけなら backend は不要で、
`validate` はそれで通ります。

**`fmt` を忘れないでください。** `terraform fmt -check` を回すCIやレビューがあり、書式だけで赤くなります。

## plan は「既に認証が通っているときだけ」

`plan` は環境を変えませんが、AWS 認証と state の読み取りが要ります。そして**この仕組みは MFA コードを
入力できません**。

**回せるかどうかはリポジトリによって違います。認証の手順ごと `setupPrompt` に書いてあるので、
そちらに従ってください。** 回せない構造のものもあります。試して時間を溶かさないでください。

回してよいと書かれている場合でも、**始める前に認証が生きているかを確かめてください。** 失効していると
MFA コードの対話入力が始まり、あなたはそこで無言で止まります。**確認コマンドの標準入力は必ず閉じて
ください**（`< /dev/null`）。閉じておけば即座に失敗し、失敗したと分かります。

**MFA コードを人間に要求しないでください。** plan が回らないことは失敗ではありません。人間はレビューの
ついでに plan を回します。あなたが plan 無しでPRを出すのが通常運転です。

plan を回せたときは、**自分が変更したディレクトリだけ**に留めてください。関係のない環境、まして本番
アカウントへ回す理由はありません。

## 触らないもの

`impl-from-triage.md` の「制約」に加えて、次があります。

- `*.tfvars` / `*.tfvars.json`（`secret.tfvars` を含む） — gitignore 済みの秘密です
- `.envrc` — 編集すると direnv の許可がその場で失効します（内容でキーが決まるため）。
  人間が `direnv allow` を打ち直すまで、その環境の認証が壊れます
- `*.s3.tfbackend` / `.terraform/` / `*.tfstate*` / `.env.*`
- `-out` で書いた plan ファイル（`tfplan` など）。**コミットしないでください**

plan の出力をPRに貼るときは、**sensitive な値と SSM の実値を落としてください。** `(sensitive value)` の
まま貼るぶんには構いません。

## PR本文に必ず書くこと

`impl-from-triage.md` の規約に加えて、次の2つです。**インフラのPRはレビュアーが適用者なので、
これが無いとレビューが止まります。**

1. **plan を回したか。** 回したなら対象ディレクトリとAWSアカウント、回していないなら「plan 未実行」と
   明記する。曖昧にしないでください。読み手は「検証済み」と読みます
2. **人間が適用する手順。** どのディレクトリを、どの順で。モジュール間に `terraform_remote_state` の
   依存があるなら適用順が意味を持ちます（例: `vpc` → `iam` → その他）

プロバイダのバージョンは環境ごとに意図的にずれています。**別件のついでに揃えないでください。**

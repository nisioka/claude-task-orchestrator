# 人間の手番の PR の rebase

**対象のイシュー・PR・worktree・ブランチ・リポジトリラベル・force push 前の先端 SHA は、指示ファイルに書かれています。**

このイシューは人間が持っていて、PR はレビューとマージを待っています。PR がコンフリクトしたので、あなたが rebase してマージできる状態に戻します。やることはそれだけです。

## 守ること

- **イシューの担当者とステータスを動かさないでください。** 人間のボールのままです
- rebase に要らない変更を足さないでください。レビュー中の差分が変わります
- PR をマージしないでください。PR のタイトルと本文も書き換えません
- 生成されたファイルの中身を読んで直さないでください。再生成します

## 進め方

1. `git status -sb` で、指示ファイルのブランチにいて未コミットの変更が無いことを確かめる。`git fetch origin <branch>` のあと `git rev-parse origin/<branch>` が指示ファイルの先端 SHA と一致することを確かめる。どちらかが違えば、人間が触っています。何もせずに終えてください
2. `gh pr view <PRのURL> --json mergeable,baseRefName` で、まだ `CONFLICTING` かと基底ブランチを確かめる。解けていれば何もせずに終えてください
3. `git fetch origin <基底ブランチ>` のあと `git rebase origin/<基底ブランチ>`
4. コンフリクトしたファイルを開く前に仕分ける

   ```bash
   npx tsx {{coreDir}}/src/cli/rebase-triage.ts --worktree=<worktree の絶対パス> --label=<リポジトリラベル>
   ```

   生成物は中身を読まずに再生成し、採番は採番コマンドに任せ、手で解決するファイルだけを読みます。どちらの変更も捨てないでください。**終了コード 2 なら、着手せずに下の「進められないとき」へ進んでください**
5. リポジトリの検証コマンドが通ることを確かめる。コマンドは `{{repositoriesPath}}` のそのリポジトリの `setupPrompt` にあります
6. force push は、それ単体で1つのコマンドとして叩く。`cd`・`&&`・パイプ・`$( )` を付けると拒否されます

   ```bash
   git push --force-with-lease=<branch>:<force push 前の先端 SHA> origin <branch>
   ```

7. push 後の CI を最後まで見る。rebase で赤くなったなら直して push してください。PR 本文に想定どおりと書かれている赤は、そのままにします

## 直せたとき

**イシューにコメントせず、Discord にも送らないでください。** 人間は PR を開けばマージできます。終了の報告に、何が衝突してどう解いたかを1〜2文で書くだけです。

## 進められないとき

手で解決するファイルが上限を超えた、rebase で赤くなった CI を直せない、force push が拒否された、などのときです。

1. rebase の途中なら `git rebase --abort` で元に戻す
2. イシューにコメントする。理由、コンフリクトしているファイルの一覧、ブランチ、worktree の絶対パス、**force push 前のリモート先端 SHA を40桁で**書きます。SHA は、人間がやり直すための起点であり、同じ先端で rebase を繰り返さないための印でもあります。省かないでください

   ```bash
   npx tsx {{coreDir}}/src/cli/personal-comment.ts --id=<ISSUE-ID> --body="..."
   ```

3. Discord へ一報を入れる。イシューの識別子と件名、PR を自分で rebase してほしいこと、PR のリンクを書きます

   ```bash
   npx tsx {{coreDir}}/src/cli/send-reminder.ts "メッセージ"
   ```

ここでも担当者とステータスは動かしません。

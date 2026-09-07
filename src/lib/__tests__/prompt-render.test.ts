import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CORE_DIR,
  relativeCliInvocations,
  renderChildRules,
  renderPromptText,
  renderPrompts,
} from "../prompt-render.js";

const NAMES = { Todo: "to do", Test: "deploy & test" };

describe("renderPromptText", () => {
  it("substitutes the three paths", () => {
    const text = "cd {{repoDir}} && cat {{promptDir}}/child/impl.md && {{coreDir}}/src/cli/x.ts";

    expect(
      renderPromptText(text, { names: {}, promptDir: "/out", repoDir: "/repo", coreDir: "/core" }),
    ).toBe("cd /repo && cat /out/child/impl.md && /core/src/cli/x.ts");
  });

  it("points repoDir at the core when nothing embeds it", () => {
    // Standalone, the two are the same place; a separate default would send the
    // prompts to a path that does not exist.
    expect(renderPromptText("{{repoDir}}", { names: {}, promptDir: "/out", coreDir: "/core" })).toBe(
      "/core",
    );
  });

  it("substitutes every occurrence, not just the first", () => {
    const text = "{{repoDir}} {{repoDir}} {{repoDir}}";

    expect(renderPromptText(text, { names: {}, promptDir: "/out", repoDir: "/repo" })).toBe(
      "/repo /repo /repo",
    );
  });

  it("falls back to this repository when no root is given", () => {
    expect(renderPromptText("{{coreDir}}", { names: {}, promptDir: "/out" })).toBe(CORE_DIR);
  });

  it("renames a status written in backticks", () => {
    const text = "指摘を `Test` のまま振る";

    expect(renderPromptText(text, { names: NAMES, promptDir: "/out" })).toBe(
      "指摘を `deploy & test` のまま振る",
    );
  });

  it("renames a status written as a quoted command argument", () => {
    const text = 'personal-status.ts --id=<ID> --status="Todo"';

    expect(renderPromptText(text, { names: NAMES, promptDir: "/out" })).toBe(
      'personal-status.ts --id=<ID> --status="to do"',
    );
  });

  it("leaves the same word alone in running prose", () => {
    // `Test`, `Wait` and `Done` are ordinary English words. Confining the
    // substitution to backticks and quotes is what makes it safe to apply.
    const text = "Test the change and Wait for the reviewer";

    expect(renderPromptText(text, { names: { ...NAMES, Wait: "wait" }, promptDir: "/out" })).toBe(
      text,
    );
  });

  it("leaves a status alone when the configured name is the same", () => {
    const text = "`In Review` のままにする";

    expect(renderPromptText(text, { names: {}, promptDir: "/out" })).toBe(text);
  });

  it("never renames a name it has just produced", () => {
    // Two statuses that trade names. A rule-at-a-time rewrite would turn both
    // into the same one; a single pass keeps the swap.
    const text = "`Done` から `Test` へ";

    expect(
      renderPromptText(text, { names: { Done: "Test", Test: "Done" }, promptDir: "/out" }),
    ).toBe("`Test` から `Done` へ");
  });

  it("does not let a shorter name shadow a longer one that starts with it", () => {
    const text = "`In Review` と `In Progress`";

    expect(
      renderPromptText(text, {
        names: { In: "x", "In Review": "review", "In Progress": "doing" },
        promptDir: "/out",
      }),
    ).toBe("`review` と `doing`");
  });
});

describe("renderChildRules", () => {
  it("renders a table of absolute paths", () => {
    const table = renderChildRules(
      [{ file: "child/impl.md", purpose: "実装" }],
      "/out",
    );

    expect(table).toBe(["| ファイル | 用途 |", "|---|---|", "| `/out/child/impl.md` | 実装 |"].join("\n"));
  });

  it("still renders the header when nothing is registered", () => {
    // An integration that adds no kind of its own should not produce a table
    // with a dangling header row missing.
    expect(renderChildRules([], "/out")).toBe(["| ファイル | 用途 |", "|---|---|"].join("\n"));
  });
});

describe("renderPrompts", () => {
  let dir: string;
  let source: string;
  let out: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prompt-render-"));
    source = join(dir, "prompts");
    out = join(dir, "rendered");
    mkdirSync(join(source, "child"), { recursive: true });
    writeFileSync(join(source, "orchestrator.md"), "読め: {{promptDir}}/child/impl.md\n`Todo`\n");
    writeFileSync(join(source, "child", "impl.md"), "cd {{repoDir}}\n");
  });

  /** A second prompt source, the shape a private repository would ship. */
  function overlay(files: Record<string, string>): string {
    const dir = join(mkdtempSync(join(tmpdir(), "prompt-overlay-")), "prompts");
    mkdirSync(join(dir, "child"), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    return dir;
  }

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders the whole tree, preserving the layout", async () => {
    const written = await renderPrompts(source, out, NAMES, "/repo");

    expect(written).toEqual(["child/impl.md", "orchestrator.md"]);
    expect(readFileSync(join(out, "orchestrator.md"), "utf-8")).toBe(
      `読め: ${out}/child/impl.md\n\`to do\`\n`,
    );
    expect(readFileSync(join(out, "child", "impl.md"), "utf-8")).toBe("cd /repo\n");
  });

  it("points the rendered prompts at each other, not at the sources", async () => {
    // Otherwise a child would read an unrendered file and be told the wrong
    // status names — silently, since an unrendered prompt still reads fine.
    await renderPrompts(source, out, NAMES, "/repo");

    expect(readFileSync(join(out, "orchestrator.md"), "utf-8")).not.toContain(source);
  });

  it("overwrites a previous render rather than appending to it", async () => {
    await renderPrompts(source, out, NAMES, "/repo");
    writeFileSync(join(source, "orchestrator.md"), "短い\n");

    await renderPrompts(source, out, NAMES, "/repo");

    expect(readFileSync(join(out, "orchestrator.md"), "utf-8")).toBe("短い\n");
  });

  it("fills the child rule table from the manifests", async () => {
    writeFileSync(
      join(source, "child", "rules.json"),
      JSON.stringify([{ file: "child/impl.md", purpose: "実装" }]),
    );
    writeFileSync(join(source, "orchestrator.md"), "{{childRules}}\n");

    await renderPrompts(source, out, {}, "/repo");

    expect(readFileSync(join(out, "orchestrator.md"), "utf-8")).toContain(
      `| \`${out}/child/impl.md\` | 実装 |`,
    );
  });

  it("leaves the table empty rather than failing when a source registers nothing", async () => {
    // Not every prompt source adds a child kind; a missing manifest is normal.
    writeFileSync(join(source, "orchestrator.md"), "{{childRules}}\n");

    await renderPrompts(source, out, {}, "/repo");

    expect(readFileSync(join(out, "orchestrator.md"), "utf-8")).toContain("| ファイル | 用途 |");
  });

  it("appends a later source's kinds to the table", async () => {
    // This is how a private repository adds a child kind without the published
    // core naming it.
    writeFileSync(
      join(source, "child", "rules.json"),
      JSON.stringify([{ file: "child/impl.md", purpose: "実装" }]),
    );
    writeFileSync(join(source, "orchestrator.md"), "{{childRules}}\n");
    const extra = overlay({
      "child/rules.json": JSON.stringify([{ file: "child/mirror.md", purpose: "ミラーのトリアージ" }]),
      "child/mirror.md": "ミラーのトリアージ\n",
    });

    await renderPrompts([source, extra], out, {}, "/repo");

    const text = readFileSync(join(out, "orchestrator.md"), "utf-8");
    expect(text).toContain("| 実装 |");
    expect(text).toContain("| ミラーのトリアージ |");
    expect(readFileSync(join(out, "child", "mirror.md"), "utf-8")).toBe("ミラーのトリアージ\n");
  });

  it("lets a later source replace an earlier file of the same path", async () => {
    const extra = overlay({ "child/impl.md": "差し替えた\n" });

    const written = await renderPrompts([source, extra], out, {}, "/repo");

    expect(readFileSync(join(out, "child", "impl.md"), "utf-8")).toBe("差し替えた\n");
    expect(written.filter((f) => f === "child/impl.md")).toHaveLength(1);
  });

  it("rejects a manifest that is not a list of file and purpose", async () => {
    // A silently ignored manifest leaves a child kind out of the table, and the
    // orchestrator then never dispatches it.
    writeFileSync(join(source, "child", "rules.json"), JSON.stringify([{ file: "child/impl.md" }]));

    await expect(renderPrompts(source, out, {}, "/repo")).rejects.toThrow(/file \/ purpose/);
  });

  it("appends a source's own sections where the core leaves room", async () => {
    // The core's instruction file is one document; a repository that embeds it
    // cannot overlay half of it without forking the thing it consumes.
    writeFileSync(join(source, "orchestrator.md"), "本文\n\n{{extraSections}}\n");
    const extra = overlay({ "orchestrator-extra.md": "## 12. 追加の節\n\n中身\n" });

    await renderPrompts([source, extra], out, {}, "/repo");

    const text = readFileSync(join(out, "orchestrator.md"), "utf-8");
    expect(text).toContain("本文");
    expect(text).toContain("## 12. 追加の節");
  });

  it("does not write the fragment out as a prompt of its own", async () => {
    const extra = overlay({ "orchestrator-extra.md": "## 12. 追加の節\n" });

    const written = await renderPrompts([source, extra], out, {}, "/repo");

    expect(written).not.toContain("orchestrator-extra.md");
  });

  it("leaves the placeholder empty when nothing appends to it", async () => {
    writeFileSync(join(source, "orchestrator.md"), "本文\n{{extraSections}}\n");

    await renderPrompts(source, out, {}, "/repo");

    expect(readFileSync(join(out, "orchestrator.md"), "utf-8")).toBe("本文\n\n");
  });

  it("substitutes inside an appended section too", async () => {
    // The fragment names the embedding repository's own CLI, so its
    // placeholders have to be resolved like any other prompt's.
    writeFileSync(join(source, "orchestrator.md"), "{{extraSections}}\n");
    const extra = overlay({ "orchestrator-extra.md": "{{repoDir}}/src/cli/x.ts `Todo`\n" });

    await renderPrompts([source, extra], out, { Todo: "to do" }, "/repo");

    const text = readFileSync(join(out, "orchestrator.md"), "utf-8");
    expect(text).toContain("/repo/src/cli/x.ts");
    expect(text).toContain("`to do`");
  });

  it("ignores files that are not prompts", async () => {
    writeFileSync(join(source, "notes.txt"), "無視されるべき");

    expect(await renderPrompts(source, out, {}, "/repo")).toEqual([
      "child/impl.md",
      "orchestrator.md",
    ]);
  });
});

describe("the prompts in this repository", () => {
  const SOURCE = join(CORE_DIR, "prompts");
  let scratch: string;
  let files: string[];

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), "prompt-check-"));
    files = await renderPrompts(SOURCE, scratch, {}, "/repo");
    expect(files.length).toBeGreaterThan(0);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("write every status name inside backticks or quotes", () => {
    // The substitution only reaches a name written that way. A bare one would
    // survive the rename and quietly tell the session a status that does not
    // exist.
    const bare: string[] = [];
    for (const rel of files) {
      const text = readFileSync(join(SOURCE, rel), "utf-8");
      const matches = text.matchAll(
        /(^|[^`"])\b(Backlog|Todo|Question|In Progress|Wait|In Review|Test|Done|Canceled|Duplicate)\b([^`"]|$)/g,
      );
      for (const m of matches) bare.push(`${rel}: ${m[0].trim()}`);
    }
    expect(bare).toEqual([]);
  });

  it("names no absolute path from the machine they were written on", () => {
    for (const rel of files) {
      const text = readFileSync(join(SOURCE, rel), "utf-8");
      expect(text, `${rel} に絶対パスが残っている`).not.toMatch(/\/home\/[a-z]+\//);
    }
  });
});

describe("relativeCliInvocations", () => {
  it("passes an absolute path", () => {
    expect(relativeCliInvocations("npx tsx /core/src/cli/send-reminder.ts \"x\"")).toEqual([]);
  });

  it("catches the placeholder someone forgot to write", () => {
    // レビューでは正しい行と見分けが付かない。実行して初めて
    // ERR_MODULE_NOT_FOUND で落ちる
    expect(relativeCliInvocations("npx tsx src/cli/send-reminder.ts \"x\"")).toEqual([
      'npx tsx src/cli/send-reminder.ts "x"',
    ]);
  });

  it("allows a relative path when the line moved there first", () => {
    expect(relativeCliInvocations("cd /repo && npx tsx src/index.ts orchestrator-status")).toEqual(
      [],
    );
  });

  it("reports an unrendered placeholder too, since the shell cannot follow it", () => {
    expect(relativeCliInvocations("npx tsx {{coreDir}}/src/cli/x.ts")).toHaveLength(1);
  });
});

describe("the prompts this repository ships", () => {
  it("invokes every CLI by an absolute path once rendered", async () => {
    // 実測: core を submodule にした際、`{{coreDir}}` の付け忘れが6行残り、
    // 人間への一報を送る send-reminder が ERR_MODULE_NOT_FOUND で落ちた。
    // エージェントの居場所は worktree であって、スクリプトのある場所ではない
    const out = mkdtempSync(join(tmpdir(), "prompt-guard-"));
    const written = await renderPrompts("prompts", out, NAMES, "/repo", "/core");

    const offenders = written.flatMap((rel) =>
      relativeCliInvocations(readFileSync(join(out, rel), "utf-8")).map((line) => `${rel}: ${line}`),
    );

    expect(offenders).toEqual([]);
    expect(written.length).toBeGreaterThan(0);
    rmSync(out, { recursive: true, force: true });
  });
});

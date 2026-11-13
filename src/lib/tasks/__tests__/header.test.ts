import { describe, it, expect } from "vitest";
import { readHeader, stripHeader, upsertHeader } from "../header.js";

const BODY = "company-linear-id: ABC-1\n会社Linear: https://example.com/ABC-1\n\n## 見出し\n\n- 箇条書き\n";

/**
 * What ClickUp stores for a description it is given: `_` escaped, and a bare
 * URL linked to itself with only the link text escaped. Its own output comes
 * back unchanged, as ClickUp's does.
 */
function savedByClickUp(description: string): string {
  return description.replace(/\[[^\]\n]*\]\([^)\s]*\)|(https?:\/\/[^\s)]+)|\\?_/g, (match, url?: string) => {
    if (url) return `[${url.replace(/_/g, "\\_")}](${url})`;
    return match === "_" ? "\\_" : match;
  });
}

describe("upsertHeader", () => {
  it("takes the name's old HTML comment out of the body", () => {
    const result = upsertHeader(
      "<!-- start-after: 2026-08-12T14:00 -->\n\n本文",
      { "start-after": "2027-01-01T00:00" },
    );

    expect(result).not.toContain("<!--");
    expect(readHeader(result)["start-after"]).toBe("2027-01-01T00:00");
    expect(stripHeader(result).trim()).toBe("本文");
  });

  it("takes it out when the entry is being removed, so a cancel really cancels", () => {
    // 消したのに旧コメントが残ると、次に読んだとき予約が生き返る
    const result = upsertHeader(
      "<!-- start-after: 2026-08-12T14:00 -->\n\n本文",
      { "start-after": "" },
    );

    expect(result).toBe("本文");
  });

  it("leaves the comments of names it is not writing", () => {
    const result = upsertHeader(
      "<!-- start-after: 2026-08-12T14:00 -->\n<!-- company-linear-id: ENG-1 -->\n\n本文",
      { worktree: "/abs/path" },
    );

    expect(result).toContain("<!-- start-after: 2026-08-12T14:00 -->");
    expect(result).toContain("<!-- company-linear-id: ENG-1 -->");
  });

  it("does not let a name with regex characters match anything else", () => {
    const result = upsertHeader("<!-- a.c: x -->\n\n本文", { "a.c": "1" });

    expect(result).not.toContain("<!--");
    expect(upsertHeader("<!-- abc: x -->\n\n本文", { "a.c": "1" })).toContain("<!-- abc: x -->");
  });

  it("puts the block above what was already there", () => {
    const out = upsertHeader(BODY, { worktree: "/abs/wt" });

    expect(out.indexOf("orchestrator:begin")).toBeLessThan(out.indexOf("company-linear-id"));
    expect(out).toContain("worktree: /abs/wt");
    expect(out).toContain(BODY.trim());
  });

  it("rewrites in place rather than stacking blocks", () => {
    const twice = upsertHeader(upsertHeader(BODY, { worktree: "/a" }), { worktree: "/b" });

    expect(twice.match(/orchestrator:begin/g)).toHaveLength(1);
    expect(twice).toContain("worktree: /b");
    expect(twice).not.toContain("/a");
  });

  it("keeps entries it was not asked about", () => {
    const once = upsertHeader(BODY, { worktree: "/a", PR: "https://x/1" });

    expect(upsertHeader(once, { worktree: "/b" })).toContain("PR: https://x/1");
  });

  it("keeps the order a reader saw last time", () => {
    // Shuffling on every write makes the diff unreadable and moves the line
    // someone was looking at.
    const once = upsertHeader(BODY, { worktree: "/a", PR: "https://x/1" });
    const twice = upsertHeader(once, { PR: "https://x/2" });

    expect(twice.indexOf("worktree")).toBeLessThan(twice.indexOf("PR"));
  });

  it("removes an entry given an empty value", () => {
    // A worktree that has been folded is worse than none: it sends a person to
    // a directory that is gone.
    const once = upsertHeader(BODY, { worktree: "/a", PR: "https://x/1" });
    const twice = upsertHeader(once, { worktree: "" });

    expect(twice).not.toContain("worktree");
    expect(twice).toContain("PR: https://x/1");
  });

  it("drops the block entirely once nothing is left in it", () => {
    const once = upsertHeader(BODY, { worktree: "/a" });

    expect(upsertHeader(once, { worktree: "" })).toBe(BODY.trimStart());
  });

  it("leaves the body untouched", () => {
    expect(stripHeader(upsertHeader(BODY, { worktree: "/a" }))).toBe(BODY.trimStart());
  });

  it("works on a task that had no description", () => {
    expect(upsertHeader(null, { worktree: "/a" })).toContain("worktree: /a");
  });

  it("uses no HTML comment and no markdown, which ClickUp would rewrite", () => {
    // An HTML comment in the same description as a URL makes ClickUp escape and
    // re-link that URL on every save, compounding until it is unreadable.
    const out = upsertHeader(BODY, { worktree: "/abs/wt", PR: "https://x/1" });
    const block = /orchestrator:begin([\s\S]*?)orchestrator:end/.exec(out)![1];

    expect(out).not.toContain("<!--");
    expect(block).not.toMatch(/^[-*]\s/m);
    expect(block).not.toMatch(/\[[^\]]+\]\(/);
  });

  it("survives being read and written repeatedly", () => {
    let d = upsertHeader(BODY, { worktree: "/a" });
    for (let i = 0; i < 3; i++) d = upsertHeader(d, readHeader(d));

    expect(readHeader(d)).toEqual({ worktree: "/a" });
    expect(d.match(/orchestrator:begin/g)).toHaveLength(1);
    expect(stripHeader(d)).toBe(BODY.trimStart());
  });

  it("reads back names and values with underscores through ClickUp's saves", () => {
    const written = { "worktree-repo_a": "/abs/repo_a/wt", PR: "https://example.com/o/r_x/pull/1" };
    let d = savedByClickUp(upsertHeader(BODY, written));

    expect(d).toContain("worktree-repo\\_a: /abs/repo\\_a/wt");
    expect(readHeader(d)).toEqual(written);

    for (let i = 0; i < 3; i++) d = savedByClickUp(upsertHeader(d, { worktree: "/abs/wt" }));

    expect(readHeader(d)).toEqual({ ...written, worktree: "/abs/wt" });
    expect(savedByClickUp(d)).toBe(d);
  });

  it("replaces an entry ClickUp escaped instead of adding a second one", () => {
    const saved = savedByClickUp(upsertHeader(BODY, { "worktree-repo_a": "/abs/repo_a/old" }));
    const out = upsertHeader(saved, { "worktree-repo_a": "/abs/repo_a/new" });

    expect(readHeader(out)).toEqual({ "worktree-repo_a": "/abs/repo_a/new" });
    expect(out.match(/worktree-repo/g)).toHaveLength(1);
  });

  it("removes an entry ClickUp escaped when given an empty value", () => {
    const saved = savedByClickUp(upsertHeader(BODY, { "worktree-repo_a": "/abs/repo_a/wt", worktree: "/a" }));

    expect(readHeader(upsertHeader(saved, { "worktree-repo_a": "" }))).toEqual({ worktree: "/a" });
  });
});

describe("readHeader", () => {
  it("reads back what was written", () => {
    expect(readHeader(upsertHeader(BODY, { worktree: "/a", PR: "https://x/1" }))).toEqual({
      worktree: "/a",
      PR: "https://x/1",
    });
  });

  it("reads back a URL that ClickUp auto-linked to itself", () => {
    // A bare URL is stored as `[url](url)`. That is the fixed point, not damage
    // — but the caller asked for the URL, not the markdown.
    const linked = "orchestrator:begin\nPR: [https://x/1](https://x/1)\norchestrator:end\n\n本文";

    expect(readHeader(linked)).toEqual({ PR: "https://x/1" });
  });

  it("undoes ClickUp's escaping of underscores in a name and a value", () => {
    const escaped = "orchestrator:begin\nworktree-repo\\_a: /abs/repo\\_a/wt\norchestrator:end\n\n本文";

    expect(readHeader(escaped)).toEqual({ "worktree-repo_a": "/abs/repo_a/wt" });
  });

  it("reads back an auto-linked URL whose link text ClickUp escaped", () => {
    // The text of the link is escaped and its destination is not, so the two
    // differ as strings until the text is unescaped.
    const linked =
      "orchestrator:begin\nPR: [https://x/o/r\\_x/pull/1](https://x/o/r_x/pull/1)\norchestrator:end\n\n本文";

    expect(readHeader(linked)).toEqual({ PR: "https://x/o/r_x/pull/1" });
  });

  it("keeps a backslash that escapes nothing, and unescapes an escaped one", () => {
    const plain = "orchestrator:begin\nnote: a\\b\\\\c\norchestrator:end\n\n本文";

    expect(readHeader(plain)).toEqual({ note: "a\\b\\c" });
  });

  it("reads a link whose text is not its URL as plain text", () => {
    const labelled = "orchestrator:begin\nPR: [label](https://x/1)\norchestrator:end\n\n本文";

    expect(readHeader(labelled)).toEqual({ PR: "[label](https://x/1)" });
  });

  it("reads a line ClickUp turned into a list item", () => {
    const listed = "orchestrator:begin\n*   worktree: /a\norchestrator:end\n\n本文";

    expect(readHeader(listed)).toEqual({ worktree: "/a" });
  });

  it("returns nothing for a description that has no block", () => {
    expect(readHeader(BODY)).toEqual({});
    expect(readHeader(null)).toEqual({});
  });

  it("ignores a line that is not a name and a value", () => {
    const odd = "orchestrator:begin\nworktree: /a\nただの文\norchestrator:end\n\n本文";

    expect(readHeader(odd)).toEqual({ worktree: "/a" });
  });

  it("keeps a value that contains a colon", () => {
    const out = upsertHeader(BODY, { PR: "https://example.com/o/r/pull/1" });

    expect(readHeader(out).PR).toBe("https://example.com/o/r/pull/1");
  });

  it("does not mistake the body's own name-and-value lines for the block", () => {
    // The mirror body opens with `company-linear-id: ABC-1`, which looks like
    // an entry. Only what sits between the delimiters counts.
    expect(readHeader(upsertHeader(BODY, { worktree: "/a" }))).toEqual({ worktree: "/a" });
  });
});

import { describe, it, expect } from "vitest";
import type { TaskDetail } from "../../lib/tasks/types.js";
import {parseDetailArgs, renderIssue} from "../personal-issue-detail.js";

describe("parseDetailArgs", () => {
  it("collects identifiers", () => {
    expect(parseDetailArgs(["TASK-1101", "TASK-1198"]).identifiers).toEqual([
      "TASK-1101",
      "TASK-1198",
    ]);
  });

  it("defaults to 3 comments", () => {
    expect(parseDetailArgs(["TASK-1101"]).commentCount).toBe(3);
  });

  it("reads --comments", () => {
    expect(parseDetailArgs(["TASK-1101", "--comments=10"]).commentCount).toBe(10);
  });

  it("rejects a non-positive comment count", () => {
    expect(() => parseDetailArgs(["TASK-1101", "--comments=0"])).toThrow(/--comments/);
    expect(() => parseDetailArgs(["TASK-1101", "--comments=x"])).toThrow(/--comments/);
  });

  it("requires at least one identifier", () => {
    expect(() => parseDetailArgs([])).toThrow(/識別子/);
    expect(() => parseDetailArgs(["--comments=5"])).toThrow(/識別子/);
  });
});

describe("renderIssue", () => {
  const issue: TaskDetail = {
    id: "TASK-1101",
    title: "旧API削除",
    url: "https://linear.app/x/issue/TASK-1101",
    updatedAt: "2026-08-07T00:53:18.896Z",
    status: "Question",
    group: null,
    labels: [],
    dueDate: null,
    priority: null,
    assignee: { id: "u1", name: "だいすけ" },
    description: "上流チケット: ABC-7542",
    comments: [
      { createdAt: "2026-08-07T00:53:09Z", body: "起案です", author: "AI" },
      { createdAt: "2026-08-07T00:36:19Z", body: "トリアージ開始", author: "AI" },
    ],
  };

  it("shows the fields needed to decide what to do", () => {
    const out = renderIssue(issue);

    expect(out).toContain("TASK-1101");
    expect(out).toContain("Question");
    expect(out).toContain("だいすけ");
    expect(out).toContain("https://linear.app/x/issue/TASK-1101");
  });

  it("puts the newest comment last, where the current proposal lives", () => {
    const out = renderIssue(issue);

    expect(out.indexOf("トリアージ開始")).toBeLessThan(out.indexOf("起案です"));
  });

  it("says so when the description is empty", () => {
    expect(renderIssue({ ...issue, description: "" })).toContain("(空)");
    expect(renderIssue({ ...issue, description: "   " })).toContain("(空)");
  });

  it("handles an unassigned issue", () => {
    expect(renderIssue({ ...issue, assignee: null })).toContain("(未設定)");
  });

  it("handles an issue with no comments", () => {
    const out = renderIssue({ ...issue, comments: [] });

    expect(out).toContain("TASK-1101");
    expect(out).not.toContain("--- comment");
  });
});

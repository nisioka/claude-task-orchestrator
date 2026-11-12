import { describe, it, expect } from "vitest";
import {
  listOpenPullRequests,
  OPEN_PULL_REQUEST_LIMIT,
  parseSearchPage,
  pullRequestKey,
} from "../open-pull-requests.js";

function page(nodes: unknown[], options: { issueCount?: number; endCursor?: string | null } = {}): string {
  const endCursor = options.endCursor ?? null;
  return JSON.stringify({
    data: {
      search: {
        issueCount: options.issueCount ?? nodes.length,
        pageInfo: { hasNextPage: endCursor !== null, endCursor },
        nodes,
      },
    },
  });
}

function node(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    headRefName: `feat/branch-${number}`,
    headRefOid: `abc${number}`,
    mergeable: "MERGEABLE",
    repository: { nameWithOwner: "owner/repo" },
    timelineItems: { nodes: [] },
    ...overrides,
  };
}

describe("parseSearchPage", () => {
  it("reads mergeability and the last force push", () => {
    const parsed = parseSearchPage(
      page([
        node(1, {
          mergeable: "CONFLICTING",
          timelineItems: { nodes: [{ createdAt: "2026-11-12T07:20:21Z" }] },
        }),
        node(2, { mergeable: "UNKNOWN" }),
      ]),
    );
    expect(parsed.pullRequests).toEqual([
      {
        repository: "owner/repo",
        number: 1,
        url: "https://github.com/owner/repo/pull/1",
        headRefName: "feat/branch-1",
        headRefOid: "abc1",
        mergeable: "CONFLICTING",
        lastForcePushAt: "2026-11-12T07:20:21Z",
      },
      expect.objectContaining({ number: 2, mergeable: "UNKNOWN", lastForcePushAt: null }),
    ]);
    expect(parsed.endCursor).toBeNull();
  });

  it("treats an unrecognised mergeability as not yet decided", () => {
    expect(parseSearchPage(page([node(1, { mergeable: "SOMETHING_NEW" })])).pullRequests[0].mergeable).toBe(
      "UNKNOWN",
    );
  });

  it("skips results that are not pull requests", () => {
    expect(parseSearchPage(page([{}, node(3)])).pullRequests.map(pullRequestKey)).toEqual(["owner/repo#3"]);
  });

  it("refuses a response of another shape", () => {
    expect(() => parseSearchPage(JSON.stringify({ errors: [{ message: "x" }] }))).toThrow();
  });
});

describe("listOpenPullRequests", () => {
  it("follows the cursor to the next page", async () => {
    const calls: string[][] = [];
    const result = await listOpenPullRequests(async (args) => {
      calls.push(args);
      return calls.length === 1
        ? page([node(1)], { issueCount: 2, endCursor: "CURSOR" })
        : page([node(2)], { issueCount: 2 });
    });
    expect(result?.map(pullRequestKey)).toEqual(["owner/repo#1", "owner/repo#2"]);
    expect(calls[0]).not.toContain("after=CURSOR");
    expect(calls[1]).toContain("after=CURSOR");
  });

  it("answers null when the list may be cut short", async () => {
    expect(
      await listOpenPullRequests(async () => page([node(1)], { issueCount: OPEN_PULL_REQUEST_LIMIT })),
    ).toBeNull();
  });

  it("answers null when gh fails", async () => {
    expect(
      await listOpenPullRequests(async () => {
        throw new Error("gh: not logged in");
      }),
    ).toBeNull();
  });
});

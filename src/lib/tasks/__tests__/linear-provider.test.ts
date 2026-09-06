import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LinearClient } from "@linear/sdk";
import { LinearTaskProvider, groupByTeam } from "../linear-provider.js";

const mockFetchViewer = vi.fn();
const mockResolveHumanUserId = vi.fn();

vi.mock("../../linear.js", async () => {
  const actual = await vi.importActual<typeof import("../../linear.js")>("../../linear.js");
  return {
    ...actual,
    createPersonalClient: () => ({}) as LinearClient,
    fetchViewer: (...a: unknown[]) => mockFetchViewer(...a),
    resolveHumanUserId: (...a: unknown[]) => mockResolveHumanUserId(...a),
  };
});

function makeProvider() {
  const client = {
    user: async (id: string) => ({ id, name: "Human", email: "human@example.com" }),
  } as unknown as LinearClient;
  return new LinearTaskProvider(client);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchViewer.mockResolvedValue({ id: "ai-id", name: "AI", email: "ai@example.com" });
  mockResolveHumanUserId.mockResolvedValue("human-id");
});

describe("isValidId", () => {
  it("accepts Linear's own shape", () => {
    expect(makeProvider().isValidId("ABC-123")).toBe(true);
    expect(makeProvider().isValidId("ABC-123")).toBe(true);
  });

  // 不透明IDを持つ他のバックエンドと取り違えると、存在しないイシューを掴む
  it("rejects shapes from other backends", () => {
    const p = makeProvider();
    expect(p.isValidId("z8tj1h26c6")).toBe(false);
    expect(p.isValidId("abc-123")).toBe(false);
    expect(p.isValidId("ABC123")).toBe(false);
    expect(p.isValidId("")).toBe(false);
  });
});

describe("actor", () => {
  it("resolves ai to the account the credentials belong to", async () => {
    expect(await makeProvider().actor("ai")).toEqual({
      id: "ai-id",
      name: "AI",
      email: "ai@example.com",
    });
  });

  it("resolves human to the other member", async () => {
    const a = await makeProvider().actor("human");
    expect(a.id).toBe("human-id");
    expect(mockResolveHumanUserId).toHaveBeenCalledWith(expect.anything(), "ai-id", undefined);
  });

  // 巡回ごとに解決し直すと、1回の一覧取得で人数ぶんの往復が増える
  it("resolves each role once", async () => {
    const p = makeProvider();
    await p.actor("ai");
    await p.actor("ai");
    expect(mockFetchViewer).toHaveBeenCalledTimes(1);
  });
});

describe("toLinearFilter", () => {
  it("is empty for an empty filter", async () => {
    expect(await makeProvider().toLinearFilter({})).toEqual({});
  });

  it("filters by status name", async () => {
    expect(await makeProvider().toLinearFilter({ statuses: ["Wait", "Question"] })).toEqual({
      state: { name: { in: ["Wait", "Question"] } },
    });
  });

  // 許可リストではなく除外リスト。増えたステータスは「見える」側へ倒れる
  it("excludes statuses by name", async () => {
    const f = await makeProvider().toLinearFilter({ excludeStatuses: ["Backlog", "Done"] });
    expect(f.state).toEqual({ name: { nin: ["Backlog", "Done"] } });
  });

  it("has no state condition when nothing is excluded", async () => {
    expect(await makeProvider().toLinearFilter({ excludeStatuses: [] })).toEqual({});
  });

  // 片方が消えると、除外したはずのものが混ざるか、見たいものが消える
  it("keeps both conditions when including and excluding at once", async () => {
    const f = await makeProvider().toLinearFilter({
      statuses: ["Wait", "Question"],
      excludeStatuses: ["Backlog"],
    });
    expect(f.state).toEqual({ name: { in: ["Wait", "Question"], nin: ["Backlog"] } });
  });

  // ラベルは AND。some の中に in を入れると「どれか1つ」になり、広く取りすぎる
  it("requires every label rather than any of them", async () => {
    expect(await makeProvider().toLinearFilter({ labels: ["a", "b"] })).toEqual({
      and: [
        { labels: { some: { name: { eq: "a" } } } },
        { labels: { some: { name: { eq: "b" } } } },
      ],
    });
  });

  it("treats group as one more label", async () => {
    const f = await makeProvider().toLinearFilter({ group: "private" });
    expect(f.and).toEqual([{ labels: { some: { name: { eq: "private" } } } }]);
  });

  it("resolves an assignee role to an id", async () => {
    expect(await makeProvider().toLinearFilter({ assignee: "human" })).toEqual({
      assignee: { id: { eq: "human-id" } },
    });
  });

  it("passes an assignee id through untouched", async () => {
    expect(await makeProvider().toLinearFilter({ assignee: "someone-else" })).toEqual({
      assignee: { id: { eq: "someone-else" } },
    });
  });

  it("has a distinct shape for unassigned", async () => {
    expect(await makeProvider().toLinearFilter({ assignee: "none" })).toEqual({
      assignee: { null: true },
    });
  });

  it("combines conditions", async () => {
    const f = await makeProvider().toLinearFilter({
      statuses: ["Wait"],
      excludeStatuses: ["Backlog"],
      updatedBefore: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(f).toEqual({
      state: { name: { in: ["Wait"], nin: ["Backlog"] } },
      updatedAt: { lte: "2026-09-01T00:00:00.000Z" },
    });
  });
});

describe("groupByTeam", () => {
  // Linear の or-filter は複数チームを混ぜると number 条件を無視する。
  // チームごとに問い合わせを分けるのはその回避であって、最適化ではない。
  it("groups numbers under their team key", () => {
    expect(groupByTeam(["X9Y-1101", "X9Y-1198", "PRIV-7"])).toEqual(
      new Map([
        ["X9Y", [1101, 1198]],
        ["PRIV", [7]],
      ]),
    );
  });

  it("rejects a malformed identifier", () => {
    expect(() => groupByTeam(["nope"])).toThrow();
    expect(() => groupByTeam(["abc-1"])).toThrow();
  });
});

describe("getMany", () => {
  function providerReturning(nodes: unknown[]) {
    const client = {
      client: { rawRequest: async () => ({ data: { issues: { nodes } } }) },
    } as unknown as LinearClient;
    return new LinearTaskProvider(client);
  }

  const node = (identifier: string) => ({
    identifier,
    title: identifier,
    url: `https://example.test/${identifier}`,
    updatedAt: "2026-09-01T00:00:00.000Z",
    dueDate: null,
    description: null,
    state: { name: "Wait", type: "started" },
    assignee: null,
    labels: { nodes: [] },
    comments: { nodes: [] },
  });

  it("returns nothing without asking when given no ids", async () => {
    expect(await providerReturning([]).getMany([])).toEqual([]);
  });

  // 呼び出し側は渡した順に読む。Linear の返却順は保証されない
  it("preserves the order asked for", async () => {
    const p = providerReturning([node("ABC-2"), node("ABC-1"), node("ABC-3")]);
    const got = await p.getMany(["ABC-3", "ABC-1", "ABC-2"]);
    expect(got.map((t) => t.id)).toEqual(["ABC-3", "ABC-1", "ABC-2"]);
  });

  it("maps a node onto the domain shape", async () => {
    const [t] = await providerReturning([node("ABC-1")]).getMany(["ABC-1"]);
    expect(t.description).toBe("");
    expect(t.comments).toEqual([]);
  });
});

// ─── Custom fields ──────────────────────────────────────────────────

describe("custom fields", () => {
  it("refuses them rather than dropping them", async () => {
    // Linear has no per-issue custom fields. The caller wrote the value
    // expecting to find it later; a silent drop is discovered by whoever goes
    // looking for it, which is the worst moment.
    await expect(
      makeProvider().create({ title: "件名", group: "work", fields: { worktree: "/a" } }),
    ).rejects.toThrow(/カスタム項目がありません/);
  });

  it("names the fields it refused", async () => {
    await expect(
      makeProvider().update("TASK-1", { fields: { worktree: "/a" } }),
    ).rejects.toThrow(/worktree/);
  });

  it("lets an empty set through", async () => {
    // An empty object is not a request to store anything.
    await expect(makeProvider().update("TASK-1", { fields: {} })).rejects.not.toThrow(
      /カスタム項目/,
    );
  });
});

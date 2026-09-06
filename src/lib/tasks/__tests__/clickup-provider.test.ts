import { describe, it, expect, beforeEach } from "vitest";
import { ClickUpTaskProvider } from "../clickup-provider.js";

const LISTS = { work: "L-work", private: "L-private" };

const AI = { id: 1, username: "AI", email: "ai@example.com", timezone: "Asia/Tokyo" };
const HUMAN = { id: 2, username: "Hitomi", email: "human@example.com" };

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/**
 * A ClickUp stood up from canned responses, matched by method and path.
 *
 * Routes are tried in order, so a test can override a default by prepending.
 * Anything unmatched throws rather than returning an empty object — a silent
 * `{}` turns a wrong URL into a confusing assertion failure somewhere else.
 */
class FakeClickUp {
  readonly calls: Call[] = [];
  private routes: [RegExp, string, unknown][] = [];

  constructor() {
    this.on("GET", /^\/user$/, { user: AI });
    this.on("GET", /^\/team$/, {
      teams: [{ id: "T1", members: [{ user: AI }, { user: HUMAN }] }],
    });
    this.on("GET", /^\/list\/L-work$/, { space: { id: "S1" } });
    this.on("GET", /^\/space\/S1\/tag$/, { tags: [] });
    this.on("GET", /^\/list\/L-(work|private)\/field$/, {
      fields: [
        { id: "F-worktree", name: "worktree", type: "text" },
        { id: "F-origin", name: "Origin URL", type: "url" },
      ],
    });
  }

  on(method: string, path: RegExp, response: unknown): this {
    this.routes.unshift([path, method, response]);
    return this;
  }

  /** Query strings of the requests that hit a path, in order. */
  queries(path: string): URLSearchParams[] {
    return this.calls
      .filter((c) => c.url.split("?")[0] === path)
      .map((c) => new URLSearchParams(c.url.split("?")[1] ?? ""));
  }

  readonly fetch = (async (url: string | URL, init?: RequestInit) => {
    const full = String(url).replace("https://api.clickup.com/api/v2", "");
    const method = init?.method ?? "GET";
    this.calls.push({
      method,
      url: full,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });

    const path = full.split("?")[0];
    for (const [pattern, routeMethod, response] of this.routes) {
      if (routeMethod === method && pattern.test(path)) {
        return new Response(JSON.stringify(response), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ err: "not stubbed" }), { status: 404 });
  }) as unknown as typeof fetch;
}

function rawTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "z8tj1h26um",
    name: "サンプル",
    markdown_description: "本文",
    status: { status: "to do" },
    tags: [{ name: "from-slack" }],
    assignees: [AI],
    url: "https://app.clickup.com/t/z8tj1h26um",
    date_updated: "1788672314969",
    due_date: null,
    priority: { priority: "high" },
    ...overrides,
  };
}

function tasksOn(fake: FakeClickUp, listId: string, tasks: unknown[]): FakeClickUp {
  return fake.on("GET", new RegExp(`^/list/${listId}/task$`), { tasks, last_page: true });
}

let fake: FakeClickUp;
let provider: ClickUpTaskProvider;

beforeEach(() => {
  fake = new FakeClickUp();
  provider = new ClickUpTaskProvider("key", LISTS, fake.fetch);
});

// ─── Identifiers ────────────────────────────────────────────────────

describe("isValidId", () => {
  it("accepts a ClickUp id", () => {
    expect(provider.isValidId("z8tj1h26um")).toBe(true);
  });

  it("rejects a Linear identifier", () => {
    expect(provider.isValidId("TASK-1368")).toBe(false);
  });

  it("rejects an empty string and a sentence", () => {
    expect(provider.isValidId("")).toBe(false);
    expect(provider.isValidId("not an id")).toBe(false);
  });
});

// ─── Filter translation ─────────────────────────────────────────────

describe("toQuery", () => {
  it("always asks for the markdown description", async () => {
    // The plain `description` is a flattened projection: links, code spans and
    // list markers are gone from it.
    const q = await provider.toQuery({});

    expect(q.get("include_markdown_description")).toBe("true");
  });

  it("always includes closed tasks", async () => {
    // Terminal statuses are ordinary names to the domain filter. Letting
    // ClickUp hide them by type would put a status out of `statuses`' reach.
    expect((await provider.toQuery({})).get("include_closed")).toBe("true");
  });

  it("passes statuses through as ClickUp's allowlist", async () => {
    const q = await provider.toQuery({ statuses: ["to do", "in review"] });

    expect(q.getAll("statuses[]")).toEqual(["to do", "in review"]);
  });

  it("lowercases label filters", async () => {
    // Tags are stored lowercase and `tags[]` is case-sensitive, unlike
    // `statuses[]`. The caller's case would match nothing.
    const q = await provider.toQuery({ labels: ["PJ:ABC"] });

    expect(q.getAll("tags[]")).toEqual(["pj:abc"]);
  });

  it("resolves a role to the account that plays it", async () => {
    expect((await provider.toQuery({ assignee: "human" })).getAll("assignees[]")).toEqual(["2"]);
    expect((await provider.toQuery({ assignee: "ai" })).getAll("assignees[]")).toEqual(["1"]);
  });

  it("sends an explicit id unchanged", async () => {
    expect((await provider.toQuery({ assignee: "9" })).getAll("assignees[]")).toEqual(["9"]);
  });

  it("does not ask ClickUp for the unassigned, which it cannot express", async () => {
    expect((await provider.toQuery({ assignee: "none" })).has("assignees[]")).toBe(false);
  });

  it("does not ask ClickUp to exclude statuses, which it cannot express", async () => {
    const q = await provider.toQuery({ excludeStatuses: ["done"] });

    expect(q.getAll("statuses[]")).toEqual([]);
  });

  it("converts updatedBefore to epoch milliseconds", async () => {
    const q = await provider.toQuery({ updatedBefore: new Date("2026-09-06T00:00:00Z") });

    expect(q.get("date_updated_lt")).toBe("1788652800000");
  });
});

// ─── Reading ────────────────────────────────────────────────────────

describe("list", () => {
  it("reads both groups when none is asked for", async () => {
    tasksOn(fake, "L-work", [rawTask({ id: "aaaaaa" })]);
    tasksOn(fake, "L-private", [rawTask({ id: "bbbbbb" })]);

    expect((await provider.list()).map((t) => t.id)).toEqual(["aaaaaa", "bbbbbb"]);
  });

  it("reads only the asked-for group", async () => {
    tasksOn(fake, "L-work", [rawTask()]);
    tasksOn(fake, "L-private", [rawTask({ id: "bbbbbb" })]);

    await provider.list({ group: "private" });

    const read = fake.calls.map((c) => c.url.split("?")[0]).filter((u) => u.endsWith("/task"));
    expect(read).toEqual(["/list/L-private/task"]);
  });

  it("names the group from the list the task came out of", async () => {
    tasksOn(fake, "L-private", [rawTask()]);

    expect((await provider.list({ group: "private" }))[0].group).toBe("private");
  });

  it("maps a task into the domain shape", async () => {
    tasksOn(fake, "L-work", [rawTask({ due_date: "1788721200000" })]);
    tasksOn(fake, "L-private", []);

    expect(await provider.list()).toEqual([
      {
        id: "z8tj1h26um",
        title: "サンプル",
        status: "to do",
        group: "work",
        labels: ["from-slack"],
        assignee: { id: "1", name: "AI", email: "ai@example.com" },
        url: "https://app.clickup.com/t/z8tj1h26um",
        updatedAt: "2026-09-06T05:25:14.969Z",
        dueDate: "2026-09-07",
        priority: "high",
        description: "本文",
      },
    ]);
  });

  it("reads a due date in the workspace's own zone", async () => {
    // ClickUp stores an all-day due date as 04:00 local, so 2026-09-07 is epoch
    // 1788721200000 — still 2026-09-06 in UTC. Reading it as UTC would report
    // every due date a day early.
    tasksOn(fake, "L-work", [rawTask({ due_date: "1788721200000" })]);
    tasksOn(fake, "L-private", []);

    expect((await provider.list())[0].dueDate).toBe("2026-09-07");
  });

  it("falls back to UTC when ClickUp reports no zone", async () => {
    fake.on("GET", /^\/user$/, { user: { ...AI, timezone: null } });
    tasksOn(fake, "L-work", [rawTask({ due_date: "1788721200000" })]);
    tasksOn(fake, "L-private", []);

    expect((await provider.list())[0].dueDate).toBe("2026-09-06");
  });

  it("reports no assignee rather than inventing one", async () => {
    tasksOn(fake, "L-work", [rawTask({ assignees: [] })]);
    tasksOn(fake, "L-private", []);

    expect((await provider.list())[0].assignee).toBeNull();
  });

  it("excludes statuses itself, since ClickUp will not", async () => {
    tasksOn(fake, "L-work", [rawTask({ id: "aaaaaa" }), rawTask({ id: "bbbbbb", status: { status: "done" } })]);
    tasksOn(fake, "L-private", []);

    const tasks = await provider.list({ excludeStatuses: ["done"] });

    expect(tasks.map((t) => t.id)).toEqual(["aaaaaa"]);
  });

  it("matches an excluded status whatever case it is configured in", async () => {
    tasksOn(fake, "L-work", [rawTask({ status: { status: "done" } })]);
    tasksOn(fake, "L-private", []);

    expect(await provider.list({ excludeStatuses: ["Done"] })).toEqual([]);
  });

  it("requires every label, not just one of them", async () => {
    // ClickUp's `tags[]` is an or. A caller asking for two labels means the
    // intersection; the union can be an order of magnitude larger.
    tasksOn(fake, "L-work", [
      rawTask({ id: "aaaaaa", tags: [{ name: "pj:abc" }, { name: "from-upstream" }] }),
      rawTask({ id: "bbbbbb", tags: [{ name: "pj:abc" }] }),
      rawTask({ id: "cccccc", tags: [{ name: "from-upstream" }] }),
    ]);
    tasksOn(fake, "L-private", []);

    const tasks = await provider.list({ labels: ["PJ:ABC", "from-upstream"] });

    expect(tasks.map((t) => t.id)).toEqual(["aaaaaa"]);
  });

  it("compares label names ignoring case, as ClickUp stores them lowercased", async () => {
    tasksOn(fake, "L-work", [rawTask({ tags: [{ name: "pj:abc" }] })]);
    tasksOn(fake, "L-private", []);

    expect(await provider.list({ labels: ["PJ:ABC"] })).toHaveLength(1);
  });

  it("still narrows the fetch with tags[], rather than reading everything", async () => {
    // The or is a useful prefilter even though it is not the answer.
    tasksOn(fake, "L-work", []);
    tasksOn(fake, "L-private", []);

    await provider.list({ labels: ["PJ:ABC", "from-upstream"] });

    expect(fake.queries("/list/L-work/task")[0].getAll("tags[]")).toEqual([
      "pj:abc",
      "from-upstream",
    ]);
  });

  it("filters the unassigned itself", async () => {
    tasksOn(fake, "L-work", [rawTask({ id: "aaaaaa", assignees: [] }), rawTask({ id: "bbbbbb" })]);
    tasksOn(fake, "L-private", []);

    expect((await provider.list({ assignee: "none" })).map((t) => t.id)).toEqual(["aaaaaa"]);
  });

  it("follows the pages until the last one", async () => {
    let page = 0;
    fake.on("GET", /^\/list\/L-work\/task$/, null);
    // Replace the canned route with one that answers differently per page.
    const inner = fake.fetch;
    provider = new ClickUpTaskProvider("key", LISTS, (async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("/list/L-work/task")) {
        const body =
          page++ === 0
            ? { tasks: [rawTask({ id: "aaaaaa" })], last_page: false }
            : { tasks: [rawTask({ id: "bbbbbb" })], last_page: true };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return inner(url, init);
    }) as unknown as typeof fetch);
    tasksOn(fake, "L-private", []);

    expect((await provider.list()).map((t) => t.id)).toEqual(["aaaaaa", "bbbbbb"]);
  });
});

describe("get", () => {
  it("returns null for a task that is gone, rather than throwing", async () => {
    // Callers routinely ask about ids a human may have deleted.
    expect(await provider.get("z8tj1h26um")).toBeNull();
  });

  it("asks for the markdown description", async () => {
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask());

    await provider.get("z8tj1h26um");

    expect(fake.queries("/task/z8tj1h26um")[0].get("include_markdown_description")).toBe("true");
  });

  it("does not read comments unless asked", async () => {
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask());

    const detail = await provider.get("z8tj1h26um");

    expect(detail?.comments).toEqual([]);
    expect(fake.calls.some((c) => c.url.includes("/comment"))).toBe(false);
  });

  it("pages back through the comments when more than one page is asked for", async () => {
    // ClickUp answers with 25 at a time, newest first. Asking for 40 without
    // paging returns 25 and says nothing — and the children read the last 40 to
    // find the instructions they were handed.
    const page = (from: number) =>
      Array.from({ length: 25 }, (_, i) => ({
        id: String(from - i),
        comment_text: `c${from - i}`,
        user: AI,
        date: String((from - i) * 1000),
      }));
    let call = 0;
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask());
    const inner = fake.fetch;
    provider = new ClickUpTaskProvider("key", LISTS, (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/comment")) {
        const body = { comments: call++ === 0 ? page(50) : page(25) };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return inner(url, init);
    }) as unknown as typeof fetch);

    const detail = await provider.get("z8tj1h26um", { comments: 40 });

    expect(detail?.comments).toHaveLength(40);
    // 最新が末尾。40件なので c11 から c50 まで
    expect(detail?.comments[0].body).toBe("c11");
    expect(detail?.comments.at(-1)?.body).toBe("c50");
  });

  it("stops paging when a short page says there are no more", async () => {
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask());
    fake.on("GET", /^\/task\/z8tj1h26um\/comment$/, {
      comments: [{ id: "1", comment_text: "唯一", user: AI, date: "1000" }],
    });

    const detail = await provider.get("z8tj1h26um", { comments: 40 });

    expect(detail?.comments).toHaveLength(1);
    expect(fake.calls.filter((c) => c.url.includes("/comment"))).toHaveLength(1);
  });

  it("returns the newest comments, oldest first", async () => {
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask());
    fake.on("GET", /^\/task\/z8tj1h26um\/comment$/, {
      comments: [
        { id: "3", comment_text: "三番目", user: AI, date: "3000" },
        { id: "1", comment_text: "一番目", user: HUMAN, date: "1000" },
        { id: "2", comment_text: "二番目", user: AI, date: "2000" },
      ],
    });

    const detail = await provider.get("z8tj1h26um", { comments: 2 });

    expect(detail?.comments.map((c) => c.body)).toEqual(["二番目", "三番目"]);
    expect(detail?.comments[0].author).toBe("AI");
  });
});

describe("getMany", () => {
  it("asks for them all in one request", async () => {
    fake.on("GET", /^\/team\/T1\/task$/, {
      tasks: [rawTask({ id: "bbbbbb" }), rawTask({ id: "aaaaaa" })],
      last_page: true,
    });

    await provider.getMany(["aaaaaa", "bbbbbb"]);

    const q = fake.queries("/team/T1/task");
    expect(q).toHaveLength(1);
    expect(q[0].getAll("task_ids[]")).toEqual(["aaaaaa", "bbbbbb"]);
  });

  it("returns them in the order asked for, not the order answered", async () => {
    fake.on("GET", /^\/team\/T1\/task$/, {
      tasks: [rawTask({ id: "bbbbbb" }), rawTask({ id: "aaaaaa" })],
      last_page: true,
    });

    expect((await provider.getMany(["aaaaaa", "bbbbbb"])).map((t) => t.id)).toEqual([
      "aaaaaa",
      "bbbbbb",
    ]);
  });

  it("drops ids that do not exist", async () => {
    fake.on("GET", /^\/team\/T1\/task$/, { tasks: [rawTask({ id: "aaaaaa" })], last_page: true });

    expect((await provider.getMany(["aaaaaa", "missing"])).map((t) => t.id)).toEqual(["aaaaaa"]);
  });

  it("asks nothing at all for an empty list", async () => {
    expect(await provider.getMany([])).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

// ─── Writing ────────────────────────────────────────────────────────

describe("custom fields", () => {
  it("reads the ones that hold something", async () => {
    tasksOn(fake, "L-work", [
      rawTask({
        custom_fields: [
          { id: "F-worktree", name: "worktree", type: "text", value: "/abs/wt" },
          { id: "F-origin", name: "Origin URL", type: "url" },
        ],
      }),
    ]);
    tasksOn(fake, "L-private", []);

    expect((await provider.list())[0].fields).toEqual({ worktree: "/abs/wt" });
  });

  it("leaves an unfilled field out rather than reporting an empty value", async () => {
    // "not set" and "set to nothing" are different answers.
    tasksOn(fake, "L-work", [
      rawTask({ custom_fields: [{ id: "F-worktree", name: "worktree", type: "text" }] }),
    ]);
    tasksOn(fake, "L-private", []);

    expect((await provider.list())[0].fields).toEqual({});
  });

  it("says nothing about fields when the response carries none", async () => {
    tasksOn(fake, "L-work", [rawTask()]);
    tasksOn(fake, "L-private", []);

    expect((await provider.list())[0].fields).toBeUndefined();
  });

  it("writes a value by resolving the name to the list's field id", async () => {
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask({ list: { id: "L-work" } }));
    fake.on("POST", /^\/task\/z8tj1h26um\/field\/F-worktree$/, {});

    await provider.update("z8tj1h26um", { fields: { worktree: "/abs/wt" } });

    const post = fake.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/task/z8tj1h26um/field/F-worktree");
    expect(post.body).toEqual({ value: "/abs/wt" });
  });

  it("matches the field name ignoring case", async () => {
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask({ list: { id: "L-work" } }));
    fake.on("POST", /^\/task\/z8tj1h26um\/field\/F-origin$/, {});

    await provider.update("z8tj1h26um", { fields: { "origin url": "https://example.com/x" } });

    expect(fake.calls.some((c) => c.url === "/task/z8tj1h26um/field/F-origin")).toBe(true);
  });

  it("throws on a name the list does not have, rather than skipping it", async () => {
    // The caller believes the value was stored. A quiet miss only surfaces when
    // someone goes looking for it.
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask({ list: { id: "L-work" } }));

    await expect(
      provider.update("z8tj1h26um", { fields: { nosuch: "x" } }),
    ).rejects.toThrow(/カスタム項目 "nosuch" がリスト/);
  });

  it("names what the list does have, so the message is actionable", async () => {
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask({ list: { id: "L-work" } }));

    await expect(provider.update("z8tj1h26um", { fields: { nosuch: "x" } })).rejects.toThrow(
      /worktree/,
    );
  });

  it("sets them on creation too", async () => {
    fake.on("POST", /^\/list\/L-work\/task$/, rawTask());
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask());
    fake.on("POST", /^\/task\/z8tj1h26um\/field\/F-origin$/, {});

    await provider.create({
      title: "件名",
      group: "work",
      fields: { "Origin URL": "https://example.com/ABC-1" },
    });

    expect(fake.calls.some((c) => c.url === "/task/z8tj1h26um/field/F-origin")).toBe(true);
  });

  it("asks the list for its fields only once", async () => {
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask({ list: { id: "L-work" } }));
    fake.on("POST", /^\/task\/z8tj1h26um\/field\/F-worktree$/, {});

    await provider.update("z8tj1h26um", { fields: { worktree: "/a" } });
    await provider.update("z8tj1h26um", { fields: { worktree: "/b" } });

    expect(fake.calls.filter((c) => c.url === "/list/L-work/field")).toHaveLength(1);
  });
});

describe("create", () => {
  beforeEach(() => {
    fake.on("POST", /^\/list\/L-work\/task$/, rawTask());
    fake.on("POST", /^\/list\/L-private\/task$/, rawTask());
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask());
  });

  it("posts to the list the group lives in", async () => {
    await provider.create({ title: "件名", group: "private" });

    expect(fake.calls.some((c) => c.method === "POST" && c.url === "/list/L-private/task")).toBe(
      true,
    );
  });

  it("sends the description as markdown", async () => {
    // The plain field would strip the markers the jobs read back out.
    await provider.create({ title: "件名", group: "work", description: "<!-- id: 1 -->\n\n本文" });

    const post = fake.calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ markdown_description: "<!-- id: 1 -->\n\n本文" });
  });

  it("resolves the assignee role to an id", async () => {
    await provider.create({ title: "件名", group: "work", assignee: "human" });

    expect(fake.calls.find((c) => c.method === "POST")!.body).toMatchObject({ assignees: [2] });
  });

  it("reads the task back rather than trusting what it sent", async () => {
    // ClickUp lowercases names, so the stored status and tags can differ from
    // the ones asked for.
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask({ status: { status: "to do" } }));

    const created = await provider.create({ title: "件名", group: "work", status: "To Do" });

    expect(created.status).toBe("to do");
  });

  it("does not carry the description or comments into the summary", async () => {
    const created = await provider.create({ title: "件名", group: "work" });

    expect(created).not.toHaveProperty("comments");
    expect(created.description).toBeUndefined();
  });
});

describe("update", () => {
  beforeEach(() => {
    fake.on("PUT", /^\/task\/z8tj1h26um$/, {});
    fake.on("GET", /^\/task\/z8tj1h26um$/, rawTask());
  });

  it("changes nothing when the patch is empty", async () => {
    await provider.update("z8tj1h26um", {});

    expect(fake.calls).toEqual([]);
  });

  it("sends the title under ClickUp's name for it", async () => {
    await provider.update("z8tj1h26um", { title: "新しい件名" });

    expect(fake.calls.find((c) => c.method === "PUT")!.body).toEqual({ name: "新しい件名" });
  });

  it("removes the previous assignee when setting a new one", async () => {
    // A ClickUp task holds a set of assignees; the domain has one. Adding
    // without removing would leave two people holding the ball.
    await provider.update("z8tj1h26um", { assignee: "human" });

    expect(fake.calls.find((c) => c.method === "PUT")!.body).toEqual({
      assignees: { add: [2], rem: [1] },
    });
  });

  it("does not remove the assignee it is about to set", async () => {
    await provider.update("z8tj1h26um", { assignee: "ai" });

    expect(fake.calls.find((c) => c.method === "PUT")!.body).toEqual({
      assignees: { add: [1], rem: [] },
    });
  });

  it("creates a label before attaching it", async () => {
    fake.on("POST", /^\/space\/S1\/tag$/, {});
    fake.on("POST", /^\/task\/z8tj1h26um\/tag\/.*$/, {});

    await provider.update("z8tj1h26um", { addLabels: ["PJ:ABC"] });

    const posts = fake.calls.filter((c) => c.method === "POST").map((c) => c.url);
    expect(posts).toEqual(["/space/S1/tag", "/task/z8tj1h26um/tag/PJ%3AABC"]);
  });
});

describe("comment", () => {
  it("posts plain markdown, which is the only form that both stores and shows", async () => {
    fake.on("POST", /^\/task\/z8tj1h26um\/comment$/, {});

    await provider.comment("z8tj1h26um", "## 見出し\n\n- 一つ");

    expect(fake.calls[0].body).toEqual({
      comment_text: "## 見出し\n\n- 一つ",
      notify_all: false,
    });
  });
});

describe("updateLatestComment", () => {
  it("rewrites the newest one, not the first the API listed", async () => {
    fake.on("GET", /^\/task\/z8tj1h26um\/comment$/, {
      comments: [
        { id: "1", comment_text: "古い", user: AI, date: "1000" },
        { id: "9", comment_text: "新しい", user: AI, date: "9000" },
      ],
    });
    fake.on("PUT", /^\/comment\/9$/, {});

    await provider.updateLatestComment("z8tj1h26um", "書き直し");

    const put = fake.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/comment/9");
    expect(put.body).toEqual({ comment_text: "書き直し" });
  });

  it("says so when there is nothing to rewrite", async () => {
    fake.on("GET", /^\/task\/z8tj1h26um\/comment$/, { comments: [] });

    await expect(provider.updateLatestComment("z8tj1h26um", "x")).rejects.toThrow(
      /コメントがありません/,
    );
  });
});

// ─── Labels ─────────────────────────────────────────────────────────

describe("ensureLabel", () => {
  it("creates a tag that does not exist yet", async () => {
    fake.on("POST", /^\/space\/S1\/tag$/, {});

    expect(await provider.ensureLabel("from-slack")).toBe("from-slack");
    expect(fake.calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("returns the name ClickUp actually stored", async () => {
    // A tag is its name here — there are no tag ids — so returning the case
    // that was asked for would hand back something a later read never matches.
    fake.on("GET", /^\/space\/S1\/tag$/, { tags: [{ name: "pj:abc" }] });

    expect(await provider.ensureLabel("PJ:ABC")).toBe("pj:abc");
  });

  it("does not create a tag that differs only in case", async () => {
    fake.on("GET", /^\/space\/S1\/tag$/, { tags: [{ name: "pj:abc" }] });

    await provider.ensureLabel("PJ:ABC");

    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("listLabels", () => {
  it("reads the space's tags", async () => {
    fake.on("GET", /^\/space\/S1\/tag$/, { tags: [{ name: "from-slack" }, { name: "pj:abc" }] });

    expect(await provider.listLabels()).toEqual(["from-slack", "pj:abc"]);
  });

  it("finds the space from the list rather than being told it", async () => {
    await provider.listLabels();

    expect(fake.calls.map((c) => c.url)).toEqual(["/list/L-work", "/space/S1/tag"]);
  });
});

// ─── Actors ─────────────────────────────────────────────────────────

describe("actor", () => {
  it("calls the credentials' own account the AI", async () => {
    expect(await provider.actor("ai")).toEqual({ id: "1", name: "AI", email: "ai@example.com" });
  });

  it("calls the other member the human", async () => {
    expect(await provider.actor("human")).toEqual({
      id: "2",
      name: "Hitomi",
      email: "human@example.com",
    });
  });

  it("refuses to guess when there is more than one other member", async () => {
    // Guessing hands work to the wrong person, and nobody notices until they do.
    fake.on("GET", /^\/team$/, {
      teams: [{ id: "T1", members: [{ user: AI }, { user: HUMAN }, { user: { id: 3, username: "C" } }] }],
    });

    await expect(provider.actor("human")).rejects.toThrow(/特定できません/);
  });

  it("asks only once", async () => {
    await provider.actor("ai");
    await provider.actor("ai");

    expect(fake.calls.filter((c) => c.url === "/user")).toHaveLength(1);
  });
});

// ─── Errors ─────────────────────────────────────────────────────────

describe("failures", () => {
  it("puts ClickUp's own message in the error", async () => {
    // The status alone says little: a wrong status name and a missing task
    // both come back as a 4xx.
    fake.on("PUT", /^\/task\/z8tj1h26um$/, {});
    const provider2 = new ClickUpTaskProvider("key", LISTS, (async () =>
      new Response(JSON.stringify({ err: "Status does not exist", ECODE: "ITEM_114" }), {
        status: 400,
      })) as unknown as typeof fetch);

    await expect(provider2.update("z8tj1h26um", { title: "x" })).rejects.toThrow(
      /Status does not exist/,
    );
  });
});

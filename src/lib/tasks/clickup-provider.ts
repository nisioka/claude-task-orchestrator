import type { TaskProvider } from "./provider.js";
import type {
  Actor,
  ActorRole,
  NewTask,
  Task,
  TaskComment,
  TaskDetail,
  TaskFilter,
  TaskGroup,
  TaskId,
  TaskPatch,
  TaskPriority,
} from "./types.js";

/**
 * Task provider backed by a ClickUp workspace.
 *
 * Three of ClickUp's habits shape everything below.
 *
 *   - **It lowercases every name it stores.** A tag created as `PJ:ABC` comes
 *     back as `pj:abc`, and so do the statuses. Reads therefore compare names
 *     case-insensitively and writes send whatever case the caller had.
 *   - **It has no way to exclude a status.** `statuses[]` is an allowlist only,
 *     so `excludeStatuses` is applied after fetching. The allowlist is exactly
 *     what the domain filter refuses to be (see `TaskFilter.excludeStatuses`),
 *     and computing the complement from the list's configured statuses would
 *     re-introduce it — a status added on the board would silently drop out.
 *   - **Its plain `description` is a flattened projection.** Links, code spans
 *     and list markers are gone from it. `include_markdown_description=true`
 *     returns the real thing, so every read asks for it.
 *
 * The groups are two lists in one space, which is what makes a single space's
 * tag namespace shared between them.
 */

const API = "https://api.clickup.com/api/v2";

/** ClickUp's own identifier shape: a short lowercase alphanumeric string. */
const IDENTIFIER = /^[0-9a-z]{6,15}$/;

/** ClickUp's fixed priority scale. 0 is not a value; the field is null instead. */
const PRIORITY_BY_NAME: Record<string, TaskPriority> = {
  urgent: "urgent",
  high: "high",
  normal: "normal",
  low: "low",
};
/**
 * How many times a rate-limited request is retried.
 *
 * ClickUp allows 100 requests a minute on the free plan, and a sync that
 * touches every task goes past that easily. Without this the caller sees a 429
 * as an ordinary failure and the work is simply skipped.
 */
const RATE_LIMIT_RETRIES = 4;

/** Fallback wait when the response does not say how long to hold off. */
const RATE_LIMIT_PAUSE_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Colour for tags this adapter creates. */
const NEW_LABEL_COLOR = "#6B7280";

/** How many comments ClickUp returns per page, newest first. */
const COMMENTS_PER_PAGE = 25;

/** The most task ids ClickUp accepts in one filtered query. */
const TASK_IDS_PER_REQUEST = 100;

export interface ClickUpLists {
  work: string;
  private: string;
}

interface RawUser {
  id: number;
  username: string | null;
  email?: string | null;
  /** IANA zone. Present on `GET /user`, absent on the user objects inside a task. */
  timezone?: string | null;
}

interface RawCustomField {
  id: string;
  name: string;
  type: string;
  value?: unknown;
}

interface RawTask {
  id: string;
  name: string;
  description?: string | null;
  markdown_description?: string | null;
  status: { status: string } | null;
  tags: { name: string }[];
  assignees: RawUser[];
  url: string;
  date_updated: string | null;
  due_date: string | null;
  priority: { priority: string } | null;
  custom_fields?: RawCustomField[];
  list?: { id: string };
}

interface RawComment {
  id: string;
  comment_text: string | null;
  user: RawUser | null;
  date: string | number;
}

function epochToIso(value: string | number | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value;
  return n ? new Date(n).toISOString() : "";
}

/**
 * The calendar date an instant falls on, in a given zone.
 *
 * A due date has to be read in the workspace's zone, not UTC. ClickUp stores an
 * all-day due date as 04:00 local — a 2026-09-07 due date is epoch
 * 1788721200000, which is still 2026-09-06 in UTC. Taking the UTC date would
 * report every due date a day early for anyone east of London.
 */
function localDate(epoch: string | number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Number(epoch)));
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function priorityOf(raw: RawTask): TaskPriority | null {
  const name = raw.priority?.priority?.toLowerCase();
  return name ? (PRIORITY_BY_NAME[name] ?? null) : null;
}

/**
 * The custom fields that actually hold something, as name → text.
 *
 * ClickUp returns every field defined on the list, with `value` absent on the
 * ones nobody filled in. Carrying those through as empty strings would make
 * "not set" and "set to nothing" the same thing.
 */
function fieldsOf(raw: RawTask): Record<string, string> | null {
  if (!raw.custom_fields) return null;
  const out: Record<string, string> = {};
  for (const field of raw.custom_fields) {
    if (field.value === undefined || field.value === null || field.value === "") continue;
    out[field.name] = typeof field.value === "string" ? field.value : JSON.stringify(field.value);
  }
  return out;
}

/**
 * How long to hold off after a 429, from whatever the response volunteers.
 *
 * `Retry-After` is in seconds; `X-RateLimit-Reset` is an absolute epoch second.
 * Neither is guaranteed, so a fixed pause backs them up — the window is a
 * minute, so waiting too long costs one cycle and waiting too little costs
 * another rejection.
 */
function retryDelayMs(response: Response): number {
  const after = Number(response.headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return after * 1000;

  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const wait = reset * 1000 - Date.now();
    if (wait > 0 && wait < 120_000) return wait + 500;
  }
  return RATE_LIMIT_PAUSE_MS;
}

function actorOf(user: RawUser): Actor {
  return { id: String(user.id), name: user.username ?? String(user.id), email: user.email ?? undefined };
}

export class ClickUpTaskProvider implements TaskProvider {
  readonly name = "clickup";
  readonly supportsFields = true;

  private readonly apiKey: string;
  private readonly lists: ClickUpLists;
  private readonly fetchImpl: typeof fetch;

  private actorCache = new Map<ActorRole, Actor>();
  /** Custom field name (lowercased) → id, per list. */
  private fieldCache = new Map<string, Map<string, string>>();
  private meCache: RawUser | null = null;
  private spaceIdCache: string | null = null;
  private teamIdCache: string | null = null;

  /** `fetchImpl` is injectable so tests can drive the whole adapter offline. */
  constructor(apiKey: string, lists: ClickUpLists, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.lists = lists;
    this.fetchImpl = fetchImpl;
  }

  isValidId(value: string): boolean {
    return IDENTIFIER.test(value);
  }

  // ─── Transport ────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Authorization: this.apiKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      // 429 は「まだ空いていない」であって失敗ではない。呼び出し側へ上げると、
      // その1件の仕事が黙って落ちる
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(retryDelayMs(response));
        continue;
      }

      const text = await response.text();
      if (!response.ok) {
        // ClickUp puts an actionable message in the body; the status alone says
        // little (a wrong status name and a missing task are both 400/401).
        throw new Error(`ClickUp ${method} ${path} が失敗しました (${response.status}): ${text}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  // ─── Workspace lookups ────────────────────────────────────────────

  /**
   * The space the two lists live in, read from a list rather than configured.
   *
   * Tags are a space-level namespace, so the adapter needs the space id for
   * every label operation. Deriving it means one less id to keep in sync.
   */
  private async spaceId(): Promise<string> {
    if (this.spaceIdCache) return this.spaceIdCache;
    const list = await this.request<{ space: { id: string } }>("GET", `/list/${this.lists.work}`);
    this.spaceIdCache = list.space.id;
    return this.spaceIdCache;
  }

  private async teamId(): Promise<string> {
    if (this.teamIdCache) return this.teamIdCache;
    const teams = await this.request<{ teams: { id: string }[] }>("GET", "/team");
    if (teams.teams.length !== 1) {
      throw new Error(
        `ClickUp のワークスペースが ${teams.teams.length} 件見つかりました。` +
          `1件であることを前提にしています。`,
      );
    }
    this.teamIdCache = teams.teams[0].id;
    return this.teamIdCache;
  }

  /** The account the credentials belong to. Also where the timezone comes from. */
  private async me(): Promise<RawUser> {
    if (this.meCache) return this.meCache;
    const body = await this.request<{ user: RawUser }>("GET", "/user");
    this.meCache = body.user;
    return this.meCache;
  }

  /** The zone due dates are written in. UTC only if ClickUp does not say. */
  private async timeZone(): Promise<string> {
    return (await this.me()).timezone || "UTC";
  }

  async actor(role: ActorRole): Promise<Actor> {
    const cached = this.actorCache.get(role);
    if (cached) return cached;

    const me = { user: await this.me() };
    let resolved: Actor;

    if (role === "ai") {
      resolved = actorOf(me.user);
    } else {
      const teams = await this.request<{ teams: { members: { user: RawUser }[] }[] }>(
        "GET",
        "/team",
      );
      const others = (teams.teams[0]?.members ?? [])
        .map((m) => m.user)
        .filter((u) => u.id !== me.user.id);
      // Guessing which of several people owns the work would hand tasks to the
      // wrong person, and the mistake is invisible until they notice.
      if (others.length !== 1) {
        throw new Error(
          `人間の担当者を特定できません: ワークスペースの他のメンバーが ${others.length} 人います。`,
        );
      }
      resolved = actorOf(others[0]);
    }

    this.actorCache.set(role, resolved);
    return resolved;
  }

  /**
   * The list's custom fields, by lowercased name.
   *
   * A ClickUp custom field is addressed by id, but a caller only knows the name
   * it sees on the board, and the two lists share their fields anyway.
   */
  private async fieldIds(listId: string): Promise<Map<string, string>> {
    const cached = this.fieldCache.get(listId);
    if (cached) return cached;

    const body = await this.request<{ fields: { id: string; name: string }[] }>(
      "GET",
      `/list/${listId}/field`,
    );
    const map = new Map(body.fields.map((f) => [f.name.toLowerCase(), f.id]));
    this.fieldCache.set(listId, map);
    return map;
  }

  /**
   * Writes named values onto a task, one request each.
   *
   * An unknown name throws rather than being skipped. The caller believes the
   * value was stored, and a quiet miss only surfaces when someone goes looking
   * for it — which, for a worktree path, is when they need it most.
   */
  private async setFields(
    taskId: TaskId,
    listId: string,
    fields: Record<string, string>,
  ): Promise<void> {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;

    const ids = await this.fieldIds(listId);
    for (const [name, value] of entries) {
      const id = ids.get(name.toLowerCase());
      if (!id) {
        throw new Error(
          `カスタム項目 "${name}" がリスト ${listId} にありません。` +
            `ClickUp 側で作ってください（現在: ${[...ids.keys()].join(", ") || "なし"}）。`,
        );
      }
      await this.request("POST", `/task/${taskId}/field/${id}`, { value });
    }
  }

  private async resolveAssignee(who: ActorRole | string): Promise<string> {
    return who === "ai" || who === "human" ? (await this.actor(who)).id : who;
  }

  // ─── Reading ──────────────────────────────────────────────────────

  private groupOfList(listId: string | undefined): TaskGroup | null {
    if (listId === this.lists.work) return "work";
    if (listId === this.lists.private) return "private";
    return null;
  }

  private toTask(raw: RawTask, timeZone: string): Task {
    const task: Task = {
      id: raw.id,
      title: raw.name,
      status: raw.status?.status ?? "",
      group: this.groupOfList(raw.list?.id),
      labels: raw.tags.map((t) => t.name),
      assignee: raw.assignees[0] ? actorOf(raw.assignees[0]) : null,
      url: raw.url,
      updatedAt: epochToIso(raw.date_updated),
      dueDate: raw.due_date ? localDate(raw.due_date, timeZone) : null,
      priority: priorityOf(raw),
    };
    const description = raw.markdown_description ?? raw.description;
    if (description !== undefined && description !== null) task.description = description;

    const fields = fieldsOf(raw);
    if (fields) task.fields = fields;
    return task;
  }

  /** Query parameters shared by every task read. */
  private baseParams(): URLSearchParams {
    const params = new URLSearchParams();
    // Terminal statuses are ordinary names here; letting ClickUp hide them by
    // type would put a status out of reach of `statuses`.
    params.set("include_closed", "true");
    params.set("subtasks", "true");
    // The plain `description` drops links, code spans and list markers.
    params.set("include_markdown_description", "true");
    return params;
  }

  /** Exposed for tests: this is where the domain filter becomes ClickUp's. */
  async toQuery(filter: TaskFilter): Promise<URLSearchParams> {
    const params = this.baseParams();

    for (const status of filter.statuses ?? []) params.append("statuses[]", status);
    // Tags are stored lowercase and this filter is case-sensitive, unlike
    // `statuses[]`. Sending the caller's case would match nothing.
    //
    // `tags[]` is an **or**, while the domain filter is an and, so this only
    // narrows the fetch — `matchesRest` does the actual conjunction.
    for (const label of filter.labels ?? []) params.append("tags[]", label.toLowerCase());

    if (filter.assignee && filter.assignee !== "none") {
      params.append("assignees[]", await this.resolveAssignee(filter.assignee));
    }
    if (filter.updatedBefore) {
      params.set("date_updated_lt", String(filter.updatedBefore.getTime()));
    }
    return params;
  }

  /**
   * Whatever ClickUp could not express, applied to the tasks it returned.
   *
   * Kept separate from `toQuery` so it is obvious which conditions cost a full
   * fetch: an unassigned-only query reads the list and throws most of it away.
   */
  private matchesRest(task: Task, filter: TaskFilter): boolean {
    if (filter.assignee === "none" && task.assignee) return false;
    if (filter.excludeStatuses?.some((s) => sameName(s, task.status))) return false;
    // ClickUp's `tags[]` matches a task carrying *any* of them; the domain
    // filter means all of them.
    if (filter.labels?.some((want) => !task.labels.some((have) => sameName(have, want)))) {
      return false;
    }
    return true;
  }

  private async fetchPages(path: string, params: URLSearchParams): Promise<RawTask[]> {
    const out: RawTask[] = [];
    for (let page = 0; ; page++) {
      params.set("page", String(page));
      const body = await this.request<{ tasks: RawTask[]; last_page?: boolean }>(
        "GET",
        `${path}?${params.toString()}`,
      );
      out.push(...body.tasks);
      if (body.last_page !== false || body.tasks.length === 0) break;
    }
    return out;
  }

  async list(filter: TaskFilter = {}): Promise<Task[]> {
    const params = await this.toQuery(filter);
    const timeZone = await this.timeZone();
    const lists = filter.group ? [this.lists[filter.group]] : [this.lists.work, this.lists.private];

    const tasks: Task[] = [];
    for (const listId of lists) {
      const raw = await this.fetchPages(`/list/${listId}/task`, new URLSearchParams(params));
      for (const item of raw) {
        // The list endpoint omits `list`, so the group comes from the query.
        const task = this.toTask({ ...item, list: item.list ?? { id: listId } }, timeZone);
        if (this.matchesRest(task, filter)) tasks.push(task);
      }
    }
    return tasks;
  }

  /**
   * The newest `count` comments, oldest first.
   *
   * ClickUp answers with **25 at a time, newest first**, and pages backwards
   * from the oldest entry of the previous page. Asking for more than 25 without
   * paging returns 25 and says nothing about it — and the child agents read the
   * last 40 to find the instructions they were handed, so a silent truncation
   * loses the newest half of a long thread's context.
   */
  private async comments(id: TaskId, count: number): Promise<TaskComment[]> {
    if (count <= 0) return [];

    const raw: RawComment[] = [];
    let cursor: RawComment | undefined;
    for (;;) {
      const query = cursor ? `?start=${Number(cursor.date)}&start_id=${cursor.id}` : "";
      const body = await this.request<{ comments: RawComment[] }>(
        "GET",
        `/task/${id}/comment${query}`,
      );
      raw.push(...body.comments);
      // 満たされたか、これ以上無いか。最後のページは 25 未満で返る
      if (raw.length >= count || body.comments.length < COMMENTS_PER_PAGE) break;
      cursor = body.comments[body.comments.length - 1];
    }

    return raw
      .map((c) => ({
        author: c.user?.username ?? "unknown",
        body: c.comment_text ?? "",
        createdAt: epochToIso(c.date),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-count);
  }

  private toDetail(raw: RawTask, comments: TaskComment[], timeZone: string): TaskDetail {
    const task = this.toTask(raw, timeZone);
    return { ...task, description: task.description ?? "", comments };
  }

  async get(id: TaskId, opts: { comments?: number } = {}): Promise<TaskDetail | null> {
    let raw: RawTask;
    try {
      raw = await this.request<RawTask>("GET", `/task/${id}?include_markdown_description=true`);
    } catch (error) {
      // "Missing" is a normal answer here, not a failure: callers ask about ids
      // that a human may have deleted.
      if (String(error).includes("(404)")) return null;
      throw error;
    }
    return this.toDetail(raw, await this.comments(id, opts.comments ?? 0), await this.timeZone());
  }

  async getMany(ids: TaskId[], opts: { comments?: number } = {}): Promise<TaskDetail[]> {
    if (ids.length === 0) return [];
    const teamId = await this.teamId();
    const timeZone = await this.timeZone();

    const found = new Map<TaskId, RawTask>();
    for (let i = 0; i < ids.length; i += TASK_IDS_PER_REQUEST) {
      const params = this.baseParams();
      for (const id of ids.slice(i, i + TASK_IDS_PER_REQUEST)) params.append("task_ids[]", id);
      for (const raw of await this.fetchPages(`/team/${teamId}/task`, params)) {
        found.set(raw.id, raw);
      }
    }

    const details: TaskDetail[] = [];
    for (const id of ids) {
      const raw = found.get(id);
      if (!raw) continue; // 存在しない id は落とす（provider の約束）
      details.push(this.toDetail(raw, await this.comments(id, opts.comments ?? 0), timeZone));
    }
    return details;
  }

  // ─── Writing ──────────────────────────────────────────────────────

  async create(input: NewTask): Promise<Task> {
    const body: Record<string, unknown> = {
      name: input.title,
      markdown_description: input.description ?? "",
    };
    if (input.status) body.status = input.status;
    if (input.labels?.length) body.tags = input.labels;
    if (input.assignee) body.assignees = [Number(await this.resolveAssignee(input.assignee))];

    const listId = this.lists[input.group];
    const created = await this.request<RawTask>("POST", `/list/${listId}/task`, body);
    if (input.fields) await this.setFields(created.id, listId, input.fields);

    // 作った直後に読み直す。ステータスやタグの実際の値は、こちらの指定ではなく
    // ワークスペースの側で決まる（ClickUp は名前を小文字にする）。
    const task = await this.get(created.id);
    if (!task) throw new Error(`作成したタスクを読み戻せません: ${created.id}`);
    const { description: _d, comments: _c, ...rest } = task;
    return rest;
  }

  async update(id: TaskId, patch: TaskPatch): Promise<void> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.name = patch.title;
    // 素の `description` は平文への射影なので、書くのは markdown のほう
    if (patch.description !== undefined) body.markdown_description = patch.description;
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.assignee !== undefined) {
      const current = await this.request<RawTask>("GET", `/task/${id}`);
      const next = Number(await this.resolveAssignee(patch.assignee));
      // ClickUp tasks hold a set of assignees; the domain has one. Removing the
      // others keeps "assigned to" a single answer.
      body.assignees = {
        add: [next],
        rem: current.assignees.map((a) => a.id).filter((existing) => existing !== next),
      };
    }
    if (Object.keys(body).length > 0) await this.request("PUT", `/task/${id}`, body);

    for (const name of patch.addLabels ?? []) {
      await this.ensureLabel(name);
      await this.request("POST", `/task/${id}/tag/${encodeURIComponent(name)}`);
    }

    if (patch.fields) {
      // フィールドの id はリスト単位なので、そのタスクがどちらに居るかを見る
      const task = await this.request<RawTask>("GET", `/task/${id}`);
      await this.setFields(id, task.list?.id ?? this.lists.work, patch.fields);
    }
  }

  async comment(id: TaskId, body: string): Promise<void> {
    // Plain markdown in `comment_text` is the only form that is stored, shown,
    // and readable back through every API. Rich blocks post with a 200 and then
    // display nothing at all.
    await this.request("POST", `/task/${id}/comment`, { comment_text: body, notify_all: false });
  }

  async updateLatestComment(id: TaskId, body: string): Promise<void> {
    const raw = await this.request<{ comments: RawComment[] }>("GET", `/task/${id}/comment`);
    const latest = [...raw.comments].sort(
      (a, b) => Number(b.date) - Number(a.date),
    )[0];
    if (!latest) throw new Error(`${id} にコメントがありません`);
    await this.request("PUT", `/comment/${latest.id}`, { comment_text: body });
  }

  async listLabels(): Promise<string[]> {
    const body = await this.request<{ tags: { name: string }[] }>(
      "GET",
      `/space/${await this.spaceId()}/tag`,
    );
    return body.tags.map((t) => t.name);
  }

  /**
   * Returns the name ClickUp actually stored, which is the lowercased one.
   *
   * ClickUp has no tag ids — a tag is its name — so the name is what a caller
   * can use afterwards, and returning the requested case would hand back
   * something that does not match what a later read reports.
   */
  async ensureLabel(name: string): Promise<string> {
    const existing = await this.listLabels();
    const already = existing.find((t) => sameName(t, name));
    if (already) return already;

    await this.request("POST", `/space/${await this.spaceId()}/tag`, {
      tag: { name, tag_fg: NEW_LABEL_COLOR, tag_bg: NEW_LABEL_COLOR },
    });
    return name.toLowerCase();
  }
}


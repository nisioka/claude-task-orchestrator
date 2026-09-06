import { LinearClient } from "@linear/sdk";
import {
  createPersonalClient,
  createIssueComment,
  createIssue,
  ensureLabel as ensureLinearLabel,
  fetchAllIssues,
  fetchAllIssuesWithDescription,
  fetchPersonalTeamId,
  fetchViewer,
  resolveTeamStateId,
  resolveHumanUserId,
  updateIssueAssignee,
  updateIssueStatus,
  addLabelToIssue,
  updateIssueTitle,
} from "../linear.js";
import type { TaskIssue } from "../types.js";
import type { TaskProvider } from "./provider.js";
import type {
  Actor,
  ActorRole,
  NewTask,
  Task,
  TaskDetail,
  TaskFilter,
  TaskGroup,
  TaskPriority,
  TaskId,
  TaskPatch,
} from "./types.js";

const GROUP_LABELS: Record<TaskGroup, string> = { work: "work", private: "private" };

/** Linear's own identifier shape: an uppercase team key, a dash, a number. */
const IDENTIFIER = /^[A-Z0-9]+-\d+$/;

/** Colour for labels this adapter creates. Linear rejects a label without one. */
const NEW_LABEL_COLOR = "#6B7280";

const DETAIL_QUERY = `
  query IssueDetail($teamKey: String!, $numbers: [Float!]!, $commentCount: Int!) {
    issues(filter: { team: { key: { eq: $teamKey } }, number: { in: $numbers } }) {
      nodes {
        identifier title url updatedAt dueDate description priority
        state { name type }
        assignee { id name email }
        labels { nodes { name } }
        comments(first: $commentCount, orderBy: updatedAt) {
          nodes { createdAt body user { name } }
        }
      }
    }
  }
`;

interface DetailNode {
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  dueDate: string | null;
  description: string | null;
  priority: number;
  state: { name: string; type: string };
  assignee: { id: string; name: string; email?: string } | null;
  labels: { nodes: { name: string }[] };
  comments: { nodes: { createdAt: string; body: string; user: { name: string } | null }[] };
}

/**
 * Groups identifiers by team key.
 *
 * Linear's or-filter ignores the number condition when several teams are mixed
 * into one query, so the numbers have to be asked for one team at a time.
 */
export function groupByTeam(identifiers: string[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const id of identifiers) {
    const match = IDENTIFIER.exec(id);
    if (!match) throw new Error(`識別子の形式が不正です: "${id}" ("ABC-123" のような形式)`);
    const [teamKey, number] = id.split("-");
    const bucket = groups.get(teamKey);
    if (bucket) bucket.push(Number(number));
    else groups.set(teamKey, [Number(number)]);
  }
  return groups;
}

const PRIORITY_BY_LINEAR_VALUE: Record<number, TaskPriority> = {
  1: "urgent",
  2: "high",
  3: "normal",
  4: "low",
};

function priorityOf(value: number): TaskPriority | null {
  return PRIORITY_BY_LINEAR_VALUE[value] ?? null;
}

function groupOf(labels: string[]): TaskGroup | null {
  // 綴りはワークスペース側が決める（`Work` のことも `work` のこともある）
  const lower = labels.map((l) => l.toLowerCase());
  if (lower.includes(GROUP_LABELS.private)) return "private";
  if (lower.includes(GROUP_LABELS.work)) return "work";
  return null;
}

function toTask(issue: TaskIssue): Task {
  return {
    id: issue.identifier,
    title: issue.title,
    status: issue.status,
    group: groupOf(issue.labels),
    labels: issue.labels,
    assignee: issue.assignee
      ? { id: issue.assignee.id, name: issue.assignee.name }
      : null,
    url: issue.url,
    updatedAt: issue.updatedAt,
    dueDate: issue.dueDate,
    priority: priorityOf(issue.priority),
  };
}

/**
 * Task provider backed by a Linear workspace.
 *
 * Translates the domain filter into Linear's GraphQL filter. That translation
 * is the whole point: `fetchAllIssues` already took an arbitrary filter, but it
 * was Linear's filter, so every caller was writing Linear.
 */
export class LinearTaskProvider implements TaskProvider {
  readonly name = "linear";

  private readonly client: LinearClient;
  private actorCache = new Map<ActorRole, Actor>();

  /**
   * Takes a key, or a client for tests. Building the client internally from a
   * key alone would make every test reach for the network.
   */
  constructor(apiKeyOrClient: string | LinearClient) {
    this.client =
      typeof apiKeyOrClient === "string" ? createPersonalClient(apiKeyOrClient) : apiKeyOrClient;
  }

  isValidId(value: string): boolean {
    return IDENTIFIER.test(value);
  }

  async actor(role: ActorRole): Promise<Actor> {
    const cached = this.actorCache.get(role);
    if (cached) return cached;

    const viewer = await fetchViewer(this.client);
    const resolved: Actor =
      role === "ai"
        ? { id: viewer.id, name: viewer.name, email: viewer.email }
        : await (async () => {
            const id = await resolveHumanUserId(
              this.client,
              viewer.id,
              process.env.LINEAR_HUMAN_USER_ID || undefined,
            );
            const user = await this.client.user(id);
            return { id, name: user.name, email: user.email };
          })();

    this.actorCache.set(role, resolved);
    return resolved;
  }

  /** Exposed for tests: this translation is where the vendor leak used to be. */
  async toLinearFilter(filter: TaskFilter): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const state: Record<string, unknown> = {};

    // 片方だけ代入すると、両方指定されたときに後勝ちで一方が消える
    const name: Record<string, unknown> = {};
    if (filter.statuses?.length) name.in = filter.statuses;
    if (filter.excludeStatuses?.length) name.nin = filter.excludeStatuses;
    if (Object.keys(name).length > 0) state.name = name;
    if (Object.keys(state).length > 0) out.state = state;

    const labels = [...(filter.labels ?? [])];
    if (filter.group) labels.push(GROUP_LABELS[filter.group]);
    if (labels.length > 0) {
      out.and = labels.map((name) => ({ labels: { some: { name: { eq: name } } } }));
    }

    if (filter.assignee === "none") {
      out.assignee = { null: true };
    } else if (filter.assignee) {
      const id =
        filter.assignee === "ai" || filter.assignee === "human"
          ? (await this.actor(filter.assignee)).id
          : filter.assignee;
      out.assignee = { id: { eq: id } };
    }

    if (filter.updatedBefore) out.updatedAt = { lte: filter.updatedBefore.toISOString() };

    return out;
  }

  async list(filter: TaskFilter = {}): Promise<Task[]> {
    const linearFilter = await this.toLinearFilter(filter);
    if (filter.withDescription) {
      const issues = await fetchAllIssuesWithDescription(this.client, linearFilter, "personal");
      return issues.map((i) => ({ ...toTask(i), description: i.description ?? "" }));
    }
    const issues = await fetchAllIssues(this.client, linearFilter, "personal");
    return issues.map(toTask);
  }

  async get(id: TaskId, opts: { comments?: number } = {}): Promise<TaskDetail | null> {
    const issue = await this.client.issue(id);
    if (!issue) return null;

    const [state, assignee, labels, comments] = await Promise.all([
      issue.state,
      issue.assignee,
      issue.labels(),
      opts.comments ? issue.comments({ last: opts.comments }) : Promise.resolve(null),
    ]);
    const labelNames = labels.nodes.map((l) => l.name);

    return {
      id: issue.identifier,
      title: issue.title,
      status: state?.name ?? "",
      group: groupOf(labelNames),
      labels: labelNames,
      assignee: assignee
        ? { id: assignee.id, name: assignee.name, email: assignee.email }
        : null,
      url: issue.url,
      updatedAt: issue.updatedAt.toISOString(),
      dueDate: issue.dueDate ?? null,
      priority: priorityOf(issue.priority),
      description: issue.description ?? "",
      comments: await Promise.all(
        (comments?.nodes ?? []).map(async (c) => ({
          author: (await c.user)?.name ?? "unknown",
          body: c.body,
          createdAt: c.createdAt.toISOString(),
        })),
      ),
    };
  }

  async getMany(ids: TaskId[], opts: { comments?: number } = {}): Promise<TaskDetail[]> {
    if (ids.length === 0) return [];
    const commentCount = opts.comments ?? 0;
    const found: DetailNode[] = [];

    for (const [teamKey, numbers] of groupByTeam(ids)) {
      const response = await this.client.client.rawRequest<
        { issues: { nodes: DetailNode[] } },
        Record<string, unknown>
      >(DETAIL_QUERY, { teamKey, numbers, commentCount });
      found.push(...(response.data?.issues.nodes ?? []));
    }

    const order = new Map(ids.map((id, index) => [id, index]));
    found.sort((a, b) => (order.get(a.identifier) ?? 0) - (order.get(b.identifier) ?? 0));

    return found.map((node) => {
      const labels = node.labels.nodes.map((l) => l.name);
      return {
        id: node.identifier,
        title: node.title,
        status: node.state.name,
        group: groupOf(labels),
        labels,
        assignee: node.assignee
          ? { id: node.assignee.id, name: node.assignee.name, email: node.assignee.email }
          : null,
        url: node.url,
        updatedAt: node.updatedAt,
        dueDate: node.dueDate,
        priority: priorityOf(node.priority),
        description: node.description ?? "",
        comments: node.comments.nodes.map((c) => ({
          author: c.user?.name ?? "unknown",
          body: c.body,
          createdAt: c.createdAt,
        })),
      };
    });
  }

  /**
   * Linear has no per-issue custom fields, so there is nowhere to put these.
   *
   * Throwing rather than ignoring: the caller wrote the value expecting it to
   * be findable later, and a silent drop is only discovered by whoever goes
   * looking for it.
   */
  private rejectFields(fields: Record<string, string> | undefined): void {
    if (!fields || Object.keys(fields).length === 0) return;
    throw new Error(
      `Linear にはカスタム項目がありません: ${Object.keys(fields).join(", ")}。` +
        `本文かコメントへ書いてください。`,
    );
  }

  async create(input: NewTask): Promise<Task> {
    this.rejectFields(input.fields);
    const teamId = await fetchPersonalTeamId(this.client);
    const labelIds: string[] = [];
    for (const name of [...(input.labels ?? []), GROUP_LABELS[input.group]]) {
      labelIds.push(await ensureLinearLabel(this.client, name, NEW_LABEL_COLOR));
    }
    const assigneeId = input.assignee
      ? input.assignee === "ai" || input.assignee === "human"
        ? (await this.actor(input.assignee)).id
        : input.assignee
      : undefined;

    const created = await createIssue(this.client, {
      teamId,
      title: input.title,
      description: input.description ?? "",
      labelIds,
      assigneeId,
      stateId: input.status ? await resolveTeamStateId(this.client, teamId, input.status) : undefined,
    });

    // 作った直後に読み直す。ステータスやラベルの実際の値は、こちらの指定ではなく
    // ワークスペースの既定で決まることがあり、呼び出し側にはそちらを返したい。
    const task = await this.get(created.identifier);
    if (!task) throw new Error(`作成したタスクを読み戻せません: ${created.identifier}`);
    const { description: _d, comments: _c, ...rest } = task;
    return rest;
  }

  async update(id: TaskId, patch: TaskPatch): Promise<void> {
    this.rejectFields(patch.fields);
    const issue = await this.client.issue(id);
    if (!issue) throw new Error(`タスクが見つかりません: ${id}`);

    if (patch.title !== undefined) await updateIssueTitle(this.client, issue.id, patch.title);
    if (patch.status !== undefined) await updateIssueStatus(this.client, issue.id, patch.status);
    if (patch.assignee !== undefined) {
      const assigneeId =
        patch.assignee === "ai" || patch.assignee === "human"
          ? (await this.actor(patch.assignee)).id
          : patch.assignee;
      await updateIssueAssignee(this.client, issue.id, assigneeId);
    }
    for (const name of patch.addLabels ?? []) {
      const teamId = await fetchPersonalTeamId(this.client);
      await addLabelToIssue(this.client, issue.id, await ensureLinearLabel(this.client, name, NEW_LABEL_COLOR));
    }
  }

  async comment(id: TaskId, body: string): Promise<void> {
    const issue = await this.client.issue(id);
    if (!issue) throw new Error(`タスクが見つかりません: ${id}`);
    await createIssueComment(this.client, issue.id, body);
  }

  async updateLatestComment(id: TaskId, body: string): Promise<void> {
    const issue = await this.client.issue(id);
    if (!issue) throw new Error(`タスクが見つかりません: ${id}`);
    const comments = await issue.comments({ first: 50 });
    const latest = [...comments.nodes].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];
    if (!latest) throw new Error(`${id} にコメントがありません`);
    await this.client.updateComment(latest.id, { body });
  }

  async listLabels(): Promise<string[]> {
    const labels = await this.client.issueLabels();
    return labels.nodes.map((l) => l.name);
  }

  async ensureLabel(name: string): Promise<string> {
    const teamId = await fetchPersonalTeamId(this.client);
    return ensureLinearLabel(this.client, name, NEW_LABEL_COLOR);
  }
}

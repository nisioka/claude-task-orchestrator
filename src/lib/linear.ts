import { LinearClient } from "@linear/sdk";
import type { IssueAssignee, TaskIssue, TaskIssueWithDescription } from "./types.js";
import { TERMINAL_STATE_TYPES } from "./types.js";

// ─── Client Factories ────────────────────────────────────────────────

export function createPersonalClient(apiKey: string): LinearClient {
  return new LinearClient({ apiKey });
}


// ─── GraphQL Types ───────────────────────────────────────────────────

/** Shape of a single issue node returned by the GraphQL query. */
export interface GraphQLIssueNode {
  id: string;
  title: string;
  identifier: string;
  dueDate: string | null;
  updatedAt: string;
  priority: number;
  url: string;
  state: { name: string; type: string };
  team: { name: string; key: string } | null;
  labels: { nodes: Array<{ name: string }> };
  projectMilestone: { name: string } | null;
  assignee: IssueAssignee | null;
}

/** Shape of a single issue node with description field. */
export interface GraphQLIssueWithDescriptionNode extends GraphQLIssueNode {
  description: string | null;
}

/** Top-level shape of the issues-with-description query response. */
export interface GraphQLIssuesWithDescriptionResponse {
  issues: {
    nodes: GraphQLIssueWithDescriptionNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/** Top-level shape of the issues query response. */
export interface GraphQLIssuesResponse {
  issues: {
    nodes: GraphQLIssueNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

// ─── GraphQL Query ───────────────────────────────────────────────────

const ISSUES_QUERY = `
  query FetchIssues($filter: IssueFilter!, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        title
        identifier
        dueDate
        updatedAt
        priority
        url
        state { name type }
        team { name key }
        labels { nodes { name } }
        projectMilestone { name }
        assignee { id name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUES_WITH_DESCRIPTION_QUERY = `
  query FetchIssuesWithDescription($filter: IssueFilter!, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        title
        identifier
        description
        dueDate
        updatedAt
        priority
        url
        state { name type }
        team { name key }
        labels { nodes { name } }
        projectMilestone { name }
        assignee { id name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ─── Paginated Fetcher ───────────────────────────────────────────────

const MAX_PAGES = 50;

/**
 * Generic paginated issue fetcher. Internal helper that encapsulates the
 * shared pagination loop so callers only need to supply the query string
 * and a node-mapping function.
 */
async function fetchAllIssuesGeneric<
  TNode extends GraphQLIssueNode,
  TResponse extends { issues: { nodes: TNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } },
  TResult,
>(
  client: LinearClient,
  query: string,
  filter: Record<string, unknown>,
  mapNode: (node: TNode) => TResult,
): Promise<TResult[]> {
  const results: TResult[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageCount = 0;

  while (hasNextPage) {
    pageCount++;
    if (pageCount > MAX_PAGES) {
      throw new Error(`Pagination limit of ${MAX_PAGES} pages exceeded. Consider optimizing the query filter to reduce result count.`);
    }
    const variables: Record<string, unknown> = { filter, first: 100 };
    if (cursor) variables.after = cursor;

    const response = await client.client.rawRequest<TResponse, Record<string, unknown>>(query, variables);

    if (!response.data) {
      throw new Error("Linear API returned no data");
    }

    for (const node of response.data.issues.nodes) {
      results.push(mapNode(node));
    }

    hasNextPage = response.data.issues.pageInfo.hasNextPage;
    cursor = response.data.issues.pageInfo.endCursor;
  }

  return results;
}

/**
 * Fetch all issues matching `filter` via raw GraphQL, handling pagination.
 * Uses a single query with nested fields to avoid N+1 round-trips.
 */
export async function fetchAllIssues(
  client: LinearClient,
  filter: Record<string, unknown>,
  source: "personal" | "company",
): Promise<TaskIssue[]> {
  return fetchAllIssuesGeneric<GraphQLIssueNode, GraphQLIssuesResponse, TaskIssue>(
    client, ISSUES_QUERY, filter,
    (node) => ({
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      status: node.state.name,
      statusType: node.state.type,
      priority: node.priority,
      dueDate: node.dueDate,
      updatedAt: node.updatedAt,
      teamName: node.team?.name ?? "Unknown",
      teamKey: node.team?.key ?? "???",
      labels: node.labels.nodes.map((l) => l.name),
      url: node.url,
      source,
      milestone: node.projectMilestone?.name ?? null,
      assignee: node.assignee ?? null,
    }),
  );
}

/**
 * Fetch all issues matching `filter` with description field, handling pagination.
 */
export async function fetchAllIssuesWithDescription(
  client: LinearClient,
  filter: Record<string, unknown>,
  source: "personal" | "company",
): Promise<TaskIssueWithDescription[]> {
  return fetchAllIssuesGeneric<GraphQLIssueWithDescriptionNode, GraphQLIssuesWithDescriptionResponse, TaskIssueWithDescription>(
    client, ISSUES_WITH_DESCRIPTION_QUERY, filter,
    (node) => ({
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description ?? null,
      status: node.state.name,
      statusType: node.state.type,
      priority: node.priority,
      dueDate: node.dueDate,
      updatedAt: node.updatedAt,
      teamName: node.team?.name ?? "Unknown",
      teamKey: node.team?.key ?? "???",
      labels: node.labels.nodes.map((l) => l.name),
      url: node.url,
      source,
      milestone: node.projectMilestone?.name ?? null,
      assignee: node.assignee ?? null,
    }),
  );
}

// ─── Company Sync Helpers ───────────────────────────────────────────

/**
 * Fetch the first team ID from the personal workspace.
 */
export async function fetchPersonalTeamId(
  client: LinearClient,
): Promise<string> {
  const teams = await client.teams();
  const first = teams.nodes[0];
  if (!first) {
    throw new Error("No teams found in personal workspace");
  }
  return first.id;
}

/**
 * Return the id of a label, creating it if it does not exist yet.
 * Labels classify; they never carry workflow state (requirement 3.10).
 */
export async function ensureLabel(
  client: LinearClient,
  name: string,
  color: string,
): Promise<string> {
  // Linear treats label names as case-insensitively unique: asking for "work"
  // when "Work" exists fails the create with a duplicate-name error rather than
  // returning the existing one. Match the same way it does.
  const labels = await client.issueLabels({ filter: { name: { eqIgnoreCase: name } } });
  const existing = labels.nodes.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    return existing.id;
  }

  const result = await client.createIssueLabel({ name, color });
  const created = await result.issueLabel;
  if (!created) {
    throw new Error(`Failed to create ${name} label`);
  }
  return created.id;
}

/**
 * Create an issue in the task source's team.
 */
export async function createIssue(
  client: LinearClient,
  input: {
    title: string;
    description: string;
    teamId: string;
    labelIds: string[];
    assigneeId?: string;
    stateId?: string;
  },
): Promise<{ id: string; identifier: string }> {
  const result = await client.createIssue({
    title: input.title,
    description: input.description,
    teamId: input.teamId,
    labelIds: input.labelIds,
    assigneeId: input.assigneeId,
    stateId: input.stateId,
    priority: 3, // Medium
  });
  const created = await result.issue;
  if (!created) {
    throw new Error("Failed to create synced issue");
  }
  return { id: created.id, identifier: created.identifier };
}

/**
 * Update an issue's title.
 */
export async function updateIssueTitle(
  client: LinearClient,
  issueId: string,
  newTitle: string,
): Promise<void> {
  await client.updateIssue(issueId, { title: newTitle });
}

/**
 * Add a single label to an issue without touching its other labels.
 * Uses the dedicated issueAddLabel mutation (not updateIssue, which would
 * replace the whole label set).
 */
export async function addLabelToIssue(
  client: LinearClient,
  issueId: string,
  labelId: string,
): Promise<void> {
  await client.issueAddLabel(issueId, labelId);
}


// ─── PJ Label Fetcher ───────────────────────────────────────────────

// ─── Active Synced Issues ───────────────────────────────────────────

// ─── Company Issues by Identifiers ──────────────────────────────────


// ─── Personal Issues by Labels ──────────────────────────────────────

/**
 * Fetch personal issues that have ALL specified labels.
 * Returns issues with description.
 */
export async function fetchPersonalIssuesByLabels(
  client: LinearClient,
  labelNames: string[],
): Promise<TaskIssueWithDescription[]> {
  if (labelNames.length === 0) {
    return [];
  }

  const andFilter = labelNames.map((labelName) => ({
    labels: { some: { name: { eq: labelName } } },
  }));

  return fetchAllIssuesWithDescription(
    client,
    { and: andFilter },
    "personal",
  );
}


// ─── Issue Mutations ────────────────────────────────────────────────

/**
 * Resolve a workflow state name to its ID within a team.
 *
 * Needed at issue *creation* time: Linear falls back to the team's default
 * state when none is given, and that default is `Backlog` — a status the
 * orchestrator is required to leave alone (要件 4.5). A mirror created there
 * never moves.
 */
export async function resolveTeamStateId(
  client: LinearClient,
  teamId: string,
  statusName: string,
): Promise<string> {
  const team = await client.team(teamId);
  const states = await team.states();
  const targetState = states.nodes.find((s) => s.name === statusName);
  if (!targetState) {
    throw new Error(`ステータス "${statusName}" がチーム "${team.name}" に見つかりません`);
  }
  return targetState.id;
}

/**
 * Update an issue's status by status name.
 * Resolves the status name to a state ID by querying the issue's team states.
 */
export async function updateIssueStatus(
  client: LinearClient,
  issueId: string,
  statusName: string,
): Promise<void> {
  // Get the issue to find its team
  const issue = await client.issue(issueId);
  const team = await issue.team;
  if (!team) {
    throw new Error(`Issue ${issueId} のチームが見つかりません`);
  }

  // Get team's workflow states
  const states = await team.states();
  const targetState = states.nodes.find((s) => s.name === statusName);
  if (!targetState) {
    throw new Error(`ステータス "${statusName}" がチーム "${team.name}" に見つかりません`);
  }

  await client.updateIssue(issueId, { stateId: targetState.id });
}

// ─── Ownership (assignee) ───────────────────────────────────────────

/** The Linear user behind the API key in use. */
export interface Viewer {
  id: string;
  name: string;
  email: string;
}

const VIEWER_QUERY = `
  query FetchViewer {
    viewer { id name email }
  }
`;

/**
 * Resolve the authenticated user from the API key itself.
 *
 * The AI user's identifier is deliberately never a configuration value: a
 * hard-coded UUID goes stale the moment the workspace user is recreated.
 */
export async function fetchViewer(client: LinearClient): Promise<Viewer> {
  const response = await client.client.rawRequest<{ viewer: Viewer }, Record<string, unknown>>(
    VIEWER_QUERY,
    {},
  );
  const viewer = response.data?.viewer;
  if (!viewer) {
    throw new Error("Linear API から viewer を取得できませんでした");
  }
  return { id: viewer.id, name: viewer.name, email: viewer.email };
}

/**
 * Change an issue's assignee. Pass `null` to clear it.
 *
 * This is not merely a field update. Handing an issue to a human by changing
 * its assignee is the *primary* channel by which the human is told there is
 * something for them to do — Linear's own notification fires on this change,
 * and the Discord notification is only a secondary echo. Treat a failure here
 * as a failure to reach the human.
 */
export async function updateIssueAssignee(
  client: LinearClient,
  issueId: string,
  assigneeId: string | null,
): Promise<void> {
  await client.updateIssue(issueId, { assigneeId });
}

/**
 * State types the orchestrator never acts on, whoever holds the issue.
 *
 * `completed` / `canceled` / `duplicate` are finished work — Linear gives
 * Duplicate its own type rather than folding it into canceled, so it has to be
 * listed. `backlog` is the human's not-yet pool, left alone on purpose
 * (要件 4.5) — it is also the team's default landing state, so anything that
 * arrives there arrived by omission.
 */
const NON_ACTIONABLE_STATE_TYPES = ["completed", "canceled", "duplicate", "backlog"];

/**
 * Fetch the issues that are the AI's ball: assigned to the AI user and not yet
 * finished.
 *
 * The filter is by *assignee*, not by status. Status records what has happened
 * to an issue; it does not decide whether the orchestrator may pick it up.
 * Filtering on a status allowlist silently hid work the human handed over by
 * reassigning without moving the status — an `In Review` issue reassigned to
 * the AI with the review feedback in its comments never appeared here at all,
 * so the orchestrator could not read the comments it was being pointed at.
 */
export async function fetchIssuesAssignedTo(
  client: LinearClient,
  assigneeId: string,
): Promise<TaskIssueWithDescription[]> {
  return fetchAllIssuesWithDescription(
    client,
    {
      assignee: { id: { eq: assigneeId } },
      state: { type: { nin: NON_ACTIONABLE_STATE_TYPES } },
    },
    "personal",
  );
}

/**
 * Fetch issues whose ball is with a human: assigned to somebody who is not the
 * AI user. Unassigned issues are excluded — nobody owns them, so nobody is
 * being kept waiting.
 */
/**
 * Resolve the human member of the personal workspace.
 *
 * Hard-coding the id would rot the same way an AI user id would (requirement
 * 3.3), so it is derived: everyone who is neither the caller nor one of
 * Linear's own service accounts. Ambiguity is an error rather than a guess —
 * assigning a human's work to the wrong account loses it silently.
 */
export async function resolveHumanUserId(
  client: LinearClient,
  viewerId: string,
  override?: string,
): Promise<string> {
  if (override) return override;

  const users = await client.users();
  const candidates = users.nodes.filter(
    (u) => u.id !== viewerId && u.active && !u.email?.endsWith("@linear.linear.app"),
  );

  if (candidates.length === 1) return candidates[0].id;
  if (candidates.length === 0) {
    throw new Error(
      "個人ワークスペースに人間のメンバーが見つかりません。" +
        "LINEAR_HUMAN_USER_ID で明示してください。",
    );
  }
  throw new Error(
    `人間のメンバーを一意に決められません (${candidates.length}人): ` +
      `${candidates.map((u) => u.name).join(", ")}。LINEAR_HUMAN_USER_ID で明示してください。`,
  );
}


/**
 * Add a comment to a Linear issue.
 */
export async function createIssueComment(
  client: LinearClient,
  issueId: string,
  body: string,
): Promise<void> {
  await client.createComment({ issueId, body });
}

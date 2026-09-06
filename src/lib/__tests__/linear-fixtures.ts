import { vi } from "vitest";
import { LinearClient } from "@linear/sdk";
import type { LinearRawResponse } from "@linear/sdk";
import type { GraphQLIssueNode, GraphQLIssuesResponse } from "../linear.js";

/** Shared by the personal-side and company-side Linear tests. */
export function makeNode(overrides: Partial<GraphQLIssueNode> = {}): GraphQLIssueNode {
  return {
    id: overrides.id ?? "issue-1",
    title: overrides.title ?? "Test issue",
    identifier: overrides.identifier ?? "PERS-1",
    dueDate: overrides.dueDate ?? null,
    updatedAt: overrides.updatedAt ?? "2026-02-23T10:00:00.000Z",
    priority: overrides.priority ?? 3,
    url: overrides.url ?? "https://linear.app/workspace/issue/PERS-1",
    state: overrides.state ?? { name: "Todo", type: "unstarted" },
    team: overrides.team === undefined ? { name: "Personal", key: "PERS" } : overrides.team,
    labels: overrides.labels ?? { nodes: [{ name: "work" }] },
    projectMilestone: overrides.projectMilestone === undefined ? null : overrides.projectMilestone,
    assignee: overrides.assignee === undefined ? null : overrides.assignee,
  };
}

export function makeSinglePageResponse(
  nodes: GraphQLIssueNode[],
): GraphQLIssuesResponse {
  return {
    issues: {
      nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

export function createMockClient(
  responses: GraphQLIssuesResponse[],
): { mockClient: LinearClient; rawRequest: ReturnType<typeof vi.fn> } {
  let callIndex = 0;
  const rawRequest = vi.fn(async () => {
    const data =
      responses[callIndex++] ??
      makeSinglePageResponse([]);
    return { data } as LinearRawResponse<GraphQLIssuesResponse>;
  });

  const mockClient = {
    client: { rawRequest },
  } as unknown as LinearClient;

  return { mockClient, rawRequest };
}

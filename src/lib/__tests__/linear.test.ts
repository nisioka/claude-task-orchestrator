import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearClient } from "@linear/sdk";
import { makeNode, makeSinglePageResponse, createMockClient } from "./linear-fixtures.js";
import type { LinearRawResponse } from "@linear/sdk";
import {
  createPersonalClient,
  fetchAllIssues,
  fetchPersonalTeamId,
  createIssue,
  updateIssueTitle,
  fetchAllIssuesWithDescription,
  fetchPersonalIssuesByLabels,
  updateIssueStatus,
  createIssueComment,
  fetchViewer,
  updateIssueAssignee,
  fetchIssuesAssignedTo,
} from "../linear.js";
import type {
  GraphQLIssueNode,
  GraphQLIssuesResponse,
  GraphQLIssueWithDescriptionNode,
  GraphQLIssuesWithDescriptionResponse,
} from "../linear.js";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Build a minimal GraphQL issue node for testing. */

// ─── Tests ───────────────────────────────────────────────────────────

describe("createPersonalClient", () => {
  it("returns a LinearClient instance", () => {
    const client = createPersonalClient("lin_api_test_key");
    expect(client).toBeInstanceOf(LinearClient);
  });
});

describe("fetchAllIssues edge cases", () => {
  it("maps every field of a node to a TaskIssue", async () => {
    const node = makeNode({
      id: "wait-1",
      identifier: "PERS-10",
      title: "Waiting for response",
      dueDate: "2026-02-22",
      updatedAt: "2026-02-20T08:00:00.000Z",
      priority: 2,
      state: { name: "Wait", type: "started" },
      team: { name: "Personal", key: "PERS" },
      labels: { nodes: [{ name: "work" }] },
      url: "https://linear.app/workspace/issue/PERS-10",
    });
    const { mockClient, rawRequest } = createMockClient([makeSinglePageResponse([node])]);

    const result = await fetchAllIssues(mockClient, { foo: "bar" }, "personal");

    const variables = rawRequest.mock.calls[0][1] as Record<string, unknown>;
    expect(variables.filter).toEqual({ foo: "bar" });
    expect(variables.first).toBe(100);
    expect(result).toEqual([
      {
        id: "wait-1",
        identifier: "PERS-10",
        title: "Waiting for response",
        status: "Wait",
        statusType: "started",
        priority: 2,
        dueDate: "2026-02-22",
        updatedAt: "2026-02-20T08:00:00.000Z",
        teamName: "Personal",
        teamKey: "PERS",
        labels: ["work"],
        url: "https://linear.app/workspace/issue/PERS-10",
        source: "personal",
        milestone: null,
        assignee: null,
      },
    ]);
  });

  it("follows the cursor until the last page", async () => {
    const page1: GraphQLIssuesResponse = {
      issues: {
        nodes: [makeNode({ id: "p1", identifier: "PERS-1" })],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      },
    };
    const page2: GraphQLIssuesResponse = {
      issues: {
        nodes: [makeNode({ id: "p2", identifier: "PERS-2" })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    const { mockClient, rawRequest } = createMockClient([page1, page2]);

    const result = await fetchAllIssues(mockClient, {}, "personal");

    expect(rawRequest).toHaveBeenCalledTimes(2);
    const secondCallVariables = rawRequest.mock.calls[1][1] as Record<string, unknown>;
    expect(secondCallVariables.after).toBe("cursor-1");
    expect(result.map((i) => i.id)).toEqual(["p1", "p2"]);
  });

  it("maps team to defaults when team is null", async () => {
    const node = makeNode({ team: null, labels: { nodes: [] } });
    const { mockClient } = createMockClient([makeSinglePageResponse([node])]);

    const result = await fetchAllIssues(mockClient, {}, "personal");

    expect(result[0].teamName).toBe("Unknown");
    expect(result[0].teamKey).toBe("???");
    expect(result[0].labels).toEqual([]);
  });

  it("maps projectMilestone.name to milestone when present", async () => {
    const node = makeNode({ projectMilestone: { name: "Sprint 42" } });
    const { mockClient } = createMockClient([makeSinglePageResponse([node])]);

    const result = await fetchAllIssues(mockClient, {}, "personal");

    expect(result[0].milestone).toBe("Sprint 42");
  });

  it("maps milestone to null when projectMilestone is null", async () => {
    const node = makeNode({ projectMilestone: null });
    const { mockClient } = createMockClient([makeSinglePageResponse([node])]);

    const result = await fetchAllIssues(mockClient, {}, "personal");

    expect(result[0].milestone).toBeNull();
  });

  it("throws when API returns no data", async () => {
    const rawRequest = vi.fn(async () => {
      return { data: undefined } as LinearRawResponse<GraphQLIssuesResponse>;
    });
    const mockClient = {
      client: { rawRequest },
    } as unknown as LinearClient;

    await expect(
      fetchAllIssues(mockClient, {}, "personal"),
    ).rejects.toThrow("Linear API returned no data");
  });
});

// ─── Description query helpers ──────────────────────────────────────

function makeNodeWithDescription(
  overrides: Partial<GraphQLIssueWithDescriptionNode> = {},
): GraphQLIssueWithDescriptionNode {
  return {
    ...makeNode(overrides),
    description: overrides.description ?? null,
  };
}

function makeSinglePageDescriptionResponse(
  nodes: GraphQLIssueWithDescriptionNode[],
): GraphQLIssuesWithDescriptionResponse {
  return {
    issues: {
      nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function createMockDescriptionClient(
  responses: GraphQLIssuesWithDescriptionResponse[],
): { mockClient: LinearClient; rawRequest: ReturnType<typeof vi.fn> } {
  let callIndex = 0;
  const rawRequest = vi.fn(async () => {
    const data =
      responses[callIndex++] ??
      makeSinglePageDescriptionResponse([]);
    return { data } as LinearRawResponse<GraphQLIssuesWithDescriptionResponse>;
  });

  const mockClient = {
    client: { rawRequest },
  } as unknown as LinearClient;

  return { mockClient, rawRequest };
}

// ─── fetchAllIssuesWithDescription ──────────────────────────────────

// ─── fetchAllIssuesWithDescription ──────────────────────────────────

describe("fetchAllIssuesWithDescription", () => {
  it("maps description field correctly", async () => {
    const node = makeNodeWithDescription({
      description: "Some description text",
    });
    const { mockClient } = createMockDescriptionClient([
      makeSinglePageDescriptionResponse([node]),
    ]);

    const result = await fetchAllIssuesWithDescription(mockClient, {}, "personal");

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Some description text");
  });

  it("maps null description correctly", async () => {
    const node = makeNodeWithDescription({ description: null });
    const { mockClient } = createMockDescriptionClient([
      makeSinglePageDescriptionResponse([node]),
    ]);

    const result = await fetchAllIssuesWithDescription(mockClient, {}, "personal");

    expect(result[0].description).toBeNull();
  });
});

// ─── fetchPersonalTeamId ────────────────────────────────────────────

// ─── fetchPersonalTeamId ────────────────────────────────────────────

describe("fetchPersonalTeamId", () => {
  it("returns the first team ID", async () => {
    const mockClient = {
      teams: vi.fn(async () => ({
        nodes: [{ id: "team-abc" }],
      })),
    } as unknown as LinearClient;

    const result = await fetchPersonalTeamId(mockClient);

    expect(result).toBe("team-abc");
  });

  it("throws when no teams found", async () => {
    const mockClient = {
      teams: vi.fn(async () => ({
        nodes: [],
      })),
    } as unknown as LinearClient;

    await expect(fetchPersonalTeamId(mockClient)).rejects.toThrow(
      "No teams found in personal workspace",
    );
  });
});

// ─── createIssue ─────────────────────────────────────────────

describe("createIssue", () => {
  it("creates an issue and returns id and identifier", async () => {
    const mockClient = {
      createIssue: vi.fn(async () => ({
        issue: Promise.resolve({ id: "new-id", identifier: "PERS-100" }),
      })),
    } as unknown as LinearClient;

    const result = await createIssue(mockClient, {
      title: "Test issue",
      description: "<!-- company-linear-id: ENG-1 -->",
      teamId: "team-1",
      labelIds: ["label-1"],
    });

    expect(result).toEqual({ id: "new-id", identifier: "PERS-100" });
    expect(mockClient.createIssue).toHaveBeenCalledWith({
      title: "Test issue",
      description: "<!-- company-linear-id: ENG-1 -->",
      teamId: "team-1",
      labelIds: ["label-1"],
      priority: 3,
    });
  });

  it("assigns the issue when assigneeId is provided", async () => {
    const mockClient = {
      createIssue: vi.fn(async () => ({
        issue: Promise.resolve({ id: "new-id", identifier: "PERS-100" }),
      })),
    } as unknown as LinearClient;

    await createIssue(mockClient, {
      title: "Test issue",
      description: "desc",
      teamId: "team-1",
      labelIds: ["label-1"],
      assigneeId: "ai-user",
    });

    expect(mockClient.createIssue).toHaveBeenCalledWith({
      title: "Test issue",
      description: "desc",
      teamId: "team-1",
      labelIds: ["label-1"],
      assigneeId: "ai-user",
      priority: 3,
    });
  });

  it("throws when issue creation fails", async () => {
    const mockClient = {
      createIssue: vi.fn(async () => ({
        issue: Promise.resolve(null),
      })),
    } as unknown as LinearClient;

    await expect(
      createIssue(mockClient, {
        title: "Test",
        description: "desc",
        teamId: "team-1",
        labelIds: [],
      }),
    ).rejects.toThrow("Failed to create synced issue");
  });
});

// ─── updateIssueTitle ───────────────────────────────────────────────

// ─── updateIssueTitle ───────────────────────────────────────────────

describe("updateIssueTitle", () => {
  it("calls updateIssue with correct parameters", async () => {
    const mockClient = {
      updateIssue: vi.fn(async () => ({})),
    } as unknown as LinearClient;

    await updateIssueTitle(mockClient, "issue-id", "New title");

    expect(mockClient.updateIssue).toHaveBeenCalledWith("issue-id", {
      title: "New title",
    });
  });
});

// ─── parseIdentifier ────────────────────────────────────────────────

// ─── fetchCompanyIssuesByIdentifiers ────────────────────────────────

// ─── fetchPersonalIssuesByLabels ────────────────────────────────────

describe("fetchPersonalIssuesByLabels", () => {
  it("builds correct and filter from 2 labels", async () => {
    const node = makeNodeWithDescription({
      id: "pl-1",
      identifier: "PERS-80",
      title: "Labeled issue",
      labels: { nodes: [{ name: "work" }, { name: "urgent" }] },
    });
    const { mockClient, rawRequest } = createMockDescriptionClient([
      makeSinglePageDescriptionResponse([node]),
    ]);

    const result = await fetchPersonalIssuesByLabels(mockClient, [
      "work",
      "urgent",
    ]);

    expect(rawRequest).toHaveBeenCalledOnce();
    const variables = rawRequest.mock.calls[0][1] as Record<string, unknown>;
    expect(variables.filter).toEqual({
      and: [
        { labels: { some: { name: { eq: "work" } } } },
        { labels: { some: { name: { eq: "urgent" } } } },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("personal");
  });

  it("works correctly with a single label", async () => {
    const node = makeNodeWithDescription({
      id: "pl-2",
      identifier: "PERS-81",
      title: "Single label issue",
      labels: { nodes: [{ name: "private" }] },
    });
    const { mockClient, rawRequest } = createMockDescriptionClient([
      makeSinglePageDescriptionResponse([node]),
    ]);

    const result = await fetchPersonalIssuesByLabels(mockClient, ["private"]);

    expect(rawRequest).toHaveBeenCalledOnce();
    const variables = rawRequest.mock.calls[0][1] as Record<string, unknown>;
    expect(variables.filter).toEqual({
      and: [
        { labels: { some: { name: { eq: "private" } } } },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("personal");
  });
});

// ─── fetchTodoIssuesWithRepoLabels ──────────────────────────────────

// ─── updateIssueStatus ──────────────────────────────────────────────

describe("updateIssueStatus", () => {
  it("resolves state ID from name and updates issue", async () => {
    const mockClient = {
      issue: vi.fn(async () => ({
        team: Promise.resolve({
          name: "Work",
          states: vi.fn(async () => ({
            nodes: [
              { id: "state-todo", name: "Todo" },
              { id: "state-review", name: "In Review" },
            ],
          })),
        }),
      })),
      updateIssue: vi.fn(async () => ({})),
    } as unknown as LinearClient;

    await updateIssueStatus(mockClient, "issue-1", "In Review");

    expect(mockClient.updateIssue).toHaveBeenCalledWith("issue-1", { stateId: "state-review" });
  });

  it("throws when team not found", async () => {
    const mockClient = {
      issue: vi.fn(async () => ({
        team: Promise.resolve(null),
      })),
    } as unknown as LinearClient;

    await expect(updateIssueStatus(mockClient, "issue-1", "In Review"))
      .rejects.toThrow("チームが見つかりません");
  });

  it("throws when status name not found", async () => {
    const mockClient = {
      issue: vi.fn(async () => ({
        team: Promise.resolve({
          name: "Work",
          states: vi.fn(async () => ({
            nodes: [{ id: "state-todo", name: "Todo" }],
          })),
        }),
      })),
    } as unknown as LinearClient;

    await expect(updateIssueStatus(mockClient, "issue-1", "NonExistent"))
      .rejects.toThrow('ステータス "NonExistent"');
  });
});

// ─── createIssueComment ─────────────────────────────────────────────

// ─── createIssueComment ─────────────────────────────────────────────

describe("createIssueComment", () => {
  it("calls createComment with correct params", async () => {
    const mockClient = {
      createComment: vi.fn(async () => ({})),
    } as unknown as LinearClient;

    await createIssueComment(mockClient, "issue-1", "PR created: https://github.com/...");

    expect(mockClient.createComment).toHaveBeenCalledWith({
      issueId: "issue-1",
      body: "PR created: https://github.com/...",
    });
  });
});

// ─── Assignee mapping ───────────────────────────────────────────────

// ─── Assignee mapping ───────────────────────────────────────────────

describe("assignee field", () => {
  it("maps assignee onto TaskIssue via fetchAllIssues", async () => {
    const node = makeNode({
      id: "a-1",
      assignee: { id: "user-ai", name: "AI Orchestrator" },
    });
    const { mockClient } = createMockClient([makeSinglePageResponse([node])]);

    const result = await fetchAllIssues(mockClient, {}, "personal");

    expect(result[0].assignee).toEqual({ id: "user-ai", name: "AI Orchestrator" });
  });

  it("maps a missing assignee to null", async () => {
    const { mockClient } = createMockClient([
      makeSinglePageResponse([makeNode({ assignee: null })]),
    ]);

    const result = await fetchAllIssues(mockClient, {}, "personal");

    expect(result[0].assignee).toBeNull();
  });

  it("requests the assignee field in ISSUES_QUERY", async () => {
    const { mockClient, rawRequest } = createMockClient([makeSinglePageResponse([])]);

    await fetchAllIssues(mockClient, {}, "personal");

    const query = rawRequest.mock.calls[0][0] as string;
    expect(query).toMatch(/assignee\s*\{\s*id\s+name\s*\}/);
  });

  it("requests the assignee field in ISSUES_WITH_DESCRIPTION_QUERY", async () => {
    const { mockClient, rawRequest } = createMockClient([makeSinglePageResponse([])]);

    await fetchAllIssuesWithDescription(mockClient, {}, "personal");

    const query = rawRequest.mock.calls[0][0] as string;
    expect(query).toMatch(/assignee\s*\{\s*id\s+name\s*\}/);
  });

  it("maps assignee through fetchAllIssuesWithDescription", async () => {
    const node = {
      ...makeNode({ assignee: { id: "user-h", name: "Human" } }),
      description: "body",
      comments: { nodes: [] },
    } as GraphQLIssueWithDescriptionNode;
    const response: GraphQLIssuesWithDescriptionResponse = {
      issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
    };
    const { mockClient } = createMockClient([
      response as unknown as GraphQLIssuesResponse,
    ]);

    const result = await fetchAllIssuesWithDescription(mockClient, {}, "personal");

    expect(result[0].assignee).toEqual({ id: "user-h", name: "Human" });
  });
});

// ─── fetchViewer ────────────────────────────────────────────────────

// ─── fetchViewer ────────────────────────────────────────────────────

describe("fetchViewer", () => {
  it("resolves the authenticated user from the API key", async () => {
    const rawRequest = vi.fn(async (_query: string, _variables?: Record<string, unknown>) => ({
      data: { viewer: { id: "user-ai", name: "AI Orchestrator", email: "ai@example.com" } },
    }));
    const mockClient = { client: { rawRequest } } as unknown as LinearClient;

    const viewer = await fetchViewer(mockClient);

    expect(viewer).toEqual({ id: "user-ai", name: "AI Orchestrator", email: "ai@example.com" });
    expect(rawRequest.mock.calls[0][0]).toMatch(/viewer/);
  });

  it("throws when the response carries no viewer", async () => {
    const rawRequest = vi.fn(async () => ({ data: null }));
    const mockClient = { client: { rawRequest } } as unknown as LinearClient;

    await expect(fetchViewer(mockClient)).rejects.toThrow("viewer");
  });
});

// ─── updateIssueAssignee ────────────────────────────────────────────

// ─── updateIssueAssignee ────────────────────────────────────────────

describe("updateIssueAssignee", () => {
  it("assigns the issue to a user", async () => {
    const updateIssue = vi.fn(async () => ({}));
    const mockClient = { updateIssue } as unknown as LinearClient;

    await updateIssueAssignee(mockClient, "issue-1", "user-h");

    expect(updateIssue).toHaveBeenCalledWith("issue-1", { assigneeId: "user-h" });
  });

  it("clears the assignee when given null", async () => {
    const updateIssue = vi.fn(async () => ({}));
    const mockClient = { updateIssue } as unknown as LinearClient;

    await updateIssueAssignee(mockClient, "issue-1", null);

    expect(updateIssue).toHaveBeenCalledWith("issue-1", { assigneeId: null });
  });
});

// ─── fetchIssuesAssignedTo ──────────────────────────────────────────

// ─── fetchIssuesAssignedTo ──────────────────────────────────────────

describe("fetchIssuesAssignedTo", () => {
  it("filters by assignee, excluding only finished and backlog state types", async () => {
    const { mockClient, rawRequest } = createMockClient([makeSinglePageResponse([])]);

    await fetchIssuesAssignedTo(mockClient, "user-ai");

    const variables = rawRequest.mock.calls[0][1] as Record<string, unknown>;
    expect(variables.filter).toEqual({
      assignee: { id: { eq: "user-ai" } },
      state: { type: { nin: ["completed", "canceled", "duplicate", "backlog"] } },
    });
  });

  it("does not gate on status names, so a handover that only moved the assignee is visible", async () => {
    // An `In Review` issue reassigned to the AI with review feedback in its
    // comments used to fall outside the status allowlist and vanish entirely.
    const node = {
      ...makeNode({ identifier: "TASK-1260", assignee: { id: "user-ai", name: "AI" } }),
      state: { name: "In Review", type: "started" },
      description: "body",
    } as unknown as GraphQLIssueWithDescriptionNode;
    const { mockClient } = createMockClient([
      {
        issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
      } as unknown as GraphQLIssuesResponse,
    ]);

    const result = await fetchIssuesAssignedTo(mockClient, "user-ai");

    expect(result.map((i) => i.identifier)).toEqual(["TASK-1260"]);
    expect(result[0].status).toBe("In Review");
  });

  it("returns issues with description and assignee", async () => {
    const node = {
      ...makeNode({ identifier: "TASK-1", assignee: { id: "user-ai", name: "AI" } }),
      description: "spec body",
    } as GraphQLIssueWithDescriptionNode;
    const { mockClient } = createMockClient([
      {
        issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
      } as unknown as GraphQLIssuesResponse,
    ]);

    const result = await fetchIssuesAssignedTo(mockClient, "user-ai");

    expect(result[0].description).toBe("spec body");
    expect(result[0].assignee).toEqual({ id: "user-ai", name: "AI" });
  });
});

// ─── fetchIssuesAwaitingHumans ──────────────────────────────────────

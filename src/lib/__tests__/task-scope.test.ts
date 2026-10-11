import { describe, it, expect, vi } from "vitest";
import {
  buildMismatchComment,
  buildMismatchPayload,
  findGroupMismatches,
  handBackMismatches,
  scopeFilter,
  withoutMismatches,
} from "../task-scope.js";
import type { RepositoryMapping } from "../repositories.js";
import type { TaskProvider } from "../tasks/provider.js";
import type { Task } from "../tasks/types.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "TASK-1",
    title: "テストタスク",
    status: "Todo",
    group: "work",
    labels: [],
    assignee: { id: "ai", name: "AI" },
    url: "https://example.com/TASK-1",
    updatedAt: "2026-08-06T11:00:00.000Z",
    dueDate: null,
    priority: null,
    ...overrides,
  };
}

function repository(overrides: Partial<RepositoryMapping> = {}): RepositoryMapping {
  return { label: "app", path: "/repos/app", baseBranch: "main", ...overrides };
}

const REPOSITORIES = [
  repository({ label: "app", group: "work" }),
  repository({ label: "site", group: "private" }),
  repository({ label: "shared" }),
];

describe("scopeFilter", () => {
  it("adds nothing for an instance that is not bound to a group", () => {
    expect(scopeFilter(null)).toEqual({});
  });

  it("limits the query to the instance's group", () => {
    expect(scopeFilter("private")).toEqual({ group: "private" });
  });
});

describe("findGroupMismatches", () => {
  it("finds a task labelled for a repository of the other group", () => {
    const mismatches = findGroupMismatches([task({ group: "work", labels: ["site"] })], REPOSITORIES);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].label).toBe("site");
    expect(mismatches[0].repositoryGroup).toBe("private");
  });

  it("finds it in the other direction too", () => {
    const mismatches = findGroupMismatches([task({ group: "private", labels: ["app"] })], REPOSITORIES);

    expect(mismatches.map((m) => m.repositoryGroup)).toEqual(["work"]);
  });

  it("passes a task whose repository is in its own group", () => {
    expect(findGroupMismatches([task({ group: "work", labels: ["app"] })], REPOSITORIES)).toEqual([]);
  });

  it("passes a repository that names no group, since it belongs to neither side", () => {
    expect(findGroupMismatches([task({ group: "work", labels: ["shared"] })], REPOSITORIES)).toEqual([]);
  });

  it("passes a task with no group: there is nothing for the label to contradict", () => {
    expect(findGroupMismatches([task({ group: null, labels: ["site"] })], REPOSITORIES)).toEqual([]);
  });

  it("ignores labels that are not repositories", () => {
    expect(findGroupMismatches([task({ labels: ["bug", "urgent"] })], REPOSITORIES)).toEqual([]);
  });

  it("matches labels regardless of case, as one task source lower-cases them", () => {
    const repositories = [repository({ label: "Site", group: "private" })];

    expect(findGroupMismatches([task({ group: "work", labels: ["site"] })], repositories)).toHaveLength(1);
  });

  it("reports a task once even when several of its labels contradict it", () => {
    const repositories = [
      repository({ label: "site", group: "private" }),
      repository({ label: "blog", group: "private" }),
    ];

    expect(
      findGroupMismatches([task({ group: "work", labels: ["site", "blog"] })], repositories),
    ).toHaveLength(1);
  });

  it("finds nothing when no repository names a group", () => {
    expect(
      findGroupMismatches([task({ group: "work", labels: ["app"] })], [repository({ label: "app" })]),
    ).toEqual([]);
  });
});

describe("withoutMismatches", () => {
  it("drops exactly the mismatched tasks", () => {
    const good = task({ id: "TASK-1", labels: ["app"] });
    const bad = task({ id: "TASK-2", labels: ["site"] });
    const mismatches = findGroupMismatches([good, bad], REPOSITORIES);

    expect(withoutMismatches([good, bad], mismatches)).toEqual([good]);
  });
});

describe("handBackMismatches", () => {
  function provider(overrides: Partial<TaskProvider> = {}): TaskProvider {
    return {
      update: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as TaskProvider;
  }

  const mismatches = findGroupMismatches(
    [task({ id: "TASK-2", group: "work", labels: ["site"] })],
    REPOSITORIES,
  );

  it("reassigns to the human, explains on the task, and notifies once", async () => {
    const tasks = provider();
    const notify = vi.fn().mockResolvedValue(undefined);

    const handedBack = await handBackMismatches(tasks, mismatches, notify);

    expect(tasks.update).toHaveBeenCalledWith("TASK-2", { assignee: "human" });
    expect(tasks.comment).toHaveBeenCalledWith("TASK-2", buildMismatchComment(mismatches[0]));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(handedBack).toEqual(mismatches);
  });

  it("does nothing, and says nothing, when there is nothing to hand back", async () => {
    const tasks = provider();
    const notify = vi.fn();

    await handBackMismatches(tasks, [], notify);

    expect(tasks.update).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not announce a task whose reassignment failed", async () => {
    const tasks = provider({ update: vi.fn().mockRejectedValue(new Error("boom")) });
    const notify = vi.fn();

    const handedBack = await handBackMismatches(tasks, mismatches, notify);

    expect(handedBack).toEqual([]);
    expect(tasks.comment).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the handback when the comment or the notification is lost", async () => {
    const tasks = provider({ comment: vi.fn().mockRejectedValue(new Error("boom")) });
    const notify = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(handBackMismatches(tasks, mismatches, notify)).resolves.toEqual(mismatches);
  });
});

describe("mismatch messages", () => {
  const [mismatch] = findGroupMismatches(
    [task({ id: "TASK-2", title: "誤配", group: "work", labels: ["site"] })],
    REPOSITORIES,
  );

  it("tells the human both groups and which label caused it", () => {
    const comment = buildMismatchComment(mismatch);

    expect(comment).toContain("work");
    expect(comment).toContain("site");
    expect(comment).toContain("private");
  });

  it("lists every handed-back task in the notification", () => {
    const payload = buildMismatchPayload([mismatch]);

    expect(payload.embeds?.[0].title).toContain("1件");
    expect(payload.embeds?.[0].description).toContain("TASK-2");
  });
});

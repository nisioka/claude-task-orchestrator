/**
 * The vocabulary the orchestrator uses to talk about tasks.
 *
 * Deliberately not shaped after any one tool. Linear calls the container a
 * team, ClickUp calls it a list; Linear's identifiers look like `ABC-123`,
 * ClickUp's like `z8tj1h26c6`. Anything a provider cannot express for every
 * backend belongs in that provider, not here.
 */

/**
 * Provider-assigned identifier, treated as opaque.
 *
 * The orchestrator prints it, puts it in agent names (`ai-impl-<id>`) and in
 * instruction file names, but never parses it. Validating the shape is the
 * provider's job — see `TaskProvider.isValidId`.
 */
export type TaskId = string;

export type ActorId = string;

/**
 * Who holds the ball.
 *
 * Ownership is decided by the assignee and nothing else, and there are exactly
 * two parties: the orchestrator and the person it works for. Callers ask for a
 * role and let the provider resolve it, rather than carrying user ids around.
 */
export type ActorRole = "ai" | "human";

/**
 * Which pool a task lives in.
 *
 * Work and private tasks share a workflow but are separated for the human's
 * benefit. How that separation is stored is the provider's business: a Linear
 * label, a ClickUp list, a Jira project.
 */
export type TaskGroup = "work" | "private";

/**
 * Priority as a name rather than a number.
 *
 * Linear stores 1..4 with 0 meaning "none"; ClickUp stores the words. Numbers
 * would force every caller to remember which end is urgent — and the existing
 * sort had to special-case 0 because the numeric order puts "none" first.
 */
export type TaskPriority = "urgent" | "high" | "normal" | "low";

export interface Actor {
  id: ActorId;
  name: string;
  email?: string;
}

export interface Task {
  id: TaskId;
  title: string;
  /** Status name as the workflow spells it: "In Progress", "Wait". */
  status: string;
  group: TaskGroup | null;
  labels: string[];
  assignee: Actor | null;
  url: string;
  updatedAt: string;
  dueDate: string | null;
  priority: TaskPriority | null;
  /** Present only when the filter asked for it. Descriptions dominate the payload. */
  description?: string;
  /**
   * Named values the backend stores alongside the task, keyed by the name a
   * person sees on the board.
   *
   * For things that are one value and get looked up, not read: where the
   * worktree is, what the task was mirrored from. A comment can hold the same
   * text, but only a field can be seen without scrolling and filtered on.
   *
   * Absent, rather than empty, when the backend has no such concept.
   */
  fields?: Record<string, string>;
}

export interface TaskDetail extends Task {
  description: string;
  comments: TaskComment[];
}

export interface TaskComment {
  author: string;
  body: string;
  createdAt: string;
}

/**
 * Filters combine with AND. Every field is optional; an empty filter means
 * "everything the provider can see".
 */
export interface TaskFilter {
  /** Status names. Callers that mean a role look the names up in config. */
  statuses?: string[];
  /**
   * Status names to leave out.
   *
   * A denylist rather than an allowlist, because the two fail in opposite
   * directions: forgetting to add a new status to an allowlist hides it, which
   * is how `Test` once became invisible to the orchestrator, while forgetting
   * it here only means it shows up — which matches the rule that ownership is
   * decided by the assignee, not the status.
   */
  excludeStatuses?: string[];
  labels?: string[];
  group?: TaskGroup;
  assignee?: ActorRole | ActorId | "none";
  /** Only tasks untouched since this moment. */
  updatedBefore?: Date;
  /** Pull descriptions too. Off by default: they dominate the payload. */
  withDescription?: boolean;
}

export interface NewTask {
  title: string;
  description?: string;
  group: TaskGroup;
  status?: string;
  labels?: string[];
  assignee?: ActorRole | ActorId;
  /**
   * Named values to store alongside the task.
   *
   * A provider that has no such concept, or does not recognise a name, throws.
   * Dropping them quietly would leave the caller believing a value was stored,
   * and the absence only shows up when someone goes looking for it.
   */
  fields?: Record<string, string>;
}

/** Only the named properties change. Omitted ones are left alone. */
export interface TaskPatch {
  title?: string;
  /**
   * Replaces the description outright.
   *
   * There is no merge here: the only safe merge is one the caller can see, so
   * a caller changing part of it reads the task first. `header.ts` is the one
   * part this system rewrites, and it explains what may go in a description
   * that is going to be rewritten.
   */
  description?: string;
  status?: string;
  assignee?: ActorRole | ActorId;
  addLabels?: string[];
  /** Named values to store. Unknown names throw; see `NewTask.fields`. */
  fields?: Record<string, string>;
}

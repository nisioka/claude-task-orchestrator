import type {
  Actor,
  ActorRole,
  NewTask,
  Task,
  TaskDetail,
  TaskFilter,
  TaskId,
  TaskPatch,
} from "./types.js";

/**
 * The task source the orchestrator runs on.
 *
 * There is exactly one active provider at a time. Reading from two backends at
 * once was considered and rejected: it would make "which copy is authoritative"
 * a question the orchestrator has to answer on every cycle.
 *
 * The interface is small on purpose. The Linear module it replaces had 27
 * personal-workspace functions, but most were the same query with a different
 * filter baked in — `fetchStaleWaitOrQuestionIssues`, `fetchIssuesAssignedTo`,
 * `fetchPersonalIssuesByLabels` and five more all reduce to `list`.
 */
export interface TaskProvider {
  /** Human-readable name of the backend, for logs and status output. */
  readonly name: string;

  /**
   * Whether this backend can store the named values in `NewTask.fields`.
   *
   * Callers ask before sending them. Writing a field is an error on a backend
   * that has none — that is deliberate, so a typo cannot be swallowed — which
   * leaves the caller needing a way to tell "there is nowhere to put this" from
   * "I got the name wrong". This is that way.
   */
  readonly supportsFields: boolean;

  list(filter?: TaskFilter): Promise<Task[]>;
  get(id: TaskId, opts?: { comments?: number }): Promise<TaskDetail | null>;

  /**
   * Fetches several tasks at once, preserving the order asked for.
   *
   * Not sugar over `get`: a backend that can batch should batch. Linear's
   * or-filter drops the number condition unless the ids are grouped by team
   * first, so the naive loop costs one round trip per id — and the orchestrator
   * reads a handful of tasks every cycle. Ids that do not exist are omitted.
   */
  getMany(ids: TaskId[], opts?: { comments?: number }): Promise<TaskDetail[]>;

  create(input: NewTask): Promise<Task>;
  update(id: TaskId, patch: TaskPatch): Promise<void>;
  comment(id: TaskId, body: string): Promise<void>;

  /**
   * Rewrites the most recent comment on a task.
   *
   * Exists because the orchestrator sometimes has to correct what it just
   * posted, and appending a correction leaves the wrong version standing above
   * it in a thread the human reads top-down.
   */
  updateLatestComment(id: TaskId, body: string): Promise<void>;

  /** Creates the label if it is missing. Returns the provider's label id. */
  ensureLabel(name: string): Promise<string>;

  /**
   * Names of the labels that already exist.
   *
   * Separate from `ensureLabel` because "use this label if it exists" and
   * "make sure this label exists" are different intents. The mirror sync needs
   * the first: a label per company project is created deliberately, and
   * creating one for every team that happens to appear would fill the
   * workspace with labels for projects nobody is tracking.
   */
  listLabels(): Promise<string[]>;

  /**
   * Resolves a role to the account that plays it.
   *
   * "ai" is whoever the configured credentials belong to. "human" is the other
   * member of the workspace; a provider that cannot tell them apart must throw
   * rather than guess, because guessing wrong hands work to the wrong party.
   */
  actor(role: ActorRole): Promise<Actor>;

  /** Whether a string is a well-formed identifier for this backend. */
  isValidId(value: string): boolean;
}

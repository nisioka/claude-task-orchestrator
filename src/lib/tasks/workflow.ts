import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The names of the workflow statuses, as the task source spells them.
 *
 * Every status name the core acts on lives here, and nowhere else. Before this
 * file the names were scattered across nine modules as local constants, which
 * was survivable only because the source was always Linear. It is not: ClickUp
 * spells the same workflow `to do` and `deploy & test`, and adds a `complete`
 * that Linear has no equivalent of.
 *
 * The statuses are identified **by name**. There was a version of this that
 * classified them by the source's own state *type* (`backlog` / `started` /
 * `completed` / …) instead, on the theory that types survive renaming. They do,
 * but a type is a much coarser thing than a status, so it cannot express "the
 * one status new tasks land in" — and the mapping from type to purpose then has
 * to be guessed. Names are what the human reads on the board; configure those.
 */
export interface WorkflowStatuses {
  /** The pool nothing is pulled from. The AI never touches these tasks. */
  backlog: string;
  /** Where a newly created task lands, and where a scheduled start waits. */
  queued: string;
  /** Set when the AI takes a task. Doubles as the double-dispatch guard. */
  inProgress: string;
  /** The AI needs an answer before it can continue. */
  question: string;
  /** Waiting on something external: a person's reply, or a date. */
  wait: string;
  /** A PR exists and is waiting for review and merge. */
  inReview: string;
  /** Waiting for a human to exercise the change on real hardware. */
  test: string;
  /** Finished. Only a human moves a task here. */
  done: string;
  canceled: string;
  duplicate: string;

  /**
   * Further source statuses that also mean "the work is over".
   *
   * Exists because a source can have more terminal statuses than the three
   * canonical ones — ClickUp's `Closed` group contributes a `complete` that
   * accepts no siblings, so it cannot be folded into `done`.
   */
  extraTerminal: string[];
  /** Further source statuses that also mean "not pulled from yet". */
  extraBacklog: string[];
}

/**
 * The names this repository's Linear workspace uses.
 *
 * Also the vocabulary the prompt sources are written in: `promptNames` renames
 * from these to whatever is configured, so a prompt can say `` `In Review` ``
 * in running prose and still come out right on a source that calls it
 * something else.
 */
export const DEFAULT_WORKFLOW: WorkflowStatuses = {
  backlog: "Backlog",
  queued: "Todo",
  inProgress: "In Progress",
  question: "Question",
  wait: "Wait",
  inReview: "In Review",
  test: "Test",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
  extraTerminal: [],
  extraBacklog: [],
};

const SINGULAR_KEYS = [
  "backlog",
  "queued",
  "inProgress",
  "question",
  "wait",
  "inReview",
  "test",
  "done",
  "canceled",
  "duplicate",
] as const;

const LIST_KEYS = ["extraTerminal", "extraBacklog"] as const;

type SingularKey = (typeof SINGULAR_KEYS)[number];

// ─── Derived groupings ──────────────────────────────────────────────

/** Statuses that mean the work is over. */
export function terminalStatuses(w: WorkflowStatuses): string[] {
  return [w.done, w.canceled, w.duplicate, ...w.extraTerminal];
}

/**
 * Statuses that keep a task out of the AI's queue even when it is assigned to
 * the AI: the pool it has not been pulled from yet, and the ones that mean the
 * work is over.
 *
 * A denylist, deliberately. An allowlist of "statuses the AI may hold" hides
 * anything a human handed over without also moving the status — which is how a
 * `Test` task assigned to the AI once became invisible to `orchestrator-status`
 * for as long as it took someone to notice. Forgetting to list a status here
 * only leaves it in the queue, which is the direction that fails loudly.
 */
export function offTheQueueStatuses(w: WorkflowStatuses): string[] {
  return [w.backlog, ...w.extraBacklog, ...terminalStatuses(w)];
}

/**
 * Which of the human's four duties each status implies.
 *
 * `wait` is external-cause waiting only — a person's reply, or a date. The duty
 * is to check whether the thing being waited on has arrived, not to unstick
 * anything: a failed run hands the task over by *assignee* and keeps its
 * status, so a stuck AI never lands in this list at all.
 */
export function humanDutyByStatus(w: WorkflowStatuses): Record<string, string> {
  return {
    [w.question]: "要件確認",
    [w.test]: "実機テスト",
    [w.inReview]: "レビューとマージ",
    [w.wait]: "待ちの解除確認",
  };
}

/** The statuses that are the human's ball. */
export function humanBallStatuses(w: WorkflowStatuses): string[] {
  return Object.keys(humanDutyByStatus(w));
}

/**
 * Statuses where nothing moves until something outside the system happens, so
 * a task sitting in one for days means someone has forgotten about it.
 */
export function remindedStatuses(w: WorkflowStatuses): string[] {
  return [w.wait, w.question];
}

/** The live statuses, most urgent first — the order the task listing prints. */
export function activeOrder(w: WorkflowStatuses): string[] {
  return [w.inProgress, w.queued, w.inReview, w.test, w.wait];
}

/** How the progress report groups statuses under its three headings. */
export function reportCategories(w: WorkflowStatuses): Record<string, string[]> {
  return {
    Done: terminalStatuses(w),
    Doing: [w.wait, w.inProgress, w.inReview, w.test],
    Todo: [w.queued, w.question, w.backlog, ...w.extraBacklog],
  };
}

/**
 * Renames from the vocabulary the prompt sources are written in to the
 * configured one. Only the names that actually differ appear.
 */
export function promptNames(w: WorkflowStatuses): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SINGULAR_KEYS) {
    const from = DEFAULT_WORKFLOW[key];
    if (w[key] !== from) out[from] = w[key];
  }
  return out;
}

// ─── Loading ────────────────────────────────────────────────────────

export const DEFAULT_WORKFLOW_PATH = join(homedir(), ".config", "ai-orchestrator", "workflow.json");

/** The default location, resolved against the given environment's home. */
function defaultPath(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? homedir(), ".config", "ai-orchestrator", "workflow.json");
}

function fail(message: string, path: string): never {
  throw new Error(`ワークフロー設定が不正です (${path}): ${message}`);
}

/** Validates and merges a parsed config over the defaults. */
export function parseWorkflow(raw: unknown, path: string): WorkflowStatuses {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("トップレベルがオブジェクトではありません", path);
  }
  const input = raw as Record<string, unknown>;

  const known = new Set<string>([...SINGULAR_KEYS, ...LIST_KEYS]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      fail(`未知のキー "${key}" があります。指定できるのは ${[...known].join(", ")} です`, path);
    }
  }

  const out: WorkflowStatuses = { ...DEFAULT_WORKFLOW };

  for (const key of SINGULAR_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      fail(`"${key}" は空でない文字列である必要があります`, path);
    }
    out[key] = value;
  }

  for (const key of LIST_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
      fail(`"${key}" は空でない文字列の配列である必要があります`, path);
    }
    out[key] = value as string[];
  }

  assertDistinct(out, path);
  return out;
}

/**
 * A name used for two purposes silently breaks the derived groupings — the same
 * status would be both the AI's queue and off it — so it is rejected at load
 * time rather than at the first patrol.
 */
function assertDistinct(w: WorkflowStatuses, path: string): void {
  const seen = new Map<string, string>();
  const claim = (name: string, by: string) => {
    const owner = seen.get(name);
    if (owner) fail(`"${name}" が ${owner} と ${by} の両方に指定されています`, path);
    seen.set(name, by);
  };
  for (const key of SINGULAR_KEYS) claim(w[key], key);
  for (const key of LIST_KEYS) for (const name of w[key]) claim(name, key);
}

/**
 * Reads the workflow config, falling back to the defaults when there is no
 * file. Absence is the normal case for a single-source setup: the defaults
 * describe a workspace that already exists.
 */
export function loadWorkflow(env: NodeJS.ProcessEnv = process.env): WorkflowStatuses {
  const override = env.ORCHESTRATOR_WORKFLOW_PATH;
  const path = override ? resolve(expandHome(override)) : defaultPath(env);

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !override) return { ...DEFAULT_WORKFLOW };
    if (code === "ENOENT") {
      throw new Error(`ワークフロー設定が見つかりません: ${path}`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`JSONとして読めません: ${(error as Error).message}`, path);
  }
  return parseWorkflow(parsed, path);
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

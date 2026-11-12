/**
 * Patrol gate: decide, without the model, whether a patrol has anything to do.
 *
 * Most patrols find nothing, and each one still pays for re-reading the
 * resident session's whole context several times over. The questions that
 * decide "nothing to do" are all factual — did the AI's queue change, is a
 * child running, did a scheduled start come due, did a pull request close — so
 * they are answered here, in code, and the session wakes to a full patrol only
 * when one of them says so.
 *
 * The rule is one-sided on purpose: anything this module cannot prove unchanged
 * is a reason to patrol. A skipped patrol that should have run costs a missed
 * reaction; a patrol that did not need to run costs only tokens.
 *
 * What the snapshot does not see (inbound messages read through tools only the
 * session has, anything the session decided to revisit later) is covered by a
 * full patrol at a fixed period. It is a ceiling, not a back-off: the wake-up
 * cadence itself never stretches, so work that arrives at the start of a day
 * is picked up on the next wake as before.
 *
 * Under `ORCHESTRATOR_IDLE_EXIT` a skip becomes an exit: the session stops
 * instead of waiting, and the supervisor runs this same gate on its own tick to
 * decide when to start the next one. That is only sound where the snapshot sees
 * every input, which is why it is a per-instance setting and off by default.
 */

import type { HeartbeatRecord } from "./agent-runtime.js";

/** What a patrol would react to, reduced to comparable values. */
export interface GateSnapshot {
  /** Issues assigned to the AI, as `id|status|updatedAt`. */
  aiIssues: string[];
  /** AI issues whose start-after is still in the future. Leaving this set means one came due. */
  scheduledPending: string[];
  /** The human's open pull requests as `owner/repo#number`. `null` when they could not be listed. */
  openPullRequests: string[] | null;
  /**
   * The open pull requests GitHub reports as conflicting with their base.
   *
   * A conflict changes nothing else about a pull request — not its number, not
   * its place in the list — so without this a pull request falling into
   * conflict while the human holds it would never wake a patrol to repair it.
   */
  conflictingPullRequests: string[];
  /**
   * Open pull requests whose mergeability GitHub had not computed yet.
   *
   * GitHub computes it lazily, on the first request after the base moves, and
   * answers that request with "unknown". Such a pull request keeps the standing
   * it had in the baseline instead of reading as "no longer conflicting": the
   * next wake has the real answer, and flapping in between would cost two
   * patrols for nothing.
   */
  undecidedPullRequests: string[];
  /** Child agents the daemon still holds, as `name|state`. */
  runningChildren: string[];
  /**
   * The subset still working on something the AI answers for, by name: an issue
   * the AI owns, or a human-held pull request it is keeping mergeable.
   *
   * Only these force a patrol while unchanged: a working child can stall with
   * its state still saying working, and only a patrol reading its progress can
   * tell. A child whose issue the human has taken over is theirs to watch.
   */
  activeChildren: string[];
}

export interface GateBaseline {
  snapshot: GateSnapshot;
  /** When the snapshot was taken (ISO). */
  at: string;
}

/**
 * Persisted between runs.
 *
 * `candidate` is the snapshot taken when the gate last sent the session to
 * patrol. It becomes the `baseline` only once a patrol heartbeat is written
 * after it — a patrol that died half-way must not teach the gate that its
 * changes were handled.
 */
export interface GateState {
  baseline: GateBaseline | null;
  candidate: GateBaseline | null;
}

export const EMPTY_GATE_STATE: GateState = { baseline: null, candidate: null };

export type GateVerdict = "skip" | "patrol";

export interface GateDecision {
  verdict: GateVerdict;
  reasons: string[];
  state: GateState;
}

export interface GateInput {
  snapshot: GateSnapshot;
  state: GateState;
  /** The last heartbeat written by a real patrol (gate lines excluded). */
  lastPatrol: HeartbeatRecord | null;
  now: Date;
  fullPatrolSeconds: number;
}

/** Marks heartbeat lines the gate writes, so they are never mistaken for a patrol. */
export const GATE_HEARTBEAT_MARKER = "gate";

export function normalizeSnapshot(snapshot: GateSnapshot): GateSnapshot {
  const sorted = (values: string[]) => [...new Set(values)].sort();
  return {
    aiIssues: sorted(snapshot.aiIssues),
    scheduledPending: sorted(snapshot.scheduledPending),
    openPullRequests: snapshot.openPullRequests === null ? null : sorted(snapshot.openPullRequests),
    // Baselines written before these fields existed lack them.
    conflictingPullRequests: sorted(snapshot.conflictingPullRequests ?? []),
    undecidedPullRequests: sorted(snapshot.undecidedPullRequests ?? []),
    runningChildren: sorted(snapshot.runningChildren),
    activeChildren: sorted(snapshot.activeChildren ?? []),
  };
}

/**
 * Give the pull requests GitHub has not decided on the standing they had in
 * the baseline. When the listing failed outright, the baseline's whole set
 * stands: there is nothing better to compare with, and the failure already
 * forces a patrol.
 */
export function settleUndecided(snapshot: GateSnapshot, baseline: GateSnapshot | null): GateSnapshot {
  if (!baseline) return snapshot;
  const undecided = new Set(snapshot.undecidedPullRequests);
  const conflicting =
    snapshot.openPullRequests === null
      ? baseline.conflictingPullRequests
      : [
          ...snapshot.conflictingPullRequests,
          ...baseline.conflictingPullRequests.filter((pr) => undecided.has(pr)),
        ];
  return { ...snapshot, conflictingPullRequests: [...new Set(conflicting)].sort() };
}

function sameSet(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Human-readable names of the parts that differ. Empty when nothing does. */
export function describeChanges(before: GateSnapshot, after: GateSnapshot): string[] {
  const changes: string[] = [];
  if (!sameSet(before.aiIssues, after.aiIssues)) changes.push("AIのボールが変化");
  if (!sameSet(before.scheduledPending, after.scheduledPending)) changes.push("予約投入が変化");
  if (!sameSet(before.openPullRequests, after.openPullRequests)) changes.push("オープンPRが変化");
  if (!sameSet(before.conflictingPullRequests, after.conflictingPullRequests)) {
    changes.push("コンフリクトしたPRが変化");
  }
  if (!sameSet(before.runningChildren, after.runningChildren)) changes.push("子エージェントが変化");
  return changes;
}

function promote(state: GateState, lastPatrol: HeartbeatRecord | null): GateState {
  if (!state.candidate || !lastPatrol) return state;
  const patrolAt = new Date(lastPatrol.at).getTime();
  const candidateAt = new Date(state.candidate.at).getTime();
  if (Number.isNaN(patrolAt) || Number.isNaN(candidateAt) || patrolAt < candidateAt) return state;
  return { baseline: state.candidate, candidate: null };
}

export function decideGate(input: GateInput): GateDecision {
  const state = promote(input.state, input.lastPatrol);
  const baseline = state.baseline ? normalizeSnapshot(state.baseline.snapshot) : null;
  const snapshot = settleUndecided(normalizeSnapshot(input.snapshot), baseline);
  const reasons: string[] = [];

  if (snapshot.activeChildren.length > 0) {
    reasons.push(`子エージェントが作業中（${snapshot.activeChildren.length}件）`);
  }
  if (snapshot.openPullRequests === null) {
    reasons.push("PRの一覧を取得できなかった");
  }
  if (!state.baseline) {
    reasons.push("比較の基準が無い");
  }

  const lastPatrolAt = input.lastPatrol ? new Date(input.lastPatrol.at).getTime() : Number.NaN;
  if (Number.isNaN(lastPatrolAt)) {
    reasons.push("前回の巡回の記録が無い");
  } else {
    const elapsedSeconds = (input.now.getTime() - lastPatrolAt) / 1000;
    if (elapsedSeconds >= input.fullPatrolSeconds) {
      reasons.push(`前回の巡回から${Math.floor(elapsedSeconds / 60)}分経過`);
    }
  }

  if (baseline) reasons.push(...describeChanges(baseline, snapshot));

  if (reasons.length === 0) return { verdict: "skip", reasons, state };

  return {
    verdict: "patrol",
    reasons,
    state: { baseline: state.baseline, candidate: { snapshot, at: input.now.toISOString() } },
  };
}

/**
 * What the session is told to do: `patrol`, `skip` (re-arm the wait), or `exit`
 * (do not re-arm; the supervisor puts the session down and starts a new one
 * when work arrives).
 *
 * `exit` is `skip` under `ORCHESTRATOR_IDLE_EXIT`. It is never the answer while
 * a child is working, because that already forces `patrol`.
 */
export type GateAction = "patrol" | "skip" | "exit";

export function gateAction(decision: GateDecision, idleExit: boolean): GateAction {
  if (decision.verdict === "patrol") return "patrol";
  return idleExit ? "exit" : "skip";
}

/** One line on stdout. The session reads only the first word after the colon. */
export function formatDecision(
  decision: GateDecision,
  lastPatrol: HeartbeatRecord | null,
  now: Date,
  idleExit = false,
): string {
  if (decision.verdict === "patrol") {
    return `巡回ゲート: patrol — ${decision.reasons.join(" / ")}`;
  }
  const minutes = lastPatrol ? Math.floor((now.getTime() - new Date(lastPatrol.at).getTime()) / 60_000) : null;
  const since = minutes === null ? "" : `（前回の巡回から${minutes}分）`;
  return `巡回ゲート: ${gateAction(decision, idleExit)} — 変化なし${since}`;
}

/** Marks the gate lines that told the session to stop, so the supervisor can tell them from a stall. */
export const IDLE_HEARTBEAT_MARKER = "idle";

/** The heartbeat line written in place of a skipped patrol. */
export function buildGateHeartbeat(now: Date, idleExit = false): string {
  return JSON.stringify({
    at: now.toISOString(),
    dispatched: [],
    handedToHuman: [],
    note: idleExit ? "巡回ゲート: 変化なし、仕事が来るまで常駐を止める" : "巡回ゲート: 変化なしのため省略",
    [GATE_HEARTBEAT_MARKER]: true,
    ...(idleExit ? { [IDLE_HEARTBEAT_MARKER]: true } : {}),
  });
}

/**
 * The newest heartbeat written by a real patrol.
 *
 * Gate lines keep the supervisor's liveness check satisfied, but they are not
 * patrols: counting them would let the full-patrol ceiling slide forever.
 */
export function findLastPatrol(raw: string): HeartbeatRecord | null {
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (record[GATE_HEARTBEAT_MARKER] === true) continue;
    if (typeof record.at !== "string") continue;
    return {
      at: record.at,
      dispatched: Array.isArray(record.dispatched) ? record.dispatched.filter((v): v is string => typeof v === "string") : [],
      handedToHuman: Array.isArray(record.handedToHuman)
        ? record.handedToHuman.filter((v): v is string => typeof v === "string")
        : [],
      note: typeof record.note === "string" ? record.note : null,
    };
  }
  return null;
}

export function parseGateState(raw: string): GateState {
  try {
    const parsed = JSON.parse(raw) as Partial<GateState>;
    return {
      baseline: isBaseline(parsed.baseline) ? parsed.baseline : null,
      candidate: isBaseline(parsed.candidate) ? parsed.candidate : null,
    };
  } catch {
    return EMPTY_GATE_STATE;
  }
}

function isBaseline(value: unknown): value is GateBaseline {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "string") return false;
  const snapshot = record.snapshot as Record<string, unknown> | undefined;
  if (!snapshot) return false;
  const isList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  return (
    isList(snapshot.aiIssues) &&
    isList(snapshot.scheduledPending) &&
    isList(snapshot.runningChildren) &&
    (snapshot.activeChildren === undefined || isList(snapshot.activeChildren)) &&
    (snapshot.conflictingPullRequests === undefined || isList(snapshot.conflictingPullRequests)) &&
    (snapshot.undecidedPullRequests === undefined || isList(snapshot.undecidedPullRequests)) &&
    (snapshot.openPullRequests === null || isList(snapshot.openPullRequests))
  );
}

// ─── Whose pull requests ────────────────────────────────────────────

/**
 * `owner/name` of a GitHub remote URL, lower-cased, or `null` for anything
 * that is not plainly a GitHub repository.
 *
 * Covers what `git remote get-url` prints in practice: https with or without
 * `.git`, scp-like ssh (`git@github.com:owner/name`, also with a stray `/`
 * after the colon), and `ssh://` URLs.
 */
export function gitHubRepositoryOf(remoteUrl: string): string | null {
  const match = remoteUrl
    .trim()
    .match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:\/?)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/**
 * Drop the pull requests that belong to another group's repositories.
 *
 * `gh search prs --author @me` answers across every repository the human
 * touches, so an instance split by group would otherwise wake to the other
 * group's work — and under idle exit every such wake is a cold start. Only a
 * repository *shown* to be another group's is dropped (`foreign`, as
 * `owner/name` from {@link gitHubRepositoryOf}); an unregistered one, or one
 * whose remote could not be read, stays in, on the side of patrolling.
 */
export function withoutForeignPullRequests(pullRequests: string[], foreign: ReadonlySet<string>): string[] {
  if (foreign.size === 0) return pullRequests;
  return pullRequests.filter((pr) => {
    const hash = pr.lastIndexOf("#");
    const repository = (hash === -1 ? pr : pr.slice(0, hash)).toLowerCase();
    return !foreign.has(repository);
  });
}

/**
 * The repositories, as `owner/name`, that are shown to be another group's.
 *
 * A repository counts only when registered to another group and to neither
 * this group nor none — the same remote can be checked out twice. One whose
 * name could not be read (`null`) is never foreign: failing to prove it must
 * not cost a patrol. And if one of this group's own (or an ungrouped one)
 * could not be read, nothing is foreign: it may be the same repository as any
 * of the others, and dropping its pull requests would hide them until the
 * next forced patrol.
 */
export function foreignRepositoryNames(
  repositories: { group?: string; name: string | null }[],
  group: string,
): Set<string> {
  const ours = new Set<string>();
  const others = new Set<string>();
  for (const { group: owner, name } of repositories) {
    const foreign = owner !== undefined && owner !== group;
    if (name === null) {
      if (!foreign) return new Set();
      continue;
    }
    (foreign ? others : ours).add(name);
  }
  return new Set([...others].filter((name) => !ours.has(name)));
}

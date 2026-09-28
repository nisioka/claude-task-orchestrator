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
  /** Child agents the daemon still holds, as `name|state`. */
  runningChildren: string[];
  /**
   * The subset still working on an issue the AI owns, by name.
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
    runningChildren: sorted(snapshot.runningChildren),
    activeChildren: sorted(snapshot.activeChildren ?? []),
  };
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
  const snapshot = normalizeSnapshot(input.snapshot);
  const state = promote(input.state, input.lastPatrol);
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

  if (state.baseline) reasons.push(...describeChanges(normalizeSnapshot(state.baseline.snapshot), snapshot));

  if (reasons.length === 0) return { verdict: "skip", reasons, state };

  return {
    verdict: "patrol",
    reasons,
    state: { baseline: state.baseline, candidate: { snapshot, at: input.now.toISOString() } },
  };
}

/** One line on stdout. The session reads only the first word after the colon. */
export function formatDecision(decision: GateDecision, lastPatrol: HeartbeatRecord | null, now: Date): string {
  if (decision.verdict === "patrol") {
    return `巡回ゲート: patrol — ${decision.reasons.join(" / ")}`;
  }
  const minutes = lastPatrol ? Math.floor((now.getTime() - new Date(lastPatrol.at).getTime()) / 60_000) : null;
  return `巡回ゲート: skip — 変化なし${minutes === null ? "" : `（前回の巡回から${minutes}分）`}`;
}

/** The heartbeat line written in place of a skipped patrol. */
export function buildGateHeartbeat(now: Date): string {
  return JSON.stringify({
    at: now.toISOString(),
    dispatched: [],
    handedToHuman: [],
    note: "巡回ゲート: 変化なしのため省略",
    [GATE_HEARTBEAT_MARKER]: true,
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
    (snapshot.openPullRequests === null || isList(snapshot.openPullRequests))
  );
}

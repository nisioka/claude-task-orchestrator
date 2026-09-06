import "dotenv/config";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Settings for the resident orchestrator session and the child agents it
 * dispatches. Validated at load time so a misconfiguration fails immediately
 * with an actionable message rather than at the first spawn.
 */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Prompt cache entries expire after an hour. A sleep that crosses the
 * expiry forces the whole context to be re-written at 1.25–2× the cached
 * rate on wake, which costs more than simply waking more often.
 */
export const PROMPT_CACHE_TTL_SECONDS = 3600;

export interface OrchestratorConfig {
  stateDir: string;
  sessionIdPath: string;
  heartbeatPath: string;

  /**
   * The prompt sources, written in one fixed vocabulary with `{{repoDir}}` and
   * `{{promptDir}}` standing in for the absolute paths.
   *
   * A list, and layered: a later directory overwrites a file of the same
   * relative path from an earlier one, and its `child/rules.json` appends to
   * the child rule table. That is how this repository adds the child kinds its
   * own integrations need without the published core naming them.
   */
  promptSourceDirs: string[];
  /**
   * The repository that embeds the core, for the `{{repoDir}}` the prompts use.
   *
   * The core's own path is derived from where its code sits, so it needs no
   * configuration; the embedding repository's does not follow from anything the
   * core can see.
   */
  repoDir: string;
  /**
   * Where the rendered prompts are written, and where the sessions read them.
   *
   * Separate from the sources so that a rendered file is never mistaken for
   * something to edit: editing one is silently undone by the next render.
   */
  renderedPromptDir: string;
  /** The rendered instruction file the resident session is pointed at. */
  instructionPath: string;

  orchestratorModel: string;
  orchestratorEffort: EffortLevel;
  implementModel: string;
  implementEffort: EffortLevel;
  judgementModel: string;
  /** `null` means "leave it to the daemon default". */
  judgementEffort: EffortLevel | null;

  minIntervalSeconds: number;
  targetIntervalSeconds: number;
  maxIntervalSeconds: number;
  /**
   * How long after launch a session is exempt from the stall check.
   *
   * No heartbeat exists until the first patrol completes, so without a grace
   * period the supervisor would judge the session it just started as stalled
   * on its very next run and restart it forever. The default covers one full
   * supervisor tick.
   */
  startupGraceSeconds: number;

  /**
   * Context size at which the resident session is recycled. `null` disables.
   *
   * The resident's context only grows: it starts around 40k and, left alone,
   * has reached 880k. Since every patrol re-reads the whole of it, the last
   * patrol of a long-lived session costs more than twenty of its first ones,
   * while doing the same work. Recycling caps that. Restarting is not free —
   * the new session re-reads the instruction file and reconciles state — which
   * is why this is a ceiling rather than a schedule.
   */
  maxSessionContextTokens: number | null;

  /**
   * Age at which the resident session is recycled regardless of context.
   * `null` disables.
   *
   * A backstop for the case where the context measurement is unavailable (an
   * unreadable transcript, a daemon that stops reporting the path). Without
   * it, an unmeasurable session would grow without limit and nothing would say
   * so.
   */
  maxSessionAgeSeconds: number | null;

  /**
   * Context size at which a child agent should hand over to a fresh one.
   * `null` disables.
   *
   * Enforced by the orchestrator, not here — the supervisor owns the resident
   * session only. It lives in this file so `orchestrator-status` and the
   * instructions quote the same number.
   */
  childContextLimitTokens: number | null;

  /**
   * The `claude` binary. Overridable so a fake agent can drive the whole
   * launch → observe → collect path without spending model usage.
   */
  claudeExecutable: string;
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Expand a leading `~` to the home directory. `~user` is left alone. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function loadOrchestratorConfig(): OrchestratorConfig {
  const stateDir = expandHome(
    process.env.ORCHESTRATOR_STATE_DIR || join(homedir(), ".local/state/ai-orchestrator"),
  );
  assertNotUnderTmp(stateDir);

  const renderedPromptDir = expandHome(
    process.env.ORCHESTRATOR_RENDERED_PROMPT_DIR || join(stateDir, "prompts"),
  );

  const config: OrchestratorConfig = {
    stateDir,
    sessionIdPath: expandHome(
      process.env.ORCHESTRATOR_SESSION_ID_PATH || join(stateDir, "session-id"),
    ),
    heartbeatPath: expandHome(
      process.env.ORCHESTRATOR_HEARTBEAT_PATH || join(stateDir, "heartbeat.jsonl"),
    ),
    promptSourceDirs: (process.env.ORCHESTRATOR_PROMPT_SOURCE_DIRS || resolve("prompts"))
      .split(",")
      .map((dir) => expandHome(dir.trim()))
      .filter((dir) => dir.length > 0),
    repoDir: expandHome(process.env.ORCHESTRATOR_REPO_DIR || resolve(".")),
    renderedPromptDir,
    instructionPath: expandHome(
      process.env.ORCHESTRATOR_INSTRUCTION_PATH || join(renderedPromptDir, "orchestrator.md"),
    ),

    orchestratorModel: process.env.ORCHESTRATOR_MODEL || "opus",
    orchestratorEffort: parseEffort("ORCHESTRATOR_EFFORT", "medium"),
    implementModel: process.env.ORCHESTRATOR_IMPL_MODEL || "opus",
    implementEffort: parseEffort("ORCHESTRATOR_IMPL_EFFORT", "xhigh"),
    judgementModel: process.env.ORCHESTRATOR_JUDGE_MODEL || "opus",
    judgementEffort: parseEffort("ORCHESTRATOR_JUDGE_EFFORT", null),

    minIntervalSeconds: parsePositiveInt("ORCHESTRATOR_MIN_INTERVAL_SECONDS", 600),
    targetIntervalSeconds: parsePositiveInt("ORCHESTRATOR_TARGET_INTERVAL_SECONDS", 1200),
    maxIntervalSeconds: parsePositiveInt("ORCHESTRATOR_MAX_INTERVAL_SECONDS", 1800),
    startupGraceSeconds: parsePositiveInt("ORCHESTRATOR_STARTUP_GRACE_SECONDS", 1800),

    maxSessionContextTokens: parseOptionalPositiveInt(
      "ORCHESTRATOR_MAX_SESSION_CONTEXT_TOKENS",
      300_000,
    ),
    maxSessionAgeSeconds: parseOptionalPositiveInt("ORCHESTRATOR_MAX_SESSION_AGE_SECONDS", 86_400),
    childContextLimitTokens: parseOptionalPositiveInt(
      "ORCHESTRATOR_CHILD_CONTEXT_LIMIT_TOKENS",
      400_000,
    ),

    claudeExecutable: process.env.ORCHESTRATOR_CLAUDE_BIN || "claude",
  };

  assertIntervalOrder(config);
  assertRecycleLimits(config);
  return config;
}

// ─── Session naming (§1.2.2) ────────────────────────────────────────

/**
 * The naming convention is the authority for crash-recovery reconciliation:
 * given an issue that is `In Progress` and assigned to the AI, the expected
 * child name is derivable, so the agent list alone answers "is the child still
 * alive". Without an explicit name the daemon generates one from the opening
 * line of the launch prompt, and rewording that line silently breaks matching.
 */
export const ORCHESTRATOR_SESSION_NAME = "ai-orchestrator";

/**
 * What may appear where a task identifier goes in an agent name.
 *
 * Deliberately loose. The shape of an identifier belongs to the task source —
 * Linear spells them `TASK-1226`, ClickUp `z8tj1h26um` — and this module has no
 * provider to ask (`TaskProvider.isValidId` does that where it matters). A
 * pattern that encoded one source's shape would make `parseAgentName` return
 * null for every child on any other source, and a null there **drops the agent
 * from the status view entirely**: the human would see no running children at
 * all while children were running.
 *
 * What is worth rejecting is only what cannot be an identifier: nothing, and
 * anything with a space or a slash — a title or a path passed by mistake.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function implAgentName(issueIdentifier: string): string {
  return `ai-impl-${assertIdentifier(issueIdentifier)}`;
}

export function judgeAgentName(issueIdentifier: string): string {
  return `ai-judge-${assertIdentifier(issueIdentifier)}`;
}

export type ParsedAgentName =
  | { role: "orchestrator" }
  | { role: "impl" | "judge"; issueIdentifier: string };

/** Inverse of the name builders. Returns `null` for anything we did not name. */
export function parseAgentName(name: string): ParsedAgentName | null {
  if (name === ORCHESTRATOR_SESSION_NAME) return { role: "orchestrator" };

  const match = /^ai-(impl|judge)-(.+)$/.exec(name);
  if (!match) return null;

  const issueIdentifier = match[2];
  if (!IDENTIFIER_PATTERN.test(issueIdentifier)) return null;

  return { role: match[1] as "impl" | "judge", issueIdentifier };
}

// ─── Helpers ────────────────────────────────────────────────────────

function assertIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(
      `イシュー識別子の形式が不正です: "${identifier}" ("TASK-1226" のような形式が必要)`,
    );
  }
  return identifier;
}

function parseEffort<T extends EffortLevel | null>(name: string, defaultValue: T): EffortLevel | T {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  if (!isEffortLevel(raw)) {
    throw new Error(
      `環境変数 ${name} の値が不正です: "${raw}" (${EFFORT_LEVELS.join(" / ")} のいずれか)`,
    );
  }
  return raw;
}

/**
 * Same as `parsePositiveInt`, plus `-` for "no limit".
 *
 * Following `COMPANY_SYNC_IGNORED_STATUSES`, an explicit `-` disables the
 * setting. An empty value would be ambiguous with "unset", which has to keep
 * meaning the default.
 */
function parseOptionalPositiveInt(name: string, defaultValue: number | null): number | null {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  if (raw.trim() === "-") return null;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`環境変数 ${name} の値が不正です: "${raw}" (1以上の整数、または "-" で無効化)`);
  }
  return value;
}

function parsePositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`環境変数 ${name} の値が不正です: "${raw}" (1以上の整数が必要)`);
  }
  return value;
}

function assertNotUnderTmp(stateDir: string): void {
  if (stateDir === "/tmp" || stateDir.startsWith("/tmp/")) {
    throw new Error(
      `ORCHESTRATOR_STATE_DIR に /tmp 配下を指定できません: "${stateDir}"\n` +
        `WSL では /tmp の永続が保証されず、再起動でセッションIDとハートビートを失います。` +
        `~/.local/state/ai-orchestrator などを指定してください。`,
    );
  }
}

/**
 * A recycle limit set too low is worse than no limit at all: the session is
 * killed before it finishes a patrol, and the supervisor spends the whole day
 * paying for cold starts that never reach any work.
 */
const MIN_SESSION_CONTEXT_TOKENS = 100_000;

function assertRecycleLimits(config: OrchestratorConfig): void {
  const { maxSessionContextTokens: context, maxSessionAgeSeconds: age } = config;

  if (context !== null && context < MIN_SESSION_CONTEXT_TOKENS) {
    throw new Error(
      `ORCHESTRATOR_MAX_SESSION_CONTEXT_TOKENS が小さすぎます: ${context}\n` +
        `起動直後のセッションは指示ファイルだけで4万トークン前後あり、1巡回するとさらに増えます。` +
        `1巡回も終わらないうちに終了させることになるため、${MIN_SESSION_CONTEXT_TOKENS} 以上にしてください。`,
    );
  }

  const minimumAge = config.maxIntervalSeconds * 2;
  if (age !== null && age < minimumAge) {
    throw new Error(
      `ORCHESTRATOR_MAX_SESSION_AGE_SECONDS が短すぎます: ${age}秒\n` +
        `確認間隔の上限（${config.maxIntervalSeconds}秒）の2巡回ぶん、${minimumAge}秒以上にしてください。`,
    );
  }

  if (config.childContextLimitTokens !== null && config.childContextLimitTokens < MIN_SESSION_CONTEXT_TOKENS) {
    throw new Error(
      `ORCHESTRATOR_CHILD_CONTEXT_LIMIT_TOKENS が小さすぎます: ${config.childContextLimitTokens}\n` +
        `${MIN_SESSION_CONTEXT_TOKENS} 以上にしてください。`,
    );
  }
}

function assertIntervalOrder(config: OrchestratorConfig): void {
  const { minIntervalSeconds: min, targetIntervalSeconds: target, maxIntervalSeconds: max } = config;

  if (min > target) {
    throw new Error(
      `確認間隔の下限が目標を上回っています: 下限 ${min}秒 > 目標 ${target}秒\n` +
        `ORCHESTRATOR_MIN_INTERVAL_SECONDS を ${target} 以下にしてください。`,
    );
  }
  if (target > max) {
    throw new Error(
      `確認間隔の目標が上限を上回っています: 目標 ${target}秒 > 上限 ${max}秒\n` +
        `ORCHESTRATOR_TARGET_INTERVAL_SECONDS を ${max} 以下にしてください。`,
    );
  }
  if (max >= PROMPT_CACHE_TTL_SECONDS) {
    throw new Error(
      `確認間隔の上限がプロンプトキャッシュ有効期限以上です: 上限 ${max}秒 >= ${PROMPT_CACHE_TTL_SECONDS}秒\n` +
        `有効期限を跨いで待機すると、起床時にコンテキスト全体を1.25〜2倍の単価で再書き込みすることになり、` +
        `短い間隔で起き続けるより高くつきます。` +
        `ORCHESTRATOR_MAX_INTERVAL_SECONDS を ${PROMPT_CACHE_TTL_SECONDS} 未満にしてください。`,
    );
  }
}

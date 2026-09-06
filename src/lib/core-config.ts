import "dotenv/config";

/**
 * Configuration owned by the orchestrator core.
 *
 * The core is meant to be extracted into a public repository and consumed here
 * as a submodule (see `docs/core-boundary.md`). It therefore owns only what any
 * user of the orchestrator needs: where the tasks come from, where to notify a
 * human, and where the repository list lives. Everything tied to a particular
 * employer — the company Linear workspace, Sentry, deploy watching — belongs to
 * `AppConfig` on the integration side.
 *
 * `loadCoreConfig` takes the environment as an argument rather than reaching for
 * `process.env` itself. Reading the environment is fine for a tool with its own
 * CLIs; being *unable* to supply values another way is not, because it forces
 * anyone embedding the core to mutate globals.
 */

/** The backends `createTaskProvider` knows how to build. */
export type TaskSourceKind = "linear" | "clickup";

export const TASK_SOURCE_KINDS: readonly TaskSourceKind[] = ["linear", "clickup"];

/** Where a ClickUp workspace keeps the two groups. Both are lists in one space. */
export interface ClickUpLists {
  work: string;
  private: string;
}

export interface CoreConfig {
  /** Which backend the tasks live in. Exactly one is active at a time. */
  taskSource: TaskSourceKind;
  /** API key for the task source. Named after the role, not the vendor. */
  taskSourceApiKey: string;
  /** Set when `taskSource` is `clickup`. */
  clickupLists?: ClickUpLists;
  discordWebhookUrl?: string;
  slackWebhookUrl?: string;
  /** Overrides the default location of the repository list. */
  repositoriesPath?: string;
}

function requireUrl(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} が有効なURLではありません: ${value}`);
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `環境変数が未設定です: ${name}\n` +
        `.env.example を参照して .env ファイルを作成してください。`,
    );
  }
  return value;
}

function taskSourceOf(env: NodeJS.ProcessEnv): TaskSourceKind {
  const raw = env.TASK_SOURCE;
  if (!raw) return "linear";
  if (!(TASK_SOURCE_KINDS as readonly string[]).includes(raw)) {
    throw new Error(`TASK_SOURCE が不正です: ${raw} (${TASK_SOURCE_KINDS.join(" / ")})`);
  }
  return raw as TaskSourceKind;
}

export function loadCoreConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const taskSource = taskSourceOf(env);

  // 使わない側のキーを要求しない。移行の途中では片方しか設定されていない
  const taskSourceApiKey =
    taskSource === "clickup"
      ? required(env, "CLICKUP_PERSONAL_API_KEY")
      : required(env, "LINEAR_PERSONAL_API_KEY");

  const clickupLists =
    taskSource === "clickup"
      ? {
          work: required(env, "CLICKUP_LIST_WORK"),
          private: required(env, "CLICKUP_LIST_PRIVATE"),
        }
      : undefined;

  const discordWebhookUrl = requireUrl(env.DISCORD_WEBHOOK_URL || undefined, "DISCORD_WEBHOOK_URL");
  const slackWebhookUrl = requireUrl(env.SLACK_WEBHOOK_URL || undefined, "SLACK_WEBHOOK_URL");

  if (!discordWebhookUrl && !slackWebhookUrl) {
    throw new Error(
      `通知先が未設定です: DISCORD_WEBHOOK_URL または SLACK_WEBHOOK_URL の少なくとも1つを設定してください。`,
    );
  }

  return {
    taskSource,
    taskSourceApiKey,
    clickupLists,
    discordWebhookUrl,
    slackWebhookUrl,
    repositoriesPath: env.ORCHESTRATOR_REPOSITORIES_PATH || undefined,
  };
}

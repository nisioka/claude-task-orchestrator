import { loadCoreConfig } from "../lib/core-config.js";
import { isRunningAgent, listDaemonJobs, tryListAgents } from "../lib/agent-runtime.js";
import {
  classifyRebase,
  findHandedPullRequests,
  renderRebaseCandidates,
  type RebaseCandidate,
} from "../lib/handed-pull-requests.js";
import { listOpenPullRequests } from "../lib/open-pull-requests.js";
import { loadOrchestratorConfig, parseAgentName, upkeepAgentName } from "../lib/orchestrator-config.js";
import { loadRepositoriesForScope, scopeFilter } from "../lib/task-scope.js";
import { createTaskProvider } from "../lib/tasks/factory.js";
import { loadWorkflow } from "../lib/tasks/workflow.js";

/**
 * List the pull requests the human holds for review that have fallen into
 * conflict, and say which of them the patrol should rebase now.
 *
 * Read-only. It launches nothing and writes nothing; the patrol does that,
 * using the child name and head printed here.
 *
 * Exit codes: 0 a list was printed (possibly empty), 1 something could not be
 * read. On 1 nothing is dispatched: a child already running, or a list cut
 * short, cannot be ruled out.
 */

/** Enough to reach the comment that handed a failed rebase back. */
const COMMENTS_TO_READ = 40;

async function main(): Promise<void> {
  const appConfig = loadCoreConfig();
  const config = loadOrchestratorConfig();
  const workflow = loadWorkflow();
  const tasks = createTaskProvider(appConfig);
  const now = new Date();

  const [held, openPullRequests, repositories, agents, heldByDaemon] = await Promise.all([
    tasks.list({
      assignee: "human",
      statuses: [workflow.inReview],
      withDescription: true,
      ...scopeFilter(config.group),
    }),
    listOpenPullRequests(),
    loadRepositoriesForScope(appConfig.repositoriesPath),
    tryListAgents(config.claudeExecutable),
    listDaemonJobs(),
  ]);
  if (openPullRequests === null) {
    throw new Error("PRの一覧を取得できない。gh の認証か、件数が上限に達している");
  }
  if (agents === null) {
    throw new Error("エージェント一覧を取得できない。動いている子と重ねないため判定しない");
  }

  const conflicting = (await findHandedPullRequests(held, openPullRequests, repositories)).filter(
    (handed) => handed.pullRequest.mergeable === "CONFLICTING",
  );

  const runningChildren = new Map<string, string>();
  for (const agent of agents) {
    const parsed = parseAgentName(agent.name);
    if (!parsed || parsed.role === "orchestrator" || !isRunningAgent(agent, heldByDaemon)) continue;
    runningChildren.set(parsed.issueIdentifier, agent.name);
  }

  const details =
    conflicting.length === 0
      ? []
      : await tasks.getMany([...new Set(conflicting.map((handed) => handed.task.id))], {
          comments: COMMENTS_TO_READ,
        });
  const commentsOf = new Map(details.map((detail) => [detail.id, detail.comments]));

  const candidates: RebaseCandidate[] = conflicting.map((handed) => ({
    ...handed,
    verdict: classifyRebase({
      handed,
      runningChildren,
      comments: commentsOf.get(handed.task.id) ?? [],
      now,
      minIntervalSeconds: config.handedRebaseIntervalSeconds,
    }),
  }));

  console.log(
    [
      `人間の手番のPRのうち、コンフリクトしているもの (${candidates.length}件)`,
      ...renderRebaseCandidates(candidates, upkeepAgentName),
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(`handed-pr-rebase: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

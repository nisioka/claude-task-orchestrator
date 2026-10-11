import type { DiscordPayload } from "./types.js";
import { loadRepositoryConfig, type RepositoryMapping } from "./repositories.js";
import type { TaskProvider } from "./tasks/provider.js";
import type { Task, TaskFilter, TaskGroup } from "./tasks/types.js";

/**
 * Keeps an orchestrator inside the task group it was started for.
 *
 * Splitting orchestrators by group only holds if a task filed in one group
 * cannot pull an instance into the other group's repositories. The group filter
 * alone does not give that: a task in group A carrying the label of a
 * repository that belongs to group B is still "a task in group A", and the
 * session reading it would have to notice the contradiction itself. This module
 * notices it in code, before the session sees the task.
 */

/** The filter fragment that limits a query to this instance's group. */
export function scopeFilter(group: TaskGroup | null): Pick<TaskFilter, "group"> {
  return group ? { group } : {};
}

export interface GroupMismatch {
  task: Task;
  /** The repository label that contradicts the task's group. */
  label: string;
  repositoryGroup: TaskGroup;
}

/**
 * Tasks whose group contradicts the group of a repository they are labelled with.
 *
 * Labels are compared case-insensitively: one task source lower-cases them on
 * read, and a guard that depended on the spelling would silently stop matching.
 * A task without a group, or a repository without one, decides nothing.
 */
export function findGroupMismatches(
  tasks: Task[],
  repositories: RepositoryMapping[],
): GroupMismatch[] {
  const groupByLabel = new Map<string, { label: string; group: TaskGroup }>();
  for (const repository of repositories) {
    if (repository.group) {
      groupByLabel.set(repository.label.toLowerCase(), {
        label: repository.label,
        group: repository.group,
      });
    }
  }

  const mismatches: GroupMismatch[] = [];
  for (const task of tasks) {
    if (task.group === null) continue;
    for (const label of task.labels) {
      const repository = groupByLabel.get(label.toLowerCase());
      if (repository && repository.group !== task.group) {
        mismatches.push({ task, label: repository.label, repositoryGroup: repository.group });
        break;
      }
    }
  }
  return mismatches;
}

/** Drop the mismatched tasks from a list, for views that must not offer them as work. */
export function withoutMismatches(tasks: Task[], mismatches: GroupMismatch[]): Task[] {
  const excluded = new Set(mismatches.map((m) => m.task.id));
  return tasks.filter((task) => !excluded.has(task.id));
}

/**
 * The repository list, or nothing when it cannot be read.
 *
 * Reporting jobs ran without this file before groups existed and must keep
 * doing so. With no list there is nothing to contradict, so the result is "no
 * mismatches" — the same as a list in which no repository names a group.
 */
export async function loadRepositoriesForScope(path?: string): Promise<RepositoryMapping[]> {
  try {
    return (await loadRepositoryConfig(path)).repositories;
  } catch {
    return [];
  }
}

export function buildMismatchComment(mismatch: GroupMismatch): string {
  return [
    "このタスクのグループと、付いているリポジトリラベルのグループが一致しません。",
    "",
    `- タスクのグループ: ${mismatch.task.group}`,
    `- リポジトリラベル: ${mismatch.label}（グループ: ${mismatch.repositoryGroup}）`,
    "",
    "どちらかが誤りのはずなので、着手せずにお返しします。",
    "タスクを正しいグループへ移すか、ラベルを直してから、担当者を戻してください。",
  ].join("\n");
}

export function buildMismatchPayload(mismatches: GroupMismatch[]): DiscordPayload {
  return {
    embeds: [
      {
        title: `⚠ グループが一致しないタスクを差し戻しました (${mismatches.length}件)`,
        description: mismatches
          .map(
            (m) =>
              `${m.task.id}  ${m.task.title}\n` +
              `　タスク: ${m.task.group} / ラベル ${m.label}: ${m.repositoryGroup}`,
          )
          .join("\n"),
        color: 0xff9800,
      },
    ],
  };
}

/**
 * Hand every mismatched task back to the human, and say so once.
 *
 * Reassigning is what takes the task off the AI's queue everywhere at once —
 * ownership is decided by the assignee — so it comes first, and a task whose
 * reassignment failed is left out of the report rather than announced as
 * handled. The comment explains the handback on the task itself, where the
 * human will be looking when they wonder why nothing happened.
 *
 * Returns the mismatches that were actually handed back.
 */
export async function handBackMismatches(
  tasks: TaskProvider,
  mismatches: GroupMismatch[],
  notify: (payload: DiscordPayload) => Promise<void>,
): Promise<GroupMismatch[]> {
  const handedBack: GroupMismatch[] = [];
  for (const mismatch of mismatches) {
    try {
      await tasks.update(mismatch.task.id, { assignee: "human" });
    } catch {
      continue;
    }
    handedBack.push(mismatch);
    // The reassignment is the part that matters; a lost comment must not undo it.
    await tasks.comment(mismatch.task.id, buildMismatchComment(mismatch)).catch(() => undefined);
  }

  if (handedBack.length > 0) {
    await notify(buildMismatchPayload(handedBack)).catch(() => undefined);
  }
  return handedBack;
}

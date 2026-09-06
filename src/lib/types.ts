/**
 * The Linear user an issue is assigned to.
 *
 * Ownership ("whose ball is it") is expressed by the assignee, so this is the
 * authoritative signal for the orchestrator's dispatch decisions.
 */
export interface IssueAssignee {
  id: string;
  name: string;
}

/**
 * Workflow state types that mean "this is finished", in Linear's spelling.
 *
 * "canceled" carries one "l". Writing "cancelled" costs nothing at the type
 * level and matches no state at all, so a filter built on it quietly returns
 * the very issues it was meant to exclude.
 */
export const TERMINAL_STATE_TYPES = ["completed", "canceled", "duplicate"];

export interface TaskIssue {
  id: string;
  identifier: string; // "PERS-42", "ENG-15"
  title: string;
  status: string; // "Wait", "In Progress", etc.
  /**
   * Workflow state *type*: "backlog" | "unstarted" | "started" | "completed" |
   * "canceled" | "duplicate" | "triage".
   *
   * Note the single "l" in "canceled" — Linear's own spelling. A filter written
   * as "cancelled" matches nothing and silently lets those issues through.
   *
   * The name is workspace-specific and the company teams rename theirs freely;
   * the type is Linear's own fixed vocabulary. Anything that must ask "is this
   * finished?" across workspaces has to read this, not the name.
   */
  statusType: string;
  priority: number; // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  dueDate: string | null; // "YYYY-MM-DD" or null
  teamName: string; // "Personal", "Engineering"
  teamKey: string; // "PERS", "ENG"
  updatedAt: string; // ISO 8601 datetime
  labels: string[]; // ["work"], ["private"], etc.
  url: string;
  source: "personal" | "company";
  milestone: string | null;
  /**
   * Required (though nullable) on purpose: making it optional would let the
   * existing jobs silently drop ownership information instead of failing to
   * compile.
   */
  assignee: IssueAssignee | null;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordPayload {
  content?: string;
  username?: string;
  embeds?: DiscordEmbed[];
}

export interface TaskIssueWithDescription extends TaskIssue {
  description: string | null;
}

const MAX_TITLE_LENGTH = 50;

/** タイトルを指定文字数で切り詰める */
export function truncateTitle(title: string, max = MAX_TITLE_LENGTH): string {
  if (title.length <= max) return title;
  return title.slice(0, max) + "…";
}

/** identifier をリンク付き markdown で返す: [ENG-123](url) */
export function formatIssueLink(issue: TaskIssue): string {
  return `[${issue.identifier}](${issue.url})`;
}

/** Escape `[` and `]` in text to prevent breaking markdown link syntax */
export function escapeMarkdownBrackets(text: string): string {
  return text.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** Discord embedフィールド値を1024文字以内に切り詰める（行単位で切断しリンク破壊を防ぐ） */
export function truncateFieldValue(value: string, max = 1024): string {
  if (value.length <= max) return value;

  const suffix = "\n...";
  const budget = max - suffix.length;
  const lines = value.split("\n");
  const kept: string[] = [];
  let total = 0;

  for (const line of lines) {
    const added = total === 0 ? line.length : total + 1 + line.length;
    if (added > budget) {
      if (total === 0) {
        return [...line].slice(0, budget).join("") + suffix;
      }
      break;
    }
    kept.push(line);
    total = added;
  }

  return kept.join("\n") + suffix;
}

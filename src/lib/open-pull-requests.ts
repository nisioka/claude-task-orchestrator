import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The human's open pull requests, with how each one stands against its base.
 *
 * One GraphQL search rather than `gh search prs`: the search command cannot
 * return `mergeable`, and a pull request falling into conflict changes nothing
 * else such a listing shows — not its number, not its place in the list, not
 * even its update time. Anything that compares listings is blind to a conflict
 * unless it asks for this field.
 */

const execFileAsync = promisify(execFile);

/** `UNKNOWN` until GitHub has computed it. Asking is what makes it compute. */
export type Mergeability = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export interface OpenPullRequest {
  /** `owner/name` as GitHub spells it. */
  repository: string;
  number: number;
  url: string;
  headRefName: string;
  headRefOid: string;
  mergeable: Mergeability;
  /** When the head branch was last force-pushed. `null` if it never was. */
  lastForcePushAt: string | null;
}

/** A listing that reaches this many may be missing the one that changed. */
export const OPEN_PULL_REQUEST_LIMIT = 200;

const PAGE_SIZE = 100;

const SEARCH_QUERY = "is:pr is:open author:@me";

const GRAPHQL = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        url
        headRefName
        headRefOid
        mergeable
        repository { nameWithOwner }
        timelineItems(last: 1, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes { ... on HeadRefForcePushedEvent { createdAt } }
        }
      }
    }
  }
}`;

export interface SearchPage {
  issueCount: number;
  endCursor: string | null;
  pullRequests: OpenPullRequest[];
}

/** `owner/name#number`, the key the patrol gate compares. */
export function pullRequestKey(pr: Pick<OpenPullRequest, "repository" | "number">): string {
  return `${pr.repository}#${pr.number}`;
}

function asMergeability(value: unknown): Mergeability {
  return value === "MERGEABLE" || value === "CONFLICTING" ? value : "UNKNOWN";
}

/** One page of the search, as `gh api graphql` prints it. Throws on anything else. */
export function parseSearchPage(stdout: string): SearchPage {
  const parsed = JSON.parse(stdout) as {
    data?: {
      search?: {
        issueCount?: number;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Record<string, unknown>[];
      };
    };
  };
  const search = parsed.data?.search;
  if (!search || typeof search.issueCount !== "number" || !Array.isArray(search.nodes)) {
    throw new Error("PRの検索結果の形が想定と違う");
  }

  const pullRequests = search.nodes.flatMap((node): OpenPullRequest[] => {
    const repository = (node.repository as { nameWithOwner?: unknown } | undefined)?.nameWithOwner;
    if (typeof node.number !== "number" || typeof repository !== "string") return [];
    const pushes = (node.timelineItems as { nodes?: { createdAt?: unknown }[] } | undefined)?.nodes ?? [];
    const lastPush = pushes[pushes.length - 1]?.createdAt;
    return [
      {
        repository,
        number: node.number,
        url: typeof node.url === "string" ? node.url : "",
        headRefName: typeof node.headRefName === "string" ? node.headRefName : "",
        headRefOid: typeof node.headRefOid === "string" ? node.headRefOid : "",
        mergeable: asMergeability(node.mergeable),
        lastForcePushAt: typeof lastPush === "string" ? lastPush : null,
      },
    ];
  });

  return {
    issueCount: search.issueCount,
    endCursor: search.pageInfo?.hasNextPage ? (search.pageInfo.endCursor ?? null) : null,
    pullRequests,
  };
}

export type RunGh = (args: string[]) => Promise<string>;

async function runGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/**
 * Every open pull request the human authored, across all repositories, or
 * `null` when `gh` cannot answer or the list may be incomplete.
 */
export async function listOpenPullRequests(gh: RunGh = runGh): Promise<OpenPullRequest[] | null> {
  try {
    const all: OpenPullRequest[] = [];
    let after: string | null = null;
    for (let page = 0; page * PAGE_SIZE < OPEN_PULL_REQUEST_LIMIT; page++) {
      const args = ["api", "graphql", "-f", `query=${GRAPHQL}`, "-f", `q=${SEARCH_QUERY}`];
      if (after !== null) args.push("-f", `after=${after}`);
      const result = parseSearchPage(await gh(args));
      if (result.issueCount >= OPEN_PULL_REQUEST_LIMIT) return null;
      all.push(...result.pullRequests);
      if (result.endCursor === null) return all;
      after = result.endCursor;
    }
    return null;
  } catch {
    return null;
  }
}

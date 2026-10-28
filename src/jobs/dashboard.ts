import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  collectOrchestratorSnapshot,
  type AgentView,
  type OrchestratorSnapshot,
} from "./orchestrator-status.js";
import { isHeartbeatStale } from "../lib/agent-runtime.js";
import { assessContext } from "../lib/session-context.js";
import { GATE_HEARTBEAT_MARKER } from "../lib/patrol-gate.js";
import { loadOrchestratorConfig, parseAgentName } from "../lib/orchestrator-config.js";
import { humanDutyByStatus } from "../lib/tasks/workflow.js";
import type { Task } from "../lib/tasks/types.js";

/**
 * A local web dashboard over the same state `orchestrator-status` reads, plus
 * what only this machine knows: the patrol log, cron job logs and open PRs.
 *
 * Read-only. It never changes a task or an agent. Each panel is
 * fetched on its own and fails on its own, so one unreachable source does not
 * blank the page.
 */

const execFileAsync = promisify(execFile);

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard");
const PAGE_PATH = join(ASSETS_DIR, "index.html");
const FAVICON_PATH = join(ASSETS_DIR, "favicon.svg");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

// ClickUp and `claude agents` are the slow part; the page refreshes every minute.
const STATUS_TTL_MS = 60 * 1000;
const PRS_TTL_MS = 5 * 60 * 1000;
const CRON_TTL_MS = 60 * 1000;

const PATROL_ROWS = 30;
const PATROL_DAYS = 7;
const LOG_TAIL_LINES = 200;
const DEFAULT_SYSLOG_PATH = "/var/log/syslog";
const PULL_REQUEST_LIMIT = 100;

// ─── Status ─────────────────────────────────────────────────────────

export interface IssueView {
  id: string;
  title: string;
  status: string;
  url: string;
  updatedAt: string;
}

export interface AgentPanel {
  name: string;
  subject: string;
  state: string | null;
  detail: string | null;
  startedAt: string | null;
  cwd: string;
  contextTokens: number | null;
  contextLimitTokens: number | null;
  contextOver: boolean;
}

export interface StatusView {
  group: string | null;
  orchestrator: {
    agent: AgentPanel | null;
    heartbeatAt: string | null;
    heartbeatNote: string | null;
    heartbeatStale: boolean;
  };
  children: AgentPanel[];
  /** The workflow's Wait status. Shown, but not counted as something the human has to act on. */
  waitStatus: string;
  /** Grouped by duty, longest wait first inside each group. */
  humanQueue: { duty: string; issues: IssueView[] }[];
  aiQueue: { status: string; issues: IssueView[] }[];
  scheduled: { issue: IssueView; at: string }[];
  invalidSchedules: { issue: IssueView; raw: string }[];
  mismatches: { issue: IssueView; taskGroup: string | null; label: string; repositoryGroup: string }[];
}

function issueView(task: Task): IssueView {
  return { id: task.id, title: task.title, status: task.status, url: task.url, updatedAt: task.updatedAt };
}

function groupOldestFirst(tasks: Task[], keyOf: (task: Task) => string): { key: string; issues: IssueView[] }[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = keyOf(task);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return [...groups].map(([key, members]) => ({
    key,
    issues: [...members]
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
      .map(issueView),
  }));
}

function agentPanel(view: AgentView, limitTokens: number | null): AgentPanel {
  const parsed = parseAgentName(view.agent.name);
  return {
    name: view.agent.name,
    subject: parsed && "issueIdentifier" in parsed ? parsed.issueIdentifier : view.agent.name,
    state: view.state?.state ?? view.agent.state,
    detail: view.state?.detail ?? null,
    startedAt: view.agent.startedAt === null ? null : new Date(view.agent.startedAt).toISOString(),
    cwd: view.agent.cwd,
    contextTokens: view.context?.contextTokens ?? null,
    contextLimitTokens: limitTokens,
    contextOver: assessContext(view.context, limitTokens) === "over",
  };
}

export function buildStatusView(snapshot: OrchestratorSnapshot): StatusView {
  const duties = humanDutyByStatus(snapshot.workflow);
  const { heartbeat } = snapshot;

  return {
    group: snapshot.group,
    orchestrator: {
      agent: snapshot.orchestrator
        ? agentPanel(snapshot.orchestrator, snapshot.sessionContextLimitTokens)
        : null,
      heartbeatAt: heartbeat?.at ?? null,
      heartbeatNote: heartbeat?.note ?? null,
      // Stale only means something while the session is up; a stopped one is reported as stopped.
      heartbeatStale:
        snapshot.orchestrator !== null &&
        heartbeat !== null &&
        isHeartbeatStale(heartbeat, snapshot.takenAt, snapshot.maxIntervalSeconds),
    },
    children: snapshot.children.map((child) => agentPanel(child, snapshot.childContextLimitTokens)),
    waitStatus: snapshot.workflow.wait,
    humanQueue: groupOldestFirst(snapshot.humanIssues, (t) => duties[t.status] ?? "その他").map(
      ({ key, issues }) => ({ duty: key, issues }),
    ),
    aiQueue: groupOldestFirst(snapshot.aiIssues, (t) => t.status).map(({ key, issues }) => ({
      status: key,
      issues,
    })),
    scheduled: [...snapshot.schedule.pending]
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map(({ issue, at }) => ({ issue: issueView(issue), at: at.toISOString() })),
    invalidSchedules: snapshot.schedule.invalid.map(({ issue, raw }) => ({ issue: issueView(issue), raw })),
    mismatches: snapshot.mismatches.map((m) => ({
      issue: issueView(m.task),
      taskGroup: m.task.group,
      label: m.label,
      repositoryGroup: m.repositoryGroup,
    })),
  };
}

// ─── Patrols ────────────────────────────────────────────────────────

export interface PatrolRow {
  at: string;
  gate: boolean;
  dispatched: string[];
  handedToHuman: string[];
  note: string | null;
}

export interface PatrolDay {
  /** JST calendar date, YYYY-MM-DD. */
  date: string;
  patrols: number;
  gateSkips: number;
  dispatched: number;
  handedToHuman: number;
}

export interface PatrolView {
  recent: PatrolRow[];
  days: PatrolDay[];
}

function parsePatrolLine(line: string): PatrolRow | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (typeof raw.at !== "string") return null;
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return {
      at: raw.at,
      gate: raw[GATE_HEARTBEAT_MARKER] === true,
      dispatched: ids(raw.dispatched),
      handedToHuman: ids(raw.handedToHuman),
      note: typeof raw.note === "string" ? raw.note : null,
    };
  } catch {
    return null;
  }
}

function jstDate(date: Date): string {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Recent patrols, newest first, and per-day totals for the last week (JST days, today included). */
export function summarizePatrols(raw: string, now: Date): PatrolView {
  const rows = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parsePatrolLine)
    .filter((row): row is PatrolRow => row !== null);

  const days: PatrolDay[] = [];
  for (let back = PATROL_DAYS - 1; back >= 0; back--) {
    const date = jstDate(new Date(now.getTime() - back * 24 * 60 * 60 * 1000));
    days.push({ date, patrols: 0, gateSkips: 0, dispatched: 0, handedToHuman: 0 });
  }
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const row of rows) {
    const day = byDate.get(jstDate(new Date(row.at)));
    if (!day) continue;
    if (row.gate) day.gateSkips++;
    else day.patrols++;
    day.dispatched += row.dispatched.length;
    day.handedToHuman += row.handedToHuman.length;
  }

  return { recent: rows.slice(-PATROL_ROWS).reverse(), days };
}

// ─── Cron jobs ──────────────────────────────────────────────────────

export interface CronTarget {
  job: string;
  schedules: string[];
  logPath: string;
  /** The command part of each line, as cron logs it when starting the job. */
  commands: string[];
}

export interface CronJobView extends CronTarget {
  /** When cron last started it, from syslog. A job that ran quietly leaves its log untouched. */
  startedAt: string | null;
  updatedAt: string | null;
  sizeBytes: number | null;
  lastLine: string | null;
  lastErrorLine: string | null;
}

function expandHomeIn(path: string): string {
  return path.replace(/^\$HOME(?=\/)/, homedir()).replace(/^~(?=\/)/, homedir());
}

/**
 * The jobs in a crontab that append to a log file, one entry per log.
 *
 * Only logged lines are listed: a job with no log has nothing to read here.
 */
export function parseCronTargets(crontab: string): CronTarget[] {
  const byLog = new Map<string, CronTarget>();
  for (const line of crontab.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const log = trimmed.match(/>>\s*(\S+)/);
    if (!log) continue;
    const fields = trimmed.split(/\s+/);
    const schedule = fields.slice(0, 5).join(" ");
    const command = trimmed.replace(/^(\S+\s+){5}/, "");
    const logPath = expandHomeIn(log[1]);
    const job =
      trimmed.match(/(?:src\/index\.ts|orchestrator\.sh\s+\S+)\s+([\w-]+)/)?.[1] ??
      logPath.split("/").pop()!.replace(/\.log$/, "");

    const existing = byLog.get(logPath);
    if (existing) {
      existing.schedules.push(schedule);
      existing.commands.push(command);
    } else {
      byLog.set(logPath, { job, schedules: [schedule], logPath, commands: [command] });
    }
  }
  return [...byLog.values()];
}

const ERROR_LINE = /エラー|Error|ERR!/;

/** The last line, and the last line that looks like an error, from the tail of a log. */
export function summarizeLogTail(text: string): { lastLine: string | null; lastErrorLine: string | null } {
  const lines = text.split("\n").filter((line) => line.trim() !== "").slice(-LOG_TAIL_LINES);
  return {
    lastLine: lines.at(-1) ?? null,
    lastErrorLine: [...lines].reverse().find((line) => ERROR_LINE.test(line)) ?? null,
  };
}

/** The last start of each command, from syslog lines like `... CRON[123]: (user) CMD (<command>)`. */
export function parseCronStarts(syslog: string): Map<string, string> {
  const starts = new Map<string, string>();
  for (const line of syslog.split("\n")) {
    const m = line.match(/^(\S+)\s.*\bCRON\[\d+\]: \([^)]*\) CMD \((.*)\)$/);
    if (!m) continue;
    const at = new Date(m[1]);
    if (!Number.isNaN(at.getTime())) starts.set(m[2], at.toISOString());
  }
  return starts;
}

function latest(isos: (string | undefined)[]): string | null {
  return isos.filter((x): x is string => x !== undefined).sort().at(-1) ?? null;
}

async function cronStarts(syslogPath: string): Promise<Map<string, string>> {
  try {
    const { stdout } = await execFileAsync("grep", ["-a", "CRON\\[.*CMD (", syslogPath], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return parseCronStarts(stdout);
  } catch {
    // Unreadable or rotated away: the panel still shows the logs.
    return new Map();
  }
}

async function readTail(path: string, bytes = 64 * 1024): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf-8");
  } finally {
    await handle.close();
  }
}

async function cronJobs(syslogPath: string): Promise<CronJobView[]> {
  const [{ stdout }, starts] = await Promise.all([execFileAsync("crontab", ["-l"]), cronStarts(syslogPath)]);
  return Promise.all(
    parseCronTargets(stdout).map(async (target) => {
      const startedAt = latest(target.commands.map((command) => starts.get(command)));
      try {
        const info = await stat(target.logPath);
        return {
          ...target,
          startedAt,
          updatedAt: info.mtime.toISOString(),
          sizeBytes: info.size,
          ...summarizeLogTail(await readTail(target.logPath)),
        };
      } catch {
        return { ...target, startedAt, updatedAt: null, sizeBytes: null, lastLine: null, lastErrorLine: null };
      }
    }),
  );
}

// ─── Open PRs ────────────────────────────────────────

export interface PullRequestView {
  repo: string;
  number: number;
  title: string;
  url: string;
}

/** `gh search prs --json repository,number,title,url` output. */
export function parseOpenPrs(json: string): PullRequestView[] {
  const rows = JSON.parse(json) as {
    repository?: { nameWithOwner?: string };
    number?: number;
    title?: string;
    url?: string;
  }[];
  return rows
    .filter((row) => row.repository?.nameWithOwner && typeof row.number === "number" && row.url)
    .map((row) => ({
      repo: row.repository!.nameWithOwner!,
      number: row.number!,
      title: row.title ?? "",
      url: row.url!,
    }));
}

/** The human's open pull requests across every repository, the same list the patrol gate watches. */
async function openPrs(): Promise<PullRequestView[]> {
  const { stdout } = await execFileAsync(
    "gh",
    [
      "search", "prs",
      "--author", "@me",
      "--state", "open",
      "--limit", String(PULL_REQUEST_LIMIT),
      "--json", "repository,number,title,url",
    ],
    { maxBuffer: 10 * 1024 * 1024, timeout: 60 * 1000 },
  );
  return parseOpenPrs(stdout);
}

// ─── Serving ────────────────────────────────────────────────────────

type Panel<T> = { ok: true; data: T; fetchedAt: string } | { ok: false; error: string; fetchedAt: string };

/** One fetch in flight at a time, reused until it is `ttlMs` old. Failures are not kept. */
function cached<T>(ttlMs: number, load: () => Promise<T>): () => Promise<Panel<T>> {
  let last: { at: number; panel: Promise<Panel<T>> } | null = null;
  return () => {
    const now = Date.now();
    if (last && now - last.at < ttlMs) return last.panel;
    const panel = load().then(
      (data): Panel<T> => ({ ok: true, data, fetchedAt: new Date().toISOString() }),
      (error: unknown): Panel<T> => {
        if (last?.panel === panel) last = null;
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          fetchedAt: new Date().toISOString(),
        };
      },
    );
    last = { at: now, panel };
    return panel;
  };
}

function uncached<T>(load: () => Promise<T>): () => Promise<Panel<T>> {
  return cached(0, load);
}

export async function runDashboard(): Promise<void> {
  const config = loadOrchestratorConfig();
  const host = process.env.DASHBOARD_HOST || DEFAULT_HOST;
  const port = Number(process.env.DASHBOARD_PORT || DEFAULT_PORT);
  const syslogPath = process.env.DASHBOARD_SYSLOG_PATH || DEFAULT_SYSLOG_PATH;

  const panels = {
    status: cached(STATUS_TTL_MS, async () => buildStatusView(await collectOrchestratorSnapshot())),
    patrols: uncached(async () => summarizePatrols(await readFile(config.heartbeatPath, "utf-8"), new Date())),
    cron: cached(CRON_TTL_MS, () => cronJobs(syslogPath)),
    prs: cached(PRS_TTL_MS, openPrs),
  };

  const send = (res: ServerResponse, code: number, type: string, body: string) => {
    res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
    res.end(body);
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== "GET") return send(res, 405, "text/plain", "GET only");
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/") return send(res, 200, "text/html", await readFile(PAGE_PATH, "utf-8"));
      if (path === "/favicon.svg") return send(res, 200, "image/svg+xml", await readFile(FAVICON_PATH, "utf-8"));
      const panel = path.match(/^\/api\/(\w+)$/)?.[1];
      if (panel && Object.hasOwn(panels, panel)) {
        const body = await panels[panel as keyof typeof panels]();
        return send(res, 200, "application/json", JSON.stringify(body));
      }
      return send(res, 404, "text/plain", "not found");
    } catch (error) {
      send(res, 500, "text/plain", error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`dashboard: http://${host}:${port}/`);
  // Serve until killed; the job runner must not exit underneath the server.
  await new Promise<never>(() => {});
}

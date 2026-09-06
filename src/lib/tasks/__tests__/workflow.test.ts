import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WORKFLOW,
  activeOrder,
  humanBallStatuses,
  humanDutyByStatus,
  loadWorkflow,
  offTheQueueStatuses,
  parseWorkflow,
  promptNames,
  remindedStatuses,
  reportCategories,
  terminalStatuses,
} from "../workflow.js";

const PATH = "/tmp/workflow.json";

/** A workflow whose every name differs from the built-in one. */
const RENAMED = {
  backlog: "backlog",
  queued: "to do",
  inProgress: "in progress",
  question: "question",
  wait: "wait",
  inReview: "in review",
  test: "deploy & test",
  done: "done",
  canceled: "canceled",
  duplicate: "duplicate",
  extraTerminal: ["complete"],
  extraBacklog: [],
};

// ─── Derived groupings ──────────────────────────────────────────────

describe("terminalStatuses", () => {
  it("is the three canonical endings", () => {
    expect(terminalStatuses(DEFAULT_WORKFLOW)).toEqual(["Done", "Canceled", "Duplicate"]);
  });

  it("includes a source's extra ending", () => {
    // ClickUp's `Closed` group contributes an ending that accepts no siblings,
    // so it cannot be folded into `done`.
    const w = parseWorkflow(RENAMED, PATH);

    expect(terminalStatuses(w)).toContain("complete");
  });
});

describe("offTheQueueStatuses", () => {
  it("is the backlog plus everything terminal", () => {
    expect(offTheQueueStatuses(DEFAULT_WORKFLOW)).toEqual([
      "Backlog",
      "Done",
      "Canceled",
      "Duplicate",
    ]);
  });

  it("leaves every working status in the queue", () => {
    // A denylist, deliberately: an allowlist would hide anything the human
    // handed over without also moving the status.
    const off = new Set(offTheQueueStatuses(DEFAULT_WORKFLOW));

    for (const status of ["Todo", "In Progress", "Question", "Wait", "In Review", "Test"]) {
      expect(off.has(status)).toBe(false);
    }
  });
});

describe("humanDutyByStatus", () => {
  it("labels each status the human holds with the duty it implies", () => {
    expect(humanDutyByStatus(DEFAULT_WORKFLOW)).toEqual({
      Question: "要件確認",
      Test: "実機テスト",
      "In Review": "レビューとマージ",
      Wait: "待ちの解除確認",
    });
  });

  it("follows a rename", () => {
    expect(humanDutyByStatus(parseWorkflow(RENAMED, PATH))["deploy & test"]).toBe("実機テスト");
  });

  it("agrees with humanBallStatuses", () => {
    expect(humanBallStatuses(DEFAULT_WORKFLOW)).toEqual(
      Object.keys(humanDutyByStatus(DEFAULT_WORKFLOW)),
    );
  });
});

describe("remindedStatuses", () => {
  it("is the two statuses nothing moves out of on its own", () => {
    expect(remindedStatuses(DEFAULT_WORKFLOW)).toEqual(["Wait", "Question"]);
  });
});

describe("activeOrder", () => {
  it("lists the live statuses in display order", () => {
    expect(activeOrder(DEFAULT_WORKFLOW)).toEqual([
      "In Progress",
      "Todo",
      "In Review",
      "Test",
      "Wait",
    ]);
  });
});

describe("reportCategories", () => {
  it("puts every status into exactly one heading", () => {
    const categories = reportCategories(DEFAULT_WORKFLOW);
    const all = [...categories.Done, ...categories.Doing, ...categories.Todo];

    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(
      [
        "Backlog",
        "Canceled",
        "Done",
        "Duplicate",
        "In Progress",
        "In Review",
        "Question",
        "Test",
        "Todo",
        "Wait",
      ].sort(),
    );
  });
});

describe("promptNames", () => {
  it("is empty when nothing was renamed", () => {
    expect(promptNames(DEFAULT_WORKFLOW)).toEqual({});
  });

  it("maps only the names that differ", () => {
    // The prompt sources are written in the built-in vocabulary; this is what
    // turns them into the configured one.
    expect(promptNames(parseWorkflow(RENAMED, PATH))).toEqual({
      Backlog: "backlog",
      Todo: "to do",
      "In Progress": "in progress",
      Question: "question",
      Wait: "wait",
      "In Review": "in review",
      Test: "deploy & test",
      Done: "done",
      Canceled: "canceled",
      Duplicate: "duplicate",
    });
  });

  it("ignores the extras, which have no built-in name to rename from", () => {
    const w = parseWorkflow({ extraTerminal: ["complete"] }, PATH);

    expect(promptNames(w)).toEqual({});
  });
});

// ─── Parsing ────────────────────────────────────────────────────────

describe("parseWorkflow", () => {
  it("fills in every name the file leaves out", () => {
    const w = parseWorkflow({ queued: "to do" }, PATH);

    expect(w.queued).toBe("to do");
    expect(w.inReview).toBe("In Review");
  });

  it("rejects a key that is not a status, rather than ignoring it", () => {
    // A silently ignored typo would leave the built-in name in force and only
    // show up as a job that quietly matches nothing.
    expect(() => parseWorkflow({ inreview: "x" }, PATH)).toThrow(/未知のキー/);
  });

  it("rejects an empty name", () => {
    expect(() => parseWorkflow({ queued: "  " }, PATH)).toThrow(/空でない文字列/);
  });

  it("rejects a name given as a list", () => {
    expect(() => parseWorkflow({ queued: ["a"] }, PATH)).toThrow(/空でない文字列/);
  });

  it("rejects an extra list that is not a list of names", () => {
    expect(() => parseWorkflow({ extraTerminal: "complete" }, PATH)).toThrow(/配列/);
  });

  it("rejects one name used for two purposes", () => {
    // The groupings are derived, so a shared name would put the same status
    // both on the AI's queue and off it.
    expect(() => parseWorkflow({ question: "Wait" }, PATH)).toThrow(/両方に指定/);
  });

  it("rejects an extra that repeats a canonical name", () => {
    expect(() => parseWorkflow({ extraTerminal: ["Done"] }, PATH)).toThrow(/両方に指定/);
  });

  it("rejects a top-level list", () => {
    expect(() => parseWorkflow([], PATH)).toThrow(/オブジェクトではありません/);
  });
});

// ─── Loading ────────────────────────────────────────────────────────

describe("loadWorkflow", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "workflow-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the file the environment points at", () => {
    const path = join(dir, "workflow.json");
    writeFileSync(path, JSON.stringify({ queued: "to do" }));

    expect(loadWorkflow({ ORCHESTRATOR_WORKFLOW_PATH: path }).queued).toBe("to do");
  });

  it("falls back to the built-in names when the default location has no file", () => {
    // Absence is the normal case: the defaults describe a workspace that
    // already exists, so a single-source setup needs no file at all.
    expect(loadWorkflow({ HOME: dir })).toEqual(DEFAULT_WORKFLOW);
  });

  it("reads the default location when it does hold a file", () => {
    // The negative control for the test above: without this, that test would
    // pass just as well if the default location were never consulted.
    const configDir = join(dir, ".config", "ai-orchestrator");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "workflow.json"), JSON.stringify({ queued: "to do" }));

    expect(loadWorkflow({ HOME: dir }).queued).toBe("to do");
  });

  it("fails when the configured file is missing", () => {
    expect(() => loadWorkflow({ ORCHESTRATOR_WORKFLOW_PATH: join(dir, "absent.json") })).toThrow(
      /見つかりません/,
    );
  });

  it("names the file when it is not JSON", () => {
    const path = join(dir, "workflow.json");
    writeFileSync(path, "{");

    expect(() => loadWorkflow({ ORCHESTRATOR_WORKFLOW_PATH: path })).toThrow(
      new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });
});

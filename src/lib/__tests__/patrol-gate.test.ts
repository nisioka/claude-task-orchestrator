import { describe, it, expect } from "vitest";
import {
  buildGateHeartbeat,
  decideGate,
  EMPTY_GATE_STATE,
  findLastPatrol,
  foreignRepositoryNames,
  formatDecision,
  gateAction,
  gitHubRepositoryOf,
  parseGateState,
  withoutForeignPullRequests,
  type GateSnapshot,
  type GateState,
} from "../patrol-gate.js";
import { parseHeartbeatTail, type HeartbeatRecord } from "../agent-runtime.js";

const NOW = new Date("2026-08-06T12:00:00.000Z");
const HOUR = 3600;

function snapshot(overrides: Partial<GateSnapshot> = {}): GateSnapshot {
  return {
    aiIssues: ["TASK-1|Todo|2026-08-06T10:00:00.000Z"],
    scheduledPending: [],
    openPullRequests: ["owner/repo#1"],
    runningChildren: [],
    activeChildren: [],
    ...overrides,
  };
}

function patrolAt(iso: string): HeartbeatRecord {
  return { at: iso, dispatched: [], handedToHuman: [], note: null };
}

function settled(snap: GateSnapshot = snapshot()): GateState {
  return { baseline: { snapshot: snap, at: "2026-08-06T11:30:00.000Z" }, candidate: null };
}

describe("decideGate", () => {
  it("何も変わっておらず前回の巡回が最近なら省略する", () => {
    const decision = decideGate({
      snapshot: snapshot(),
      state: settled(),
      lastPatrol: patrolAt("2026-08-06T11:40:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    expect(decision.verdict).toBe("skip");
    expect(decision.state).toEqual(settled());
  });

  it("並び順の違いは変化とみなさない", () => {
    const base = snapshot({ aiIssues: ["A|Todo|t", "B|Test|t"] });
    const decision = decideGate({
      snapshot: snapshot({ aiIssues: ["B|Test|t", "A|Todo|t"] }),
      state: settled(base),
      lastPatrol: patrolAt("2026-08-06T11:40:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    // 基準は正規化前に保存されたものでも比較できる必要がある
    expect(decision.reasons).not.toContain("AIのボールが変化");
  });

  it.each([
    ["AIのボールが変化", { aiIssues: ["TASK-1|Todo|2026-08-06T11:55:00.000Z"] }],
    ["予約投入が変化", { scheduledPending: ["TASK-9"] }],
    ["オープンPRが変化", { openPullRequests: [] }],
  ])("%s なら巡回する", (reason, change) => {
    const decision = decideGate({
      snapshot: snapshot(change),
      state: settled(),
      lastPatrol: patrolAt("2026-08-06T11:40:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    expect(decision.verdict).toBe("patrol");
    expect(decision.reasons).toContain(reason);
    expect(decision.state.candidate?.at).toBe(NOW.toISOString());
  });

  it("人間が引き取った子や blocked の子は、変化が無ければ巡回の理由にしない", () => {
    const parked = snapshot({ runningChildren: ["ai-impl-TASK-2|working", "ai-impl-TASK-1|blocked"] });
    const decision = decideGate({
      snapshot: parked,
      state: settled(parked),
      lastPatrol: patrolAt("2026-08-06T11:40:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    expect(decision.verdict).toBe("skip");
  });

  it("子の状態が変われば巡回する", () => {
    const decision = decideGate({
      snapshot: snapshot({ runningChildren: ["ai-impl-TASK-1|blocked"] }),
      state: settled(snapshot({ runningChildren: ["ai-impl-TASK-1|working"] })),
      lastPatrol: patrolAt("2026-08-06T11:40:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    expect(decision.verdict).toBe("patrol");
    expect(decision.reasons).toContain("子エージェントが変化");
  });

  it("AIのイシューで作業中の子がいる間は、変化が無くても巡回する", () => {
    const running = snapshot({
      runningChildren: ["ai-impl-TASK-1|working"],
      activeChildren: ["ai-impl-TASK-1"],
    });
    const decision = decideGate({
      snapshot: running,
      state: settled(running),
      lastPatrol: patrolAt("2026-08-06T11:40:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    expect(decision.verdict).toBe("patrol");
  });

  it("PRの一覧が取れないときは巡回する", () => {
    const decision = decideGate({
      snapshot: snapshot({ openPullRequests: null }),
      state: settled(),
      lastPatrol: patrolAt("2026-08-06T11:40:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    expect(decision.verdict).toBe("patrol");
    expect(decision.reasons).toContain("PRの一覧を取得できなかった");
  });

  it("基準が無い初回は巡回する", () => {
    const decision = decideGate({
      snapshot: snapshot(),
      state: EMPTY_GATE_STATE,
      lastPatrol: patrolAt("2026-08-06T11:40:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    expect(decision.verdict).toBe("patrol");
    expect(decision.state.baseline).toBeNull();
    expect(decision.state.candidate?.snapshot).toEqual(snapshot());
  });

  it("前回の巡回から上限を超えたら、変化が無くても巡回する", () => {
    const decision = decideGate({
      snapshot: snapshot(),
      state: settled(),
      lastPatrol: patrolAt("2026-08-06T10:59:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    expect(decision.verdict).toBe("patrol");
    expect(decision.reasons).toContain("前回の巡回から61分経過");
  });

  it("巡回のハートビートが候補より後なら、候補を基準に繰り上げる", () => {
    const newer = snapshot({ aiIssues: [] });
    const state: GateState = {
      baseline: settled().baseline,
      candidate: { snapshot: newer, at: "2026-08-06T11:30:00.000Z" },
    };
    const decision = decideGate({
      snapshot: newer,
      state,
      lastPatrol: patrolAt("2026-08-06T11:35:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    expect(decision.verdict).toBe("skip");
    expect(decision.state.baseline?.snapshot).toEqual(newer);
    expect(decision.state.candidate).toBeNull();
  });

  it("候補の後に巡回が終わっていなければ繰り上げず、古い基準と比べる", () => {
    const newer = snapshot({ aiIssues: [] });
    const state: GateState = {
      baseline: settled().baseline,
      candidate: { snapshot: newer, at: "2026-08-06T11:30:00.000Z" },
    };
    const decision = decideGate({
      snapshot: newer,
      state,
      // 候補を作った巡回が途中で死に、ハートビートはそれより前のまま
      lastPatrol: patrolAt("2026-08-06T11:20:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    expect(decision.verdict).toBe("patrol");
    expect(decision.reasons).toContain("AIのボールが変化");
  });
});

describe("findLastPatrol", () => {
  it("ゲートが書いた行を飛ばして、最後の巡回の行を返す", () => {
    const raw = [
      JSON.stringify({ at: "2026-08-06T11:00:00.000Z", dispatched: ["A"], handedToHuman: [], note: "巡回" }),
      buildGateHeartbeat(new Date("2026-08-06T11:30:00.000Z")),
      "not json",
      "",
    ].join("\n");
    expect(findLastPatrol(raw)?.at).toBe("2026-08-06T11:00:00.000Z");
    expect(findLastPatrol(raw)?.dispatched).toEqual(["A"]);
  });

  it("巡回の行が無ければ null", () => {
    expect(findLastPatrol(buildGateHeartbeat(NOW))).toBeNull();
    expect(findLastPatrol("")).toBeNull();
  });
});

describe("formatDecision", () => {
  it("省略は skip、巡回は patrol で始まる", () => {
    const last = patrolAt("2026-08-06T11:48:00.000Z");
    expect(formatDecision({ verdict: "skip", reasons: [], state: EMPTY_GATE_STATE }, last, NOW)).toBe(
      "巡回ゲート: skip — 変化なし（前回の巡回から12分）",
    );
    expect(
      formatDecision({ verdict: "patrol", reasons: ["a", "b"], state: EMPTY_GATE_STATE }, last, NOW),
    ).toBe("巡回ゲート: patrol — a / b");
  });
});

describe("parseGateState", () => {
  it("壊れた記録は空として読む", () => {
    expect(parseGateState("{")).toEqual(EMPTY_GATE_STATE);
    expect(parseGateState(JSON.stringify({ baseline: { at: "x" } }))).toEqual(EMPTY_GATE_STATE);
  });

  it("書いたものを読み戻せる", () => {
    expect(parseGateState(JSON.stringify(settled()))).toEqual(settled());
  });
});

describe("ORCHESTRATOR_IDLE_EXIT のときのゲート", () => {
  const skip = { verdict: "skip" as const, reasons: [], state: EMPTY_GATE_STATE };
  const patrol = { verdict: "patrol" as const, reasons: ["子エージェントが作業中（1件）"], state: EMPTY_GATE_STATE };

  it("省略の代わりに exit を返す", () => {
    expect(gateAction(skip, true)).toBe("exit");
    expect(formatDecision(skip, patrolAt("2026-08-06T11:48:00.000Z"), NOW, true)).toBe(
      "巡回ゲート: exit — 変化なし（前回の巡回から12分）",
    );
  });

  it("巡回すべきときは有効でも patrol のまま", () => {
    expect(gateAction(patrol, true)).toBe("patrol");
    expect(formatDecision(patrol, null, NOW, true)).toBe("巡回ゲート: patrol — 子エージェントが作業中（1件）");
  });

  it("無効なら今までどおり skip", () => {
    expect(gateAction(skip, false)).toBe("skip");
  });

  it("作業中の子がいれば、有効でも exit にならない", () => {
    const decision = decideGate({
      snapshot: snapshot({ runningChildren: ["ai-impl-TASK-1|working"], activeChildren: ["ai-impl-TASK-1"] }),
      state: settled(snapshot({ runningChildren: ["ai-impl-TASK-1|working"], activeChildren: ["ai-impl-TASK-1"] })),
      lastPatrol: patrolAt("2026-08-06T11:50:00.000Z"),
      now: NOW,
      fullPatrolSeconds: HOUR,
    });
    expect(gateAction(decision, true)).toBe("patrol");
  });

  it("idle の印を付けたハートビートを書き、それは巡回として数えない", () => {
    const line = buildGateHeartbeat(NOW, true);
    expect(parseHeartbeatTail(line)?.idle).toBe(true);
    expect(findLastPatrol(line)).toBeNull();
  });

  it("無効のときのハートビートには印が付かない", () => {
    expect(parseHeartbeatTail(buildGateHeartbeat(NOW))?.idle).toBeUndefined();
  });
});

describe("gitHubRepositoryOf", () => {
  it("reads the remote forms git prints", () => {
    for (const url of [
      "https://github.com/acme/Widget.git",
      "https://github.com/acme/Widget",
      "https://github.com/acme/Widget/",
      "https://token@github.com/acme/Widget.git",
      "git@github.com:acme/Widget.git",
      "git@github.com:/acme/Widget.git",
      "ssh://git@github.com/acme/Widget.git",
      "ssh://git@github.com:22/acme/Widget",
      "  https://github.com/acme/Widget.git\n",
    ]) {
      expect(gitHubRepositoryOf(url), url).toBe("acme/widget");
    }
  });

  it("keeps dots in the name", () => {
    expect(gitHubRepositoryOf("https://github.com/acme/example.com.git")).toBe("acme/example.com");
  });

  it("does not guess at anything else", () => {
    expect(gitHubRepositoryOf("")).toBeNull();
    expect(gitHubRepositoryOf("https://gitlab.com/acme/widget.git")).toBeNull();
    expect(gitHubRepositoryOf("/srv/git/widget.git")).toBeNull();
    expect(gitHubRepositoryOf("https://github.com/acme")).toBeNull();
  });
});

describe("foreignRepositoryNames", () => {
  it("names the other group's repositories", () => {
    const names = foreignRepositoryNames(
      [
        { group: "work", name: "corp/app" },
        { group: "private", name: "me/blog" },
        { name: "me/dotfiles" },
      ],
      "private",
    );
    expect([...names]).toEqual(["corp/app"]);
  });

  it("does not call a repository foreign when this group or no group also holds it", () => {
    const names = foreignRepositoryNames(
      [
        { group: "work", name: "me/tools" },
        { group: "private", name: "me/tools" },
        { group: "work", name: "me/notes" },
        { name: "me/notes" },
      ],
      "private",
    );
    expect(names.size).toBe(0);
  });

  it("skips a repository whose remote could not be read", () => {
    expect(foreignRepositoryNames([{ group: "work", name: null }], "private").size).toBe(0);
  });
});

describe("withoutForeignPullRequests", () => {
  const prs = ["corp/App#12", "me/blog#3", "me/unregistered#1"];

  it("drops only the other group's pull requests, ignoring case", () => {
    expect(withoutForeignPullRequests(prs, new Set(["corp/app"]))).toEqual(["me/blog#3", "me/unregistered#1"]);
  });

  it("keeps everything when nothing is foreign", () => {
    expect(withoutForeignPullRequests(prs, new Set())).toEqual(prs);
  });

  it("stops the other group's pull request from forcing a patrol", () => {
    const before = withoutForeignPullRequests(["corp/app#12", "me/blog#3"], new Set(["corp/app"]));
    const after = withoutForeignPullRequests(["corp/app#13", "me/blog#3"], new Set(["corp/app"]));
    expect(after).toEqual(before);
  });
});

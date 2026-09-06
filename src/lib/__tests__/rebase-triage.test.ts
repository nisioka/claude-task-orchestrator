import { describe, it, expect } from "vitest";
import {
  classifyConflict,
  classifyConflicts,
  defaultRebaseRules,
  matchesGlob,
  rebaseRulesFor,
  renderPlan,
  type RebaseRules,
} from "../rebase-triage.js";

const BE_RULES: RebaseRules = rebaseRulesFor({
  generatedPaths: ["src/main/kotlin/nu/studer/jooq/**"],
  regenerateCommand: "make db/flyway/migrate",
  migrationPaths: ["src/main/resources/db/migration*/**"],
  renumberCommand: "make db/flyway/reorder/develop",
  handLimit: 10,
});

// ─── matchesGlob ────────────────────────────────────────────────────

describe("matchesGlob", () => {
  it("matches across directories with **", () => {
    expect(matchesGlob("src/main/kotlin/nu/studer/jooq/keys/Keys.kt", "src/main/kotlin/nu/studer/jooq/**")).toBe(true);
  });

  it("keeps * inside one segment", () => {
    expect(matchesGlob("apps/web/package-lock.json", "*/package-lock.json")).toBe(false);
    expect(matchesGlob("apps/package-lock.json", "*/package-lock.json")).toBe(true);
  });

  it("lets **/ match at the root too", () => {
    expect(matchesGlob("package-lock.json", "**/package-lock.json")).toBe(true);
    expect(matchesGlob("apps/web/package-lock.json", "**/package-lock.json")).toBe(true);
  });

  it("does not treat dots as wildcards", () => {
    expect(matchesGlob("packageXlock.json", "**/package-lock.json")).toBe(false);
  });
});

// ─── classifyConflict ───────────────────────────────────────────────

describe("classifyConflict", () => {
  it("sends generated sources to regeneration", () => {
    expect(classifyConflict("src/main/kotlin/nu/studer/jooq/keys/Keys.kt", BE_RULES)).toBe("regenerate");
  });

  it("sends numbered migrations to renumbering", () => {
    expect(classifyConflict("src/main/resources/db/migration/V123__add_column.sql", BE_RULES)).toBe("renumber");
  });

  it("treats lock files as generated without any repository configuration", () => {
    expect(classifyConflict("pnpm-lock.yaml", defaultRebaseRules())).toBe("regenerate");
  });

  it("leaves everything else to a person", () => {
    expect(classifyConflict("src/main/kotlin/app/MailService.kt", BE_RULES)).toBe("hand");
  });

  it("classifies nothing beyond lock files without configuration", () => {
    expect(classifyConflict("src/main/kotlin/nu/studer/jooq/keys/Keys.kt", defaultRebaseRules())).toBe("hand");
  });
});

describe("exclusions", () => {
  const rules = rebaseRulesFor({
    generatedPaths: ["client/**", "!client/mutator/**"],
    regenerateCommand: "make generate/orval-client",
  });

  it("regenerates the generated tree", () => {
    expect(classifyConflict("client/account-resource/account-resource.ts", rules)).toBe("regenerate");
  });

  it("leaves the hand-written file inside it alone", () => {
    expect(classifyConflict("client/mutator/custom-instance.ts", rules)).toBe("hand");
  });
});

// ─── classifyConflicts ──────────────────────────────────────────────

describe("classifyConflicts", () => {
  it("reports a clean rebase", () => {
    expect(classifyConflicts([], BE_RULES).verdict).toBe("clean");
  });

  it("calls it mechanical when nothing needs reading", () => {
    const result = classifyConflicts(
      [
        "src/main/kotlin/nu/studer/jooq/keys/Keys.kt",
        "src/main/resources/db/migration/V9__x.sql",
        "pnpm-lock.yaml",
      ],
      BE_RULES,
    );

    expect(result.verdict).toBe("mechanical");
    expect(result.regenerate).toHaveLength(2);
    expect(result.renumber).toHaveLength(1);
  });

  it("calls it mixed when some real code conflicts too", () => {
    const result = classifyConflicts(
      ["src/main/kotlin/nu/studer/jooq/keys/Keys.kt", "src/main/kotlin/app/MailService.kt"],
      BE_RULES,
    );

    expect(result.verdict).toBe("mixed");
    expect(result.hand).toEqual(["src/main/kotlin/app/MailService.kt"]);
  });

  it("hands the whole rebase over once the judgement pile is too big", () => {
    const many = Array.from({ length: 11 }, (_, i) => `src/main/kotlin/app/File${i}.kt`);

    expect(classifyConflicts(many, BE_RULES).verdict).toBe("handToHuman");
  });

  it("still takes it on exactly at the limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => `src/main/kotlin/app/File${i}.kt`);

    expect(classifyConflicts(many, BE_RULES).verdict).toBe("mixed");
  });
});

// ─── renderPlan ─────────────────────────────────────────────────────

describe("renderPlan", () => {
  it("quotes the regeneration command instead of asking for a merge", () => {
    const result = classifyConflicts(["src/main/kotlin/nu/studer/jooq/keys/Keys.kt"], BE_RULES);
    const plan = renderPlan(result, BE_RULES).join("\n");

    expect(plan).toContain("make db/flyway/migrate");
    expect(plan).toContain("読まない");
  });

  it("warns when the repository named generated paths but no command to rebuild them", () => {
    const rules = rebaseRulesFor({ generatedPaths: ["gen/**"] });
    const plan = renderPlan(classifyConflicts(["gen/Api.kt"], rules), rules).join("\n");

    expect(plan).toContain("再生成コマンドが設定されていません");
  });

  it("tells the agent to stop when the rebase is not mechanical", () => {
    const many = Array.from({ length: 11 }, (_, i) => `src/main/kotlin/app/File${i}.kt`);
    const plan = renderPlan(classifyConflicts(many, BE_RULES), BE_RULES).join("\n");

    expect(plan).toContain("人間へ渡してください");
    expect(plan).toContain("SHA");
  });

  it("says so when there is nothing to resolve", () => {
    expect(renderPlan(classifyConflicts([], BE_RULES), BE_RULES).join("\n")).toContain(
      "コンフリクトはありません",
    );
  });
});

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeChildSettings,
  mergeSettings,
  readSettingsFile,
  writeChildSettings,
} from "../child-settings.js";

describe("mergeSettings", () => {
  it("lets a later layer win per key, merges objects and joins arrays", () => {
    expect(
      mergeSettings(
        { permissions: { allow: ["Bash(git push:*)"] }, model: "opus", enabledPlugins: { a: true } },
        { permissions: { allow: ["Bash(git push:*)", "Read"] }, enabledPlugins: { b: false }, model: "haiku" },
      ),
    ).toEqual({
      permissions: { allow: ["Bash(git push:*)", "Read"] },
      model: "haiku",
      enabledPlugins: { a: true, b: false },
    });
  });

  it("skips missing layers", () => {
    expect(mergeSettings(null, { a: 1 }, null)).toEqual({ a: 1 });
  });
});

describe("composeChildSettings", () => {
  const local = { permissions: { allow: ["Bash(git push:*)"] } };
  const overlay = { enabledPlugins: { "x@market": false } };

  it("gives an implementation child the local settings and the overlay, and keeps its CLAUDE.md", () => {
    const { impl } = composeChildSettings({ local, overlay, repoDir: "/repo" });

    expect(impl).toEqual({ ...local, ...overlay });
    expect(impl).not.toHaveProperty("claudeMdExcludes");
  });

  it("passes nothing to an implementation child when there is nothing to pass", () => {
    expect(composeChildSettings({ local: null, overlay: null, repoDir: "/repo" }).impl).toBeNull();
  });

  it("leaves the repository's CLAUDE.md out of a judgement child, by absolute path", () => {
    const { judge } = composeChildSettings({ local, overlay, repoDir: "/repo" });

    expect(judge).toEqual({
      ...local,
      ...overlay,
      claudeMdExcludes: ["/repo/CLAUDE.md", "/repo/CLAUDE.local.md"],
    });
  });

  it("gives the resident session only the exclusion — the overlay is for children", () => {
    expect(composeChildSettings({ local, overlay, repoDir: "/repo" }).orchestrator).toEqual({
      claudeMdExcludes: ["/repo/CLAUDE.md", "/repo/CLAUDE.local.md"],
    });
  });
});

describe("readSettingsFile / writeChildSettings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "child-settings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a missing file as nothing and a broken one as an error", async () => {
    expect(await readSettingsFile(join(dir, "none.json"))).toBeNull();
    expect(await readSettingsFile(null)).toBeNull();
    await writeFile(join(dir, "list.json"), "[]");
    await expect(readSettingsFile(join(dir, "list.json"))).rejects.toThrow("オブジェクトではありません");
  });

  it("writes the three files from the repository's local settings and the overlay", async () => {
    const repoDir = join(dir, "repo");
    await mkdir(join(repoDir, ".claude"), { recursive: true });
    await writeFile(join(repoDir, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
    await writeFile(join(dir, "overlay.json"), JSON.stringify({ enabledPlugins: { "x@m": false } }));

    const paths = await writeChildSettings({ stateDir: join(dir, "state"), repoDir, overlayPath: join(dir, "overlay.json") });

    expect(JSON.parse(await readFile(paths.impl!, "utf-8"))).toEqual({
      permissions: { allow: ["Read"] },
      enabledPlugins: { "x@m": false },
    });
    expect(JSON.parse(await readFile(paths.judge, "utf-8")).claudeMdExcludes).toEqual([
      join(repoDir, "CLAUDE.md"),
      join(repoDir, "CLAUDE.local.md"),
    ]);
    expect(paths.orchestrator).toBe(join(dir, "state", "child-settings", "orchestrator.json"));
  });

  it("writes no implementation file when the repository has no local settings and there is no overlay", async () => {
    const paths = await writeChildSettings({ stateDir: dir, repoDir: join(dir, "repo"), overlayPath: join(dir, "none.json") });

    expect(paths.impl).toBeNull();
  });
});

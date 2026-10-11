import { describe, it, expect } from "vitest";
import { claudeConfigDir, daemonSocketDirName } from "../claude-config.js";

describe("claudeConfigDir", () => {
  it("is ~/.claude when nothing says otherwise", () => {
    expect(claudeConfigDir({}, "/home/tester")).toBe("/home/tester/.claude");
  });

  it("follows CLAUDE_CONFIG_DIR, because that is what the CLI itself obeys", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/home/tester/.claude-second" }, "/home/tester")).toBe(
      "/home/tester/.claude-second",
    );
  });

  it("expands a leading ~", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "~/.claude-second" }, "/home/tester")).toBe(
      "/home/tester/.claude-second",
    );
  });

  it("treats a blank value as unset rather than as the current directory", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "  " }, "/home/tester")).toBe("/home/tester/.claude");
  });

  it("drops a trailing slash so the same directory always spells the same", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/home/tester/.claude-second/" }, "/home/tester")).toBe(
      "/home/tester/.claude-second",
    );
  });
});

describe("daemonSocketDirName", () => {
  it("is eight hex digits that differ between config dirs", () => {
    const first = daemonSocketDirName("/home/tester/.claude");
    const second = daemonSocketDirName("/home/tester/.claude-second");

    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(second).toMatch(/^[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  it("is stable for the same config dir", () => {
    expect(daemonSocketDirName("/home/tester/.claude")).toBe(daemonSocketDirName("/home/tester/.claude"));
  });
});

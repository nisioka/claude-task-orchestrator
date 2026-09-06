import { describe, it, expect } from "vitest";
import { dirname } from "node:path";
import { extraPathEntries, buildPath, buildExecEnv } from "../exec-env.js";

const HOME = "/home/tester";

describe("extraPathEntries", () => {
  it("includes ~/.local/bin, the pnpm directory and the Node runtime directory", () => {
    const entries = extraPathEntries(HOME, "/opt/node/bin");

    expect(entries).toContain("/home/tester/.local/bin");
    expect(entries).toContain("/home/tester/.local/share/pnpm");
    expect(entries).toContain("/opt/node/bin");
  });

  it("defaults the Node directory to the running interpreter", () => {
    const entries = extraPathEntries(HOME);

    expect(entries).toContain(dirname(process.execPath));
  });

  it("contains no duplicates even when the Node directory repeats an entry", () => {
    const entries = extraPathEntries(HOME, "/home/tester/.local/bin");

    expect(new Set(entries).size).toBe(entries.length);
  });
});

describe("buildPath", () => {
  it("puts the extra entries ahead of the inherited PATH", () => {
    const result = buildPath("/usr/bin:/bin", HOME, "/opt/node/bin").split(":");

    expect(result[0]).toBe("/home/tester/.local/bin");
    expect(result.indexOf("/usr/bin")).toBeGreaterThan(result.indexOf("/opt/node/bin"));
  });

  it("keeps the inherited entries", () => {
    const result = buildPath("/usr/bin:/bin", HOME, "/opt/node/bin").split(":");

    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("removes duplicates, keeping the first occurrence", () => {
    const result = buildPath(
      "/usr/bin:/home/tester/.local/bin:/usr/bin",
      HOME,
      "/opt/node/bin",
    ).split(":");

    expect(result.filter((p) => p === "/home/tester/.local/bin")).toHaveLength(1);
    expect(result.filter((p) => p === "/usr/bin")).toHaveLength(1);
    // The extras win the front position even though PATH also listed it later.
    expect(result[0]).toBe("/home/tester/.local/bin");
  });

  it("works when PATH is unset — cron gives a minimal or absent PATH", () => {
    const result = buildPath(undefined, HOME, "/opt/node/bin").split(":");

    expect(result).toEqual([
      "/home/tester/.local/bin",
      "/home/tester/.local/share/pnpm",
      "/opt/node/bin",
    ]);
  });

  it("drops empty segments from a malformed PATH", () => {
    const result = buildPath("::/usr/bin:", HOME, "/opt/node/bin").split(":");

    expect(result).not.toContain("");
  });
});

describe("buildExecEnv", () => {
  it("overrides PATH while preserving the other variables", () => {
    const env = buildExecEnv({ PATH: "/usr/bin", FOO: "bar" }, HOME, "/opt/node/bin");

    expect(env.FOO).toBe("bar");
    expect(env.PATH?.split(":")[0]).toBe("/home/tester/.local/bin");
    expect(env.PATH?.split(":")).toContain("/usr/bin");
  });

  it("does not mutate the base environment", () => {
    const base = { PATH: "/usr/bin" };

    buildExecEnv(base, HOME, "/opt/node/bin");

    expect(base.PATH).toBe("/usr/bin");
  });
});

import { describe, it, expect } from "vitest";
import { parseArgs } from "../personal-field.js";

describe("parseArgs", () => {
  it("reads the id, the name and the value", () => {
    expect(parseArgs(["--id=TASK-1", "--name=worktree", "--value=/abs/wt"])).toEqual({
      identifier: "TASK-1",
      name: "worktree",
      value: "/abs/wt",
    });
  });

  it("keeps a value that contains '='", () => {
    // Splitting on '=' would cut a query string or a `--flag=value` in half.
    expect(parseArgs(["--id=T", "--name=n", "--value=https://x/y?a=b&c=d"]).value).toBe(
      "https://x/y?a=b&c=d",
    );
  });

  it("accepts an empty value, which means clearing the field", () => {
    expect(parseArgs(["--id=T", "--name=n", "--value="]).value).toBe("");
  });

  it("insists on each of the three", () => {
    expect(() => parseArgs(["--name=n", "--value=v"])).toThrow(/--id=/);
    expect(() => parseArgs(["--id=T", "--value=v"])).toThrow(/--name=/);
    expect(() => parseArgs(["--id=T", "--name=n"])).toThrow(/--value=/);
  });

  it("rejects an argument it does not know rather than ignoring it", () => {
    expect(() => parseArgs(["--id=T", "--name=n", "--value=v", "--wroktree"])).toThrow(
      /不明な引数/,
    );
  });
});

import { describe, it, expect } from "vitest";
import { parseArgs } from "../personal-label.js";

describe("parseArgs", () => {
  it("reads the id and one label", () => {
    expect(parseArgs(["--id=TASK-1", "--label=webapp-backend"])).toEqual({
      identifier: "TASK-1",
      labels: ["webapp-backend"],
    });
  });

  it("collects a repeated --label", () => {
    expect(parseArgs(["--id=T", "--label=work", "--label=urgent"]).labels).toEqual(["work", "urgent"]);
  });

  it("splits a comma-separated value", () => {
    expect(parseArgs(["--id=T", "--label=work,urgent"]).labels).toEqual(["work", "urgent"]);
  });

  it("drops the empty pieces a trailing comma leaves behind", () => {
    expect(parseArgs(["--id=T", "--label=work, ,urgent,"]).labels).toEqual(["work", "urgent"]);
  });

  it("lowercases, because a capitalized name makes a second label in Linear", () => {
    expect(parseArgs(["--id=T", "--label=WebApp-Backend"]).labels).toEqual(["webapp-backend"]);
  });

  it("insists on both", () => {
    expect(() => parseArgs(["--label=work"])).toThrow(/--id=/);
    expect(() => parseArgs(["--id=T"])).toThrow(/--label=/);
  });

  it("treats a value that is only separators as no label at all", () => {
    expect(() => parseArgs(["--id=T", "--label=,, "])).toThrow(/--label=/);
  });

  it("rejects an argument it does not know rather than ignoring it", () => {
    expect(() => parseArgs(["--id=T", "--label=work", "--lable=urgent"])).toThrow(/不明な引数/);
  });
});

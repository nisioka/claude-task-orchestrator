import { describe, it, expect } from "vitest";
import { parseMessage } from "../send-reminder.js";

describe("parseMessage", () => {
  it("joins the arguments into one message", () => {
    expect(parseMessage(["TASK-1:", "判断待ちです"])).toBe("TASK-1: 判断待ちです");
  });

  it("refuses to send without a message, rather than sending a canned text", () => {
    expect(() => parseMessage([])).toThrow(/メッセージが空/);
  });

  it("treats whitespace-only arguments as empty", () => {
    expect(() => parseMessage(["", "  "])).toThrow(/メッセージが空/);
  });
});

import { describe, it, expect } from "vitest";
import { loadCoreConfig } from "../core-config.js";

const NOTIFY = { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x" };

describe("loadCoreConfig", () => {
  it("reads Linear when nothing says otherwise", () => {
    const config = loadCoreConfig({ ...NOTIFY, LINEAR_PERSONAL_API_KEY: "lin_key" });

    expect(config.taskSource).toBe("linear");
    expect(config.taskSourceApiKey).toBe("lin_key");
    expect(config.clickupLists).toBeUndefined();
  });

  it("reads ClickUp's key and lists when the source is ClickUp", () => {
    const config = loadCoreConfig({
      ...NOTIFY,
      TASK_SOURCE: "clickup",
      CLICKUP_PERSONAL_API_KEY: "pk_key",
      CLICKUP_LIST_WORK: "L1",
      CLICKUP_LIST_PRIVATE: "L2",
    });

    expect(config.taskSourceApiKey).toBe("pk_key");
    expect(config.clickupLists).toEqual({ work: "L1", private: "L2" });
  });

  it("does not demand the key of the source it is not using", () => {
    // Both keys sit in one `.env` through the migration; requiring the unused
    // one would make switching back and forth a two-step edit.
    expect(() =>
      loadCoreConfig({
        ...NOTIFY,
        TASK_SOURCE: "clickup",
        CLICKUP_PERSONAL_API_KEY: "pk_key",
        CLICKUP_LIST_WORK: "L1",
        CLICKUP_LIST_PRIVATE: "L2",
      }),
    ).not.toThrow();
  });

  it("names the list variable it is missing", () => {
    expect(() =>
      loadCoreConfig({ ...NOTIFY, TASK_SOURCE: "clickup", CLICKUP_PERSONAL_API_KEY: "pk_key" }),
    ).toThrow(/CLICKUP_LIST_WORK/);
  });

  it("rejects a source it has no provider for", () => {
    expect(() => loadCoreConfig({ ...NOTIFY, TASK_SOURCE: "jira" })).toThrow(/TASK_SOURCE/);
  });

  it("still requires somewhere to notify a human", () => {
    expect(() => loadCoreConfig({ LINEAR_PERSONAL_API_KEY: "lin_key" })).toThrow(/通知先/);
  });
});

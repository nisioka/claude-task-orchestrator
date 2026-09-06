import { describe, it, expect } from "vitest";
import { createTaskProvider } from "../factory.js";
import type { CoreConfig } from "../../core-config.js";

function config(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    taskSource: "linear",
    taskSourceApiKey: "key",
    discordWebhookUrl: "https://discord.com/api/webhooks/1/x",
    ...overrides,
  };
}

describe("createTaskProvider", () => {
  it("builds the Linear provider by default", () => {
    expect(createTaskProvider(config()).name).toBe("linear");
  });

  it("builds the ClickUp provider when the source says so", () => {
    const provider = createTaskProvider(
      config({ taskSource: "clickup", clickupLists: { work: "1", private: "2" } }),
    );

    expect(provider.name).toBe("clickup");
  });

  it("refuses ClickUp without the lists rather than reading nothing", () => {
    // A provider pointed at no list answers every query with an empty result,
    // which reads exactly like "there is no work".
    expect(() => createTaskProvider(config({ taskSource: "clickup" }))).toThrow(
      /CLICKUP_LIST_WORK/,
    );
  });
});

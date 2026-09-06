import type { CoreConfig } from "../core-config.js";
import type { TaskProvider } from "./provider.js";
import { LinearTaskProvider } from "./linear-provider.js";
import { ClickUpTaskProvider } from "./clickup-provider.js";

/**
 * Builds the one provider this run talks to.
 *
 * Every job goes through here rather than naming a backend, so switching
 * sources is a change to the environment and not to nine call sites. There is
 * deliberately no way to get two at once: with two live sources, "which copy is
 * authoritative" becomes a question every cycle has to answer.
 */
export function createTaskProvider(config: CoreConfig): TaskProvider {
  if (config.taskSource === "clickup") {
    if (!config.clickupLists) {
      throw new Error("CLICKUP_LIST_WORK / CLICKUP_LIST_PRIVATE が未設定です。");
    }
    return new ClickUpTaskProvider(config.taskSourceApiKey, config.clickupLists);
  }
  return new LinearTaskProvider(config.taskSourceApiKey);
}

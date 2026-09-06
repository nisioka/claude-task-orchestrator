import { resolve } from "node:path";

/**
 * Keeps the suite off the machine's own configuration.
 *
 * `loadWorkflow()` reads `~/.config/ai-orchestrator/workflow.json` when nothing
 * points elsewhere, and that file exists on any machine actually running this.
 * Without this the tests read whatever workflow the operator configured, and
 * every assertion about a status name starts failing the day they rename one —
 * while CI stays green, because a runner has no such file.
 *
 * The fixture is an empty object, which `parseWorkflow` merges over the
 * built-in names: the defaults, stated explicitly rather than inherited from
 * the absence of a file.
 */
process.env.ORCHESTRATOR_WORKFLOW_PATH = resolve("test-fixtures/workflow.default.json");

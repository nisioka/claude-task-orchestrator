import { defineConfig } from "vitest/config";

/**
 * This file also exists to stop vitest walking up the directory tree.
 *
 * The core is normally checked out *inside* the repository that embeds it, and
 * without a config of its own vitest finds the parent's and applies its
 * `setupFiles` — paths that do not resolve from here. The whole supervisor
 * suite failed that way, locally only: the core's own CI has no parent to find.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});

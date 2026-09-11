import { defineConfig } from "vitest/config";

/**
 * Dist smoke-test config (run via `pnpm test:dist`, separate from the default unit run).
 * These tests import the BUILT `dist/` artifact, so they require a prior `pnpm build` and
 * are deliberately excluded from the default `pnpm test` glob (see `vitest.config.ts`).
 */
export default defineConfig({
  test: {
    include: ["tests/dist/**/*.test.ts"],
    environment: "node",
  },
});

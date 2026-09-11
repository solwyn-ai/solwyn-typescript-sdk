import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Dist smoke tests import the BUILT `dist/` artifact and need a prior `pnpm build`;
    // they run separately via `pnpm test:dist` (see `vitest.dist.config.ts`).
    exclude: ["tests/dist/**", "node_modules/**"],
    environment: "node",
  },
});

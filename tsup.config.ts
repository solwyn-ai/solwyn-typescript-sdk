import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Node-only entry: AsyncLocalStorage-backed run scope. The `node:async_hooks`
    // import is left external by esbuild (all `node:`-prefixed builtins are), so the
    // edge-safe `index` bundle never pulls it in.
    node: "src/node.ts",
    // Vercel AI SDK middleware entry. Content-privileged but edge-safe: the `ai` package
    // is imported TYPE-ONLY (erased), so this bundle carries no runtime dependency on `ai`
    // and the package still builds/runs with `ai` absent. Emitted to dist/ai-sdk/index.*
    // to match the `./ai-sdk` export map.
    "ai-sdk/index": "src/ai-sdk/index.ts",
    "testing/index": "src/testing/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  treeshake: true,
  // Code-split the ESM build so the analyzable literal `import("./openai")` in
  // src/providers/index.ts becomes a real, lazily-fetched chunk (dist/openai-*.js)
  // instead of being inlined — preserving the registry's lazy-load property
  // (CLAUDE.md invariant 3). esbuild does NOT support splitting for the CJS format;
  // there the same literal import is emitted as a lazily-resolved inlined module
  // (correct, resolvable, but not a separate chunk). Correctness holds for both
  // formats; laziness (separate chunk) holds where the format supports it (ESM).
  splitting: true,
});

/**
 * Dist smoke harness for the `./ai-sdk` entry. Loads a BUILT entry (ESM
 * `dist/ai-sdk/index.js` or CJS `dist/ai-sdk/index.cjs`, passed as argv[2]) exactly the way
 * a consumer's Node would — via a real dynamic `import()`, NO bundler/vitest resolution in
 * the path — then:
 *
 *   1. constructs the middleware via `createSolwynMiddleware({ apiKey, fetch, logger })`,
 *   2. asserts the returned handle shape (middleware.wrapGenerate/wrapStream + lifecycle),
 *   3. closes it, and prints a JSON result.
 *
 * The ESM `dist/ai-sdk/index.js` STATICALLY imports five sibling code-split chunk files
 * (`../chunk-*.js`); this exercises that those specifiers resolve in the published layout in
 * BOTH module formats (the unit suite resolves them against `src/`, never the built chunks).
 * `createSolwynMiddleware` has zero runtime dependency on the optional `ai` peer, so the
 * harness does not import `ai` at all.
 */

const entry = process.argv[2];
if (entry === undefined) {
  throw new Error("ai-sdk harness: missing entry path argument");
}

const mod = await import(entry);
const { createSolwynMiddleware } = mod;
if (typeof createSolwynMiddleware !== "function") {
  throw new Error(`ai-sdk harness: built entry ${entry} did not export createSolwynMiddleware`);
}

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
const fetchStub = async () => new Response("[]", { status: 202 });
const apiKey = `sk_proj_${"a".repeat(64)}`;

const handle = createSolwynMiddleware({ apiKey, fetch: fetchStub, logger: noopLogger });

const hasWrapGenerate = typeof handle?.middleware?.wrapGenerate === "function";
const hasWrapStream = typeof handle?.middleware?.wrapStream === "function";
const hasClose = typeof handle?.close === "function";
const hasDispose = typeof handle?.[Symbol.asyncDispose] === "function";

await handle.close();

process.stdout.write(
  `${JSON.stringify({ loaded: true, hasWrapGenerate, hasWrapStream, hasClose, hasDispose })}\n`,
);

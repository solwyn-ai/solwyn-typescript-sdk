/**
 * ESM loader-hooks module (registered via `node:module`'s `register`) used by
 * `harness.mjs` to observe module loading in the BUILT artifact. It records the URL of
 * the concrete `/openai-<hash>.js|cjs` adapter chunk emitted by tsup (excluding the
 * separately emitted `openai-compatible` chunk) and posts its URL back over the
 * `MessagePort` supplied at registration.
 *
 * This lets the dist smoke test assert the registry's laziness property:
 * importing the package entry and constructing a client must NOT pull in the openai
 * adapter chunk; only the first intercepted call does.
 */

/** @type {import("node:worker_threads").MessagePort | undefined} */
let port;

/** Receives the transferred MessagePort passed as `data` to `register`. */
export function initialize(data) {
  port = data;
  port?.on("message", (message) => {
    if (message?.type === "barrier") {
      port?.postMessage({ type: "barrier", id: message.id });
    }
  });
  port?.postMessage({ type: "ready" });
}

/** Load hook: signal back whenever the code-split openai adapter chunk is loaded. */
export async function load(url, context, nextLoad) {
  if (/\/openai-(?!compatible-)[^/]+\.(?:js|cjs)$/.test(url)) {
    port?.postMessage({ type: "loaded", url });
  }
  return nextLoad(url, context);
}

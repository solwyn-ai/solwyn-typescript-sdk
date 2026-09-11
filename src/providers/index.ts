/**
 * Adapter registry: the global, ordered list of {@link ProviderAdapter} instances
 * plus the three sans-I/O lookup functions (`getAdapterByName` /
 * `getAdapterForModel` / `getAdapterForClient`).
 *
 * Ported from `solwyn/providers/__init__.py`. Two load-bearing properties:
 *
 *  1. **Lazy loading (CLAUDE.md invariant 3).** Concrete adapter modules
 *     (`./openai`, `./anthropic`, `./google`, `./bedrock`, `./openai-compatible`) are
 *     NOT statically imported. They are pulled in via dynamic `import()` on the FIRST
 *     call to any lookup function, which keeps provider-SDK-shaped code out of the
 *     static import graph until actually used. Because dynamic `import()` is
 *     asynchronous in JS, the lookup functions are `async` — a deliberate, necessary
 *     divergence from the synchronous Python lookups. (None of the adapter modules
 *     value-import a provider SDK — detection is fully duck-typed — so loading them all
 *     together on first use still pulls in zero peer dependencies.)
 *
 *  2. **Registration order (CLAUDE.md invariant 4).** {@link ADAPTER_REGISTRATION_ORDER}
 *     is the final, load-bearing sequence: all OpenAI-compatible profile adapters
 *     (named profiles first, generic `openai_compatible` catch-all LAST among them),
 *     THEN the plain `openai` adapter (it matches any openai-SDK-shaped client
 *     regardless of `baseURL`, so it must never precede a compat profile), then
 *     `anthropic`, `google`, `bedrock`. First match wins in
 *     `getAdapterForModel` / `getAdapterForClient`.
 *
 * All concrete adapter modules are registered (the four native-dialect adapters, the
 * first-class Together adapter, and the remaining OpenAI-compatible profiles built by
 * `./openai-compatible`). This module never
 * touches prompt/response content — only client type shape and plain strings.
 */

import { ConfigurationError } from "../errors";
import type { ProviderName } from "../types";
import { ADAPTER_REGISTRATION_ORDER, describeDetectedClientType } from "./detection";
import type { ProviderAdapter } from "./protocol";

export type { ProviderIdentity } from "./detection";
export { ADAPTER_REGISTRATION_ORDER, resolveProviderIdentity } from "./detection";

// ---------------------------------------------------------------------------
// Registration order (load-bearing — CLAUDE.md invariant 4).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lazy loader table.
// ---------------------------------------------------------------------------

/** Constructs (or otherwise resolves) a concrete adapter instance on first use. */
export type AdapterLoader = () => Promise<ProviderAdapter>;

/** Native adapter names; every other name in the order table is a shared compat profile. */
const NATIVE_ADAPTER_NAMES: ReadonlySet<ProviderName> = new Set<ProviderName>([
  "openai",
  "anthropic",
  "google",
  "bedrock",
  "together",
]);

/**
 * Memoized index of the shared OpenAI-compatible profile adapters, keyed by profile name.
 * The whole `./openai-compatible` module builds the profile table in one pass
 * (`buildCompatAdapters`), so the FIRST shared compat-name loader triggers the dynamic
 * import + build and every subsequent compat-name loader reads from this cache. The
 * first-class Together slot bypasses this map. Cleared alongside the adapter singleton by
 * the test hooks so injected-loader runs never see a stale cache. Building these does not
 * import any provider SDK (compat detection is duck-typed), so eager materialization on
 * first use keeps CLAUDE.md invariant 3.
 */
let compatAdaptersByName: Map<string, ProviderAdapter> | null = null;

/** Resolve one compat-profile adapter by name, materializing the full set on first call. */
async function loadCompatAdapterByName(name: string): Promise<ProviderAdapter> {
  if (compatAdaptersByName === null) {
    const mod = await import("./openai-compatible");
    compatAdaptersByName = new Map(
      mod.buildCompatAdapters().map((adapter) => [adapter.name, adapter]),
    );
  }
  const adapter = compatAdaptersByName.get(name);
  if (adapter === undefined) {
    // Defensive: a compat name in ADAPTER_REGISTRATION_ORDER with no matching profile.
    throw new ConfigurationError(`compat profile '${name}' has no built adapter`, {
      field: "provider",
    });
  }
  return adapter;
}

/**
 * Concrete default loaders, keyed by adapter name — one per name in
 * {@link ADAPTER_REGISTRATION_ORDER}. Native and first-class adapters each construct their
 * own class; shared compat profiles resolve through {@link loadCompatAdapterByName}.
 * Iteration for detection always follows {@link ADAPTER_REGISTRATION_ORDER}, not this
 * object's key order.
 *
 * Each native loader uses an **analyzable literal** `import("./<module>")` — the specifier
 * is a string literal inside `import()`, NOT a runtime variable. This is load-bearing for
 * the published build: tsup/esbuild only rewrites dynamic imports it can statically see, so
 * a literal lets the bundler emit a real, resolvable chunk (code-split in ESM, and a
 * lazily-resolved inlined module in CJS where esbuild cannot code-split). A runtime-variable
 * specifier (`import(specifier)`) is left verbatim and resolves to a nonexistent
 * `./<module>` sibling in `dist`, so the built artifact would throw `ERR_MODULE_NOT_FOUND`
 * on the first intercepted call. Laziness is preserved by the dynamic import itself (the
 * chunk is fetched on first use); the concrete modules still stay out of the STATIC import
 * graph, so CLAUDE.md invariant 3 (no provider-SDK code imported until used) holds. This
 * file compiles independently of the sibling adapter modules because `import()`
 * type-resolution is deferred.
 */
const DEFAULT_LOADERS: Partial<Record<ProviderName, AdapterLoader>> = {
  openai: async () => new (await import("./openai")).OpenAIAdapter(),
  anthropic: async () => new (await import("./anthropic")).AnthropicAdapter(),
  google: async () => new (await import("./google")).GoogleAdapter(),
  bedrock: async () => new (await import("./bedrock")).BedrockAdapter(),
  together: async () => new (await import("./together")).TogetherAdapter(),
};
// Every non-native name is an OpenAI-compatible profile served by the shared builder.
for (const name of ADAPTER_REGISTRATION_ORDER) {
  if (!NATIVE_ADAPTER_NAMES.has(name)) {
    DEFAULT_LOADERS[name] = () => loadCompatAdapterByName(name);
  }
}

// ---------------------------------------------------------------------------
// Lazy singleton state (mirrors Python's `_ensure_loaded()` module globals).
// ---------------------------------------------------------------------------

let activeLoaders: Partial<Record<ProviderName, AdapterLoader>> = DEFAULT_LOADERS;
let loadedAdapters: ProviderAdapter[] | null = null;
let loadedByName: Map<string, ProviderAdapter> | null = null;
/** In-flight guard: concurrent first-callers share a single load. */
let loadPromise: Promise<void> | null = null;

async function runLoad(): Promise<void> {
  const adapters: ProviderAdapter[] = [];
  const byName = new Map<string, ProviderAdapter>();
  for (const name of ADAPTER_REGISTRATION_ORDER) {
    const loader = activeLoaders[name];
    if (loader === undefined) {
      continue;
    }
    const adapter = await loader();
    adapters.push(adapter);
    byName.set(adapter.name, adapter);
  }
  loadedAdapters = adapters;
  loadedByName = byName;
}

/**
 * Idempotent, side-effect-free-to-re-call lazy initializer. Populates the adapter
 * singletons on first invocation; a no-op afterwards. Node is single-threaded per
 * isolate, but async interleaving is still possible, so a shared in-flight promise
 * collapses concurrent first-callers onto one load.
 */
function ensureLoaded(): Promise<void> {
  if (loadedAdapters !== null) {
    return Promise.resolve();
  }
  if (loadPromise === null) {
    loadPromise = runLoad();
  }
  return loadPromise;
}

// ---------------------------------------------------------------------------
// Client-type description (Python `type(client).__name__` substitute).
// ---------------------------------------------------------------------------

/**
 * A stable, content-free label for a client's runtime type, used only in error
 * messages. TS classes carry no module-origin string, so we approximate Python's
 * `type(client).__name__` with the constructor name.
 */
export function describeClientType(client: unknown): string {
  return describeDetectedClientType(client);
}

// ---------------------------------------------------------------------------
// Lookup functions (async — see file header on lazy dynamic import).
// ---------------------------------------------------------------------------

function knownNames(): string[] {
  return [...(loadedByName?.keys() ?? [])].sort();
}

/**
 * Exact-match lookup in the name→adapter map. Throws {@link ConfigurationError}
 * (field `"provider"`) on a miss, echoing the queried name and the sorted list of
 * known names. Never returns a default/wildcard adapter — an empty name is a miss.
 */
export async function getAdapterByName(name: string): Promise<ProviderAdapter> {
  await ensureLoaded();
  const adapter = loadedByName?.get(name);
  if (adapter === undefined) {
    throw new ConfigurationError(`Unknown provider '${name}'. Known: ${knownNames().join(", ")}`, {
      field: "provider",
    });
  }
  return adapter;
}

/**
 * First adapter (in {@link ADAPTER_REGISTRATION_ORDER}) whose `detectModel(model)`
 * returns true. Throws {@link ConfigurationError} on a miss, echoing the model
 * string — NEVER silently falls back to any default provider.
 */
export async function getAdapterForModel(model: string): Promise<ProviderAdapter> {
  await ensureLoaded();
  for (const adapter of loadedAdapters ?? []) {
    if (adapter.detectModel(model)) {
      return adapter;
    }
  }
  throw new ConfigurationError(`No provider adapter matches model '${model}'`, { field: "model" });
}

/**
 * First adapter (in {@link ADAPTER_REGISTRATION_ORDER}) whose `detectClient(client)`
 * returns true. Throws {@link ConfigurationError} on a miss — NEVER silently falls
 * back to any default adapter. Detection is purely structural; performs no I/O.
 */
export async function getAdapterForClient(client: unknown): Promise<ProviderAdapter> {
  await ensureLoaded();
  for (const adapter of loadedAdapters ?? []) {
    if (adapter.detectClient(client)) {
      return adapter;
    }
  }
  throw new ConfigurationError(
    `Could not detect a provider adapter for client type '${describeClientType(client)}': it is not a recognized provider SDK client`,
    { field: "provider" },
  );
}

// ---------------------------------------------------------------------------
// Detection override hooks (test seam for injecting stub adapters).
// ---------------------------------------------------------------------------

/**
 * Replace the active loader table and reset the lazy singleton so the next lookup
 * re-loads from the supplied loaders. Tests inject stub adapters through this hook to
 * exercise ordering, laziness, and detection in isolation from the real provider modules.
 */
export function __setAdapterLoadersForTesting(
  loaders: Partial<Record<ProviderName, AdapterLoader>>,
): void {
  activeLoaders = loaders;
  loadedAdapters = null;
  loadedByName = null;
  loadPromise = null;
  compatAdaptersByName = null;
}

/** Restore the default (production) loader table and reset the lazy singleton. */
export function __resetAdapterRegistry(): void {
  activeLoaders = DEFAULT_LOADERS;
  loadedAdapters = null;
  loadedByName = null;
  loadPromise = null;
  compatAdaptersByName = null;
}

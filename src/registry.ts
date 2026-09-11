/**
 * Runtime chain builder: turns a caller's primary SDK client plus an ordered list of
 * fallback specs into an ordered `[primary, ...fallbacks]` chain of immutable
 * {@link ProviderRuntime} objects the router walks.
 *
 * Ported from `solwyn/_registry.py`. Sans-I/O: it inspects client TYPE (via the
 * adapter registry's structural detection) and plain strings (model names, provider
 * overrides) only — no network, no credentials, no prompt/response content. The one
 * piece of enforcement it owns is provider-pin resolution: an explicit pin bypasses
 * structural detection, selects attribution directly, and validates the pinned SDK family.
 *
 * `buildRuntimes` is `async` because adapter resolution goes through the registry's
 * lazily (dynamically) imported adapters — see `./providers/index`.
 */

import { ConfigurationError } from "./errors";
import { validatePinnedClientFamily } from "./providers/detection";
import { getAdapterByName, getAdapterForClient } from "./providers/index";
import type { ProviderAdapter } from "./providers/protocol";
import type { ProviderEntry, ProviderName } from "./types";

// ---------------------------------------------------------------------------
// Top-level wrapper brand.
// ---------------------------------------------------------------------------

/** Shared identity brand; never inferred from provider-visible properties. */
const WRAPPERS_KEY = Symbol.for("@solwyn/sdk.wrappers");
interface GlobalWithWrappers {
  [WRAPPERS_KEY]?: WeakSet<object>;
}
const wrapperRegistry = globalThis as GlobalWithWrappers;
wrapperRegistry[WRAPPERS_KEY] ??= new WeakSet<object>();
const solwynWrappers = wrapperRegistry[WRAPPERS_KEY];

/** @internal Brand one successfully-created public wrapper proxy. */
export function brandSolwynWrapper(wrapper: object): void {
  solwynWrappers.add(wrapper);
}

/** @internal Truthful identity check shared by `Solwyn[Symbol.hasInstance]` and guards. */
export function isSolwynWrapper(value: unknown): value is object {
  return typeof value === "object" && value !== null && solwynWrappers.has(value);
}

/** @internal Reject wrapper recursion before any adapter lookup or detection. */
export function assertRawProviderClient(client: unknown): void {
  if (isSolwynWrapper(client)) {
    throw new ConfigurationError(
      "client is already wrapped by Solwyn — pass the raw provider client",
      { field: "client" },
    );
  }
}

// ---------------------------------------------------------------------------
// ProviderRuntime.
// ---------------------------------------------------------------------------

/**
 * Immutable value object binding a resolved routing entry, the caller's SDK client
 * (by reference — never copied/cloned, and never a carrier of credentials on the
 * entry), and the detected/overridden adapter. Frozen after construction:
 * post-construction field reassignment throws in strict mode.
 */
export interface ProviderRuntime {
  readonly entry: ProviderEntry;
  readonly sdkClient: unknown;
  readonly adapter: ProviderAdapter;
}

function freezeRuntime(
  entry: ProviderEntry,
  sdkClient: unknown,
  adapter: ProviderAdapter,
): ProviderRuntime {
  return Object.freeze({ entry, sdkClient, adapter });
}

// ---------------------------------------------------------------------------
// buildRuntimes.
// ---------------------------------------------------------------------------

/** Options for {@link buildRuntimes} (keyword-only parity with Python). */
export interface BuildRuntimesOptions {
  /** Explicit provider identity pin for the PRIMARY client only. */
  primaryProvider?: string;
}

/**
 * A caller-supplied fallback spec: a positional array of length 2–4.
 *  - `[client, model]`
 *  - `[client, model, defaultParams]`
 *  - `[client, model, defaultParams, providerOverride]`
 *
 * Typed as `unknown` at the boundary because untyped JS callers construct these
 * directly; {@link parseFallbackSpec} validates the shape and fails loud.
 */
export type FallbackSpec = unknown;

export interface ParsedFallbackSpec {
  client: unknown;
  model: string;
  defaultParams: Record<string, unknown>;
  providerOverride: string | undefined;
}

/** TS-flavored type label for error messages (no Python `dict`/`str`/`tuple` vocab). */
function describeValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

export function parseFallbackSpec(spec: unknown): ParsedFallbackSpec {
  if (!Array.isArray(spec) || spec.length < 2 || spec.length > 4) {
    throw new ConfigurationError(
      "Fallback spec must be a [client, model], [client, model, defaultParams], or " +
        `[client, model, defaultParams, provider] array, got ${describeValueType(spec)}`,
      { field: "fallback_specs" },
    );
  }

  const client = spec[0];
  const model = spec[1];
  if (typeof model !== "string") {
    throw new ConfigurationError(
      `Fallback model must be a string, got ${describeValueType(model)}`,
      {
        field: "fallback_specs",
      },
    );
  }

  let defaultParams: Record<string, unknown> = {};
  if (spec.length >= 3) {
    const raw = spec[2];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigurationError(
        `Fallback default_params must be an object, got ${describeValueType(raw)}`,
        { field: "fallback_specs" },
      );
    }
    defaultParams = raw as Record<string, unknown>;
  }

  let providerOverride: string | undefined;
  if (spec.length >= 4) {
    const raw = spec[3];
    if (typeof raw !== "string") {
      throw new ConfigurationError(
        `Fallback provider must be a string, got ${describeValueType(raw)}`,
        { field: "fallback_specs" },
      );
    }
    providerOverride = raw;
  }

  return { client, model, defaultParams, providerOverride };
}

/**
 * Resolve the adapter that governs a client's attribution `name`.
 *  - No override: pure structural detection via `getAdapterForClient`.
 *  - Override given: resolve the named adapter directly, bypassing detection entirely,
 *    then validate that the client exposes that adapter family's callable surface.
 */
async function resolveAdapter(
  client: unknown,
  override: string | undefined,
): Promise<ProviderAdapter> {
  // Defensive second gate: direct registry callers cannot bypass the synchronous
  // constructor guard, and an override lookup must never run for an already-wrapped client.
  assertRawProviderClient(client);
  if (override === undefined) {
    return getAdapterForClient(client);
  }

  // Named adapter lookup is authoritative for a pin. A miss retains field "provider".
  const named = await getAdapterByName(override);
  validatePinnedClientFamily(client, named.name, named.dialect);
  return named;
}

/**
 * Assemble the ordered `[primary, ...fallbacks]` runtime chain.
 *
 * @param primaryClient Required. The caller's primary SDK client instance (by reference).
 * @param primaryModel Model for the primary entry; `null`/`undefined` becomes `""`
 *   (the per-call model wins for the primary at call time).
 * @param fallbackSpecs Ordered fallback specs (see {@link FallbackSpec}).
 * @param options Optional `primaryProvider` override for the primary client only.
 *
 * The primary entry's `default_params` is ALWAYS `{}` (no way to pass primary-level
 * defaults here). Each fallback's `default_params` is `{}` for the 2-tuple form or
 * exactly the passed object otherwise (no merge, no clone). Every runtime's
 * `entry.provider` is derived from the resolved `adapter.name` — never a raw caller
 * label. Throws {@link ConfigurationError} for any malformed spec or bad override.
 */
export async function buildRuntimes(
  primaryClient: unknown,
  primaryModel: string | null | undefined,
  fallbackSpecs: FallbackSpec[],
  options: BuildRuntimesOptions = {},
): Promise<ProviderRuntime[]> {
  const runtimes: ProviderRuntime[] = [];

  // Primary.
  const primaryAdapter = await resolveAdapter(primaryClient, options.primaryProvider);
  const primaryEntry: ProviderEntry = {
    provider: primaryAdapter.name as ProviderName,
    model: primaryModel ?? "",
    default_params: {},
  };
  runtimes.push(freezeRuntime(primaryEntry, primaryClient, primaryAdapter));

  // Fallbacks, in declared order.
  for (const spec of fallbackSpecs) {
    const { client, model, defaultParams, providerOverride } = parseFallbackSpec(spec);
    const adapter = await resolveAdapter(client, providerOverride);
    const entry: ProviderEntry = {
      provider: adapter.name as ProviderName,
      model,
      default_params: defaultParams,
    };
    runtimes.push(freezeRuntime(entry, client, adapter));
  }

  return runtimes;
}

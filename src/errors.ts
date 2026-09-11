/**
 * The SDK's typed exception hierarchy. `SolwynError` is the sole common base — a
 * single `catch (e) { if (e instanceof SolwynError) ... }` intercepts every SDK
 * exception.
 *
 * Ported from `solwyn/exceptions.py`. Python's keyword-only constructors map to TS
 * options objects (the natural enforcement of "no positional smuggling"). Exceptions
 * NEVER carry prompt/response content — every field is a structural label only.
 *
 * Prototype chains preserve local subclassing. Shared weak construction records
 * preserve family `instanceof` checks across ESM/CJS without trusting public fields.
 */

import { escapeControlChars } from "./logging";
import type { CapabilityScope, EffectiveSurfaceKind, SurfaceClientShape } from "./surfaces";

const ERROR_IDENTITIES_KEY = Symbol.for("@solwyn/sdk.errorIdentities.v1");
interface GlobalErrorIdentities {
  [ERROR_IDENTITIES_KEY]?: WeakMap<object, Set<string>>;
}
const errorFamilies = new WeakMap<object, string>();

function errorIdentities(): WeakMap<object, Set<string>> {
  const shared = globalThis as GlobalErrorIdentities;
  shared[ERROR_IDENTITIES_KEY] ??= new WeakMap();
  return shared[ERROR_IDENTITIES_KEY];
}

/** Construction identity is distinct from translation's private safe-label provenance. */
function brandError(error: object, family: string): void {
  const identities = errorIdentities();
  let families = identities.get(error);
  if (families === undefined) {
    families = new Set();
    identities.set(error, families);
  }
  families.add(family);
}

/** @internal For SDK error families defined beside their subsystem, never public provenance. */
export function registerErrorFamily(
  errorConstructor: object,
  family: string,
): (error: object) => void {
  errorFamilies.set(errorConstructor, family);
  return (error) => brandError(error, family);
}

/** Common base for every SDK exception. */
export class SolwynError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "SolwynError";
    // Restore the local prototype chain, including user subclasses.
    Object.setPrototypeOf(this, new.target.prototype);
    brandError(this, "SolwynError");
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    // biome-ignore lint/complexity/noThisInStatic: inherited instanceof hooks must identify the actual checked constructor.
    const family = errorFamilies.get(this);
    if (family !== undefined) {
      return (
        ((typeof value === "object" && value !== null) || typeof value === "function") &&
        errorIdentities().get(value)?.has(family) === true
      );
    }
    // An inherited hook must retain the narrower identity of a caller's subclass.
    try {
      // biome-ignore lint/complexity/noThisInStatic: retain a user's subclass identity rather than widening to the SDK base.
      return Function.prototype[Symbol.hasInstance].call(this, value) as boolean;
    } catch {
      return false;
    }
  }

  /**
   * Debug representation surfacing the class name and every structural field value
   * (e.g. `BudgetExceededError(projectId="proj_...", budgetLimit=100, ...)`).
   */
  override toString(): string {
    const fields = Object.entries(this)
      .filter(([key]) => key !== "name")
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ");
    return `${this.name}(${fields})`;
  }
}

/** Options for {@link BudgetExceededError}. All fields are required. */
export interface BudgetExceededErrorOptions {
  projectId: string | null;
  budgetLimit: number;
  currentUsage: number;
  estimatedCost: number;
  budgetPeriod: string;
  mode: string;
}

/**
 * Raised when a budget decision denies dispatch. This includes a Cloud hard denial,
 * retained denial authority during an outage, and fail-closed local enforcement when
 * the budget service is unavailable.
 *
 * `budgetPeriod` is populated from the deny response's `denied_by_period` via
 * {@link resolveBudgetPeriod}; it is not replaced with `"unknown"` when the response
 * carries a real period.
 */
export class BudgetExceededError extends SolwynError {
  readonly projectId: string | null;
  readonly budgetLimit: number;
  readonly currentUsage: number;
  readonly estimatedCost: number;
  readonly budgetPeriod: string;
  readonly mode: string;

  constructor(options: BudgetExceededErrorOptions) {
    super(`Budget exceeded for project ${options.projectId ?? "unknown project"}`);
    this.name = "BudgetExceededError";
    brandError(this, "BudgetExceededError");
    this.projectId = options.projectId;
    this.budgetLimit = options.budgetLimit;
    this.currentUsage = options.currentUsage;
    this.estimatedCost = options.estimatedCost;
    this.budgetPeriod = options.budgetPeriod;
    this.mode = options.mode;
  }
}

/** Origin of a run-stopped denial. */
export type RunStoppedSource = "server" | "local_velocity";

/** Options for {@link RunStoppedError}. */
export interface RunStoppedErrorOptions {
  agentRunId: string;
  reason: string;
  source: RunStoppedSource;
}

/** Raised when the active agent run has been stopped by the control plane or local detector. */
export class RunStoppedError extends SolwynError {
  readonly agentRunId: string;
  readonly reason: string;
  readonly source: RunStoppedSource;

  constructor(options: RunStoppedErrorOptions) {
    super(
      `Agent run ${escapeControlChars(options.agentRunId)} was stopped (${options.source}: ${escapeControlChars(options.reason)})`,
    );
    this.name = "RunStoppedError";
    brandError(this, "RunStoppedError");
    this.agentRunId = options.agentRunId;
    this.reason = options.reason;
    this.source = options.source;
  }
}

/**
 * D2 helper: resolve `budgetPeriod` from a deny response's `denied_by_period`.
 * Returns the period string when present, `"unknown"` otherwise.
 *
 * Fixes the Python latent bug that hardcoded `"unknown"` even when the deny
 * response carried a real `denied_by_period`. The budget subsystem calls this when
 * constructing a {@link BudgetExceededError}.
 */
export function resolveBudgetPeriod(deniedByPeriod: string | null | undefined): string {
  return deniedByPeriod ?? "unknown";
}

/** Options for {@link ProviderUnavailableError}. All independently optional. */
export interface ProviderUnavailableErrorOptions {
  provider?: string | null;
  circuitState?: string | null;
  attempted?: string[] | null;
}

/**
 * Raised when no provider could serve a request (circuit open, all attempts
 * exhausted, etc.). Supports three independent construction shapes: legacy
 * `provider`/`circuitState`, new `attempted` dispatch chain, or message-only.
 */
export class ProviderUnavailableError extends SolwynError {
  readonly provider: string | null;
  readonly circuitState: string | null;
  readonly attempted: string[] | null;

  constructor(message: string, options: ProviderUnavailableErrorOptions = {}) {
    super(message);
    this.name = "ProviderUnavailableError";
    brandError(this, "ProviderUnavailableError");
    this.provider = options.provider ?? null;
    this.circuitState = options.circuitState ?? null;
    this.attempted = options.attempted ?? null;
  }
}

/** Options for {@link ConfigurationError}. */
export interface ConfigurationErrorOptions {
  field?: string | null;
}

/** Raised on invalid SDK configuration (bad credentials, missing options, etc.). */
export class ConfigurationError extends SolwynError {
  readonly field: string | null;

  constructor(message: string, options: ConfigurationErrorOptions = {}) {
    super(message);
    this.name = "ConfigurationError";
    brandError(this, "ConfigurationError");
    this.field = options.field ?? null;
  }
}

/** Options for {@link UnsupportedSurfaceError}. */
export interface UnsupportedSurfaceErrorOptions {
  surface: string;
  provider: string;
}

/** Raised when an adapter cannot safely dispatch a tracked non-chat surface. */
export class UnsupportedSurfaceError extends SolwynError {
  readonly surface: string;
  readonly provider: string;

  constructor(options: UnsupportedSurfaceErrorOptions) {
    super(`provider ${options.provider} does not support the ${options.surface} surface`);
    this.name = "UnsupportedSurfaceError";
    brandError(this, "UnsupportedSurfaceError");
    this.surface = options.surface;
    this.provider = options.provider;
  }
}

/** Options for a fail-closed untracked-spend posture decision. */
export interface UntrackedSpendSurfaceErrorOptions {
  surface: string;
  token: string | null;
  provider: string;
  clientShape: SurfaceClientShape;
  kind: EffectiveSurfaceKind;
  capabilityScope: CapabilityScope | null;
  driftedFromRuleId: string | null;
}

/**
 * Raised before an unknown or explicitly unmetered spend surface is evaluated when
 * `on_unmetered` is configured as `raise`. Every field is a content-free label.
 */
export class UntrackedSpendSurfaceError extends SolwynError {
  readonly surface: string;
  readonly token: string | null;
  readonly provider: string;
  readonly clientShape: SurfaceClientShape;
  readonly kind: EffectiveSurfaceKind;
  readonly capabilityScope: CapabilityScope | null;
  readonly driftedFromRuleId: string | null;

  constructor(options: UntrackedSpendSurfaceErrorOptions) {
    const guidance =
      options.kind === "unmetered_spend" && options.token !== null
        ? `acknowledge exact token '${options.token}' in acknowledge_untracked`
        : "review the provider graph and acknowledge an exact terminal capability token";
    super(
      `Untracked spend surface (surface='${options.surface}', provider='${options.provider}', ` +
        `clientShape='${options.clientShape}', kind='${options.kind}', ` +
        `capabilityScope='${options.capabilityScope ?? "none"}', ` +
        `driftedFromRuleId='${options.driftedFromRuleId ?? "none"}'); ${guidance}; ` +
        "choose on_unmetered='warn' or on_unmetered='allow' to permit untracked execution",
    );
    this.name = "UntrackedSpendSurfaceError";
    brandError(this, "UntrackedSpendSurfaceError");
    this.surface = options.surface;
    this.token = options.token;
    this.provider = options.provider;
    this.clientShape = options.clientShape;
    this.kind = options.kind;
    this.capabilityScope = options.capabilityScope;
    this.driftedFromRuleId = options.driftedFromRuleId;
  }
}

/** Options for {@link CoverageMismatchError}. */
export interface CoverageMismatchErrorOptions {
  readonly differences: readonly string[];
}

function snapshotCoverageDifferences(value: unknown): readonly string[] | null {
  try {
    if (!Array.isArray(value)) {
      return null;
    }
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
      return null;
    }
    const length = lengthDescriptor.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length <= 0) {
      return null;
    }

    const snapshot: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        return null;
      }
      const difference = descriptor.value;
      if (typeof difference !== "string" || difference.trim().length === 0) {
        return null;
      }
      snapshot.push(difference);
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

/** Raised when a registered client's local coverage differs from a literal pin. */
export class CoverageMismatchError extends SolwynError {
  readonly differences: readonly string[];

  constructor(options: CoverageMismatchErrorOptions) {
    let candidate: unknown;
    if (typeof options === "object" && options !== null) {
      try {
        const descriptor = Reflect.getOwnPropertyDescriptor(options, "differences");
        candidate =
          descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      } catch {
        candidate = undefined;
      }
    }
    const differences = snapshotCoverageDifferences(candidate);
    if (differences === null) {
      throw new TypeError("coverage mismatch requires at least one difference");
    }
    super(`coverage expectation mismatch: ${differences.join("; ")}`);
    this.name = "CoverageMismatchError";
    brandError(this, "CoverageMismatchError");
    this.differences = differences;
  }
}

/**
 * Options for {@link UntranslatableRequestError}. Exactly these three keys — the
 * exact type admits no extra property, so a `value`/`content` key that could smuggle
 * prompt text is a compile-time error (the core anti-content-leak guarantee).
 */
export interface UntranslatableRequestErrorOptions {
  source: string;
  target: string;
  feature: string;
}

/**
 * Raised when a cross-dialect failover hop hits a request feature that cannot be
 * translated. Keyword-only (single options object) — no positional-args shape and
 * no field capable of holding content.
 */
export class UntranslatableRequestError extends SolwynError {
  readonly source: string;
  readonly target: string;
  readonly feature: string;

  constructor(options: UntranslatableRequestErrorOptions) {
    super(`cannot translate ${options.feature} from ${options.source} to ${options.target}`);
    this.name = "UntranslatableRequestError";
    brandError(this, "UntranslatableRequestError");
    this.source = options.source;
    this.target = options.target;
    this.feature = options.feature;
  }
}

/** Options for {@link UntranslatableModelError}. */
export interface UntranslatableModelErrorOptions {
  model: string;
  provider: string;
}

/**
 * Raised when a model is not configured for the target provider during a
 * cross-dialect hop. Keyword-only; both fields are configuration labels (safe to
 * surface — model ids are not content).
 */
export class UntranslatableModelError extends SolwynError {
  readonly model: string;
  readonly provider: string;

  constructor(options: UntranslatableModelErrorOptions) {
    super(`model ${options.model} is not configured for provider ${options.provider}`);
    this.name = "UntranslatableModelError";
    brandError(this, "UntranslatableModelError");
    this.model = options.model;
    this.provider = options.provider;
  }
}

// Only these exact SDK constructors opt into the process-wide family checks.
for (const [errorConstructor, family] of [
  [SolwynError, "SolwynError"],
  [BudgetExceededError, "BudgetExceededError"],
  [RunStoppedError, "RunStoppedError"],
  [ProviderUnavailableError, "ProviderUnavailableError"],
  [ConfigurationError, "ConfigurationError"],
  [UnsupportedSurfaceError, "UnsupportedSurfaceError"],
  [UntrackedSpendSurfaceError, "UntrackedSpendSurfaceError"],
  [CoverageMismatchError, "CoverageMismatchError"],
  [UntranslatableRequestError, "UntranslatableRequestError"],
  [UntranslatableModelError, "UntranslatableModelError"],
] as const) {
  errorFamilies.set(errorConstructor, family);
}

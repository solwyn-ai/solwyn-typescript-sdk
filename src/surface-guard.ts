import { SolwynError, UntrackedSpendSurfaceError } from "./errors";
import { observeEvaluatedProperty } from "./surface-graph";
import {
  type CapabilityScope,
  type EffectiveSurfaceKind,
  isSurfacePathWireEligible,
  SURFACE_CLIENT_SHAPES,
  type SurfaceClientShape,
  type SurfaceContext,
  type SurfaceRule,
  type SurfaceShapeObservation,
  validateSurfacePath,
} from "./surfaces";

export const UNMETERED_POSTURES = ["warn", "raise", "allow"] as const;
export type UnmeteredPosture = (typeof UNMETERED_POSTURES)[number];

export interface EffectiveSurfaceDecision {
  readonly surface: string;
  readonly kind: EffectiveSurfaceKind;
  readonly acknowledgmentToken: string;
  readonly capabilityScope: CapabilityScope | null;
  readonly observedReturnShape: SurfaceShapeObservation["returnShape"];
  readonly driftedFromRuleId: string | null;
  readonly rule: SurfaceRule | null;
}

/** Resolve a shape-aware authored decision or a local `unknown` fallback. */
export function effectiveSurfaceDecision(
  observation: SurfaceShapeObservation,
  rule?: SurfaceRule,
): EffectiveSurfaceDecision {
  const surface = validateSurfacePath(observation.path);
  if (rule?.acceptsShape(observation) === true) {
    return Object.freeze({
      surface,
      kind: rule.kind,
      acknowledgmentToken: rule.acknowledgmentToken ?? surface,
      capabilityScope: rule.capabilityScope,
      observedReturnShape: observation.returnShape,
      driftedFromRuleId: null,
      rule,
    });
  }
  return Object.freeze({
    surface,
    kind: "unknown",
    acknowledgmentToken: surface,
    capabilityScope: null,
    observedReturnShape: observation.returnShape,
    driftedFromRuleId: rule?.ruleId ?? null,
    rule: null,
  });
}

export interface SurfaceObservationEntry {
  readonly provider: string;
  readonly clientShape: SurfaceClientShape;
  readonly surface: string;
  readonly kind: EffectiveSurfaceKind;
  readonly capabilityScope: CapabilityScope | null;
  readonly driftedFromRuleId: string | null;
  readonly count: number;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
}

export interface RecordSurfaceObservationOptions {
  readonly provider: string;
  readonly clientShape: SurfaceClientShape;
  readonly decision: EffectiveSurfaceDecision;
  readonly observedAt: number;
}

interface MutableObservationEntry {
  provider: string;
  clientShape: SurfaceClientShape;
  surface: string;
  kind: EffectiveSurfaceKind;
  capabilityScope: CapabilityScope | null;
  driftedFromRuleId: string | null;
  count: number;
  firstObservedAt: number;
  lastObservedAt: number;
}

export const MAX_SURFACE_OBSERVATION_KEYS = 512;
const SURFACE_OBSERVATION_LIMIT_WARNING =
  "Untracked-surface warning limit (%d) reached; further distinct surfaces will not be individually reported this process.";
const WIRE_INELIGIBLE_SURFACE_WARNING =
  "Provider '%s' client shape '%s' exposes an untracked public surface outside advisory reporting limits; no budget check and no cost event will be emitted, and no advisory report will be sent.";
const UNTRACKED_SURFACE_WARNING =
  "Provider '%s' client shape '%s' exposes untracked surface '%s' (scope: %s); no budget check and no cost event will be emitted. Tracking for this surface is coming.";
const ACKNOWLEDGED_DESCENDANT_GUARD_ERROR = "acknowledged descendant requires a namespace guard";
const SYMBOL_SURFACE_ERROR = "symbol-keyed provider surfaces are not supported";
const FIXED_SURFACE_RESULT_ERROR = "guarded result cannot replace a fixed provider property";

function validateProvider(provider: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(provider)) {
    throw new SolwynError("invalid surface provider label");
  }
}

function validateClientShape(clientShape: SurfaceClientShape): void {
  if (!SURFACE_CLIENT_SHAPES.includes(clientShape)) {
    throw new SolwynError("invalid surface client shape");
  }
}

function observationKey(
  provider: string,
  clientShape: SurfaceClientShape,
  surface: string,
): string {
  return JSON.stringify([provider, clientShape, surface]);
}

function frozenEntry(entry: MutableObservationEntry): SurfaceObservationEntry {
  return Object.freeze({ ...entry });
}

/** Insertion-ordered, content-free observation counts with a hard key bound. */
export class SurfaceObservationRegistry {
  readonly #maxKeys: number;
  readonly #entries = new Map<string, MutableObservationEntry>();
  #overflowed = false;
  #overflowWarningClaimed = false;

  constructor(maxKeys = MAX_SURFACE_OBSERVATION_KEYS) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > MAX_SURFACE_OBSERVATION_KEYS) {
      throw new SolwynError("invalid surface observation registry bound");
    }
    this.#maxKeys = maxKeys;
  }

  get size(): number {
    return this.#entries.size;
  }

  get maxKeys(): number {
    return this.#maxKeys;
  }

  record(options: RecordSurfaceObservationOptions): SurfaceObservationEntry | undefined {
    validateProvider(options.provider);
    validateClientShape(options.clientShape);
    const surface = validateSurfacePath(options.decision.surface);
    if (!Number.isFinite(options.observedAt)) {
      throw new SolwynError("invalid surface observation timestamp");
    }
    const key = observationKey(options.provider, options.clientShape, surface);
    const current = this.#entries.get(key);
    if (current !== undefined) {
      current.kind = options.decision.kind;
      current.capabilityScope = options.decision.capabilityScope;
      current.driftedFromRuleId = options.decision.driftedFromRuleId;
      current.count = Math.min(Number.MAX_SAFE_INTEGER, current.count + 1);
      current.firstObservedAt = Math.min(current.firstObservedAt, options.observedAt);
      current.lastObservedAt = Math.max(current.lastObservedAt, options.observedAt);
      return frozenEntry(current);
    }

    if (this.#entries.size >= this.#maxKeys) {
      this.#overflowed = true;
      return undefined;
    }
    const created: MutableObservationEntry = {
      provider: options.provider,
      clientShape: options.clientShape,
      surface,
      kind: options.decision.kind,
      capabilityScope: options.decision.capabilityScope,
      driftedFromRuleId: options.decision.driftedFromRuleId,
      count: 1,
      firstObservedAt: options.observedAt,
      lastObservedAt: options.observedAt,
    };
    this.#entries.set(key, created);
    return frozenEntry(created);
  }

  get(
    provider: string,
    clientShape: SurfaceClientShape,
    surface: string,
  ): SurfaceObservationEntry | undefined {
    const entry = this.#entries.get(observationKey(provider, clientShape, surface));
    return entry === undefined ? undefined : frozenEntry(entry);
  }

  snapshot(): readonly SurfaceObservationEntry[] {
    return Object.freeze([...this.#entries.values()].map(frozenEntry));
  }

  /** Claim the process-style generic overflow diagnostic at most once per registry. */
  claimOverflowWarning(): boolean {
    if (!this.#overflowed || this.#overflowWarningClaimed) {
      return false;
    }
    this.#overflowWarningClaimed = true;
    return true;
  }
}

/** Exact warn-once latch for `(provider, clientShape, surface)`. */
export class SurfaceWarnOnceLatch {
  readonly #warned = new Set<string>();

  shouldWarn(provider: string, clientShape: SurfaceClientShape, surface: string): boolean {
    validateProvider(provider);
    validateClientShape(clientShape);
    const key = observationKey(provider, clientShape, validateSurfacePath(surface));
    if (this.#warned.has(key)) {
      return false;
    }
    this.#warned.add(key);
    return true;
  }
}

export interface SurfacePostureLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface ApplySurfacePostureOptions<T> {
  readonly posture: UnmeteredPosture;
  readonly decision: EffectiveSurfaceDecision;
  readonly provider: string;
  readonly clientShape: SurfaceClientShape;
  readonly acknowledgments?: readonly string[] | ReadonlySet<string>;
  readonly registry: SurfaceObservationRegistry;
  readonly warningLatch: SurfaceWarnOnceLatch;
  readonly report?: (entry: SurfaceObservationEntry) => void;
  readonly logger?: SurfacePostureLogger;
  readonly observedAt?: () => number;
  readonly guardAcknowledgedDescendant?: (value: T) => T;
  readonly execute: () => T;
}

function acknowledgmentMatch(
  acknowledgments: readonly string[] | ReadonlySet<string> | undefined,
  exactToken: string,
  surface: string,
): "exact" | "descendant" | null {
  if (acknowledgments === undefined) {
    return null;
  }
  let descendant = false;
  for (const candidate of acknowledgments) {
    if (candidate === exactToken) {
      return "exact";
    }
    if (candidate.startsWith(`${surface}.`)) {
      descendant = true;
    }
  }
  return descendant ? "descendant" : null;
}

/**
 * Apply the configured unmetered posture before a getter/operation callback executes.
 * Non-untracked decisions pass through without observation side effects.
 */
export function applySurfacePosture<T>(options: ApplySurfacePostureOptions<T>): T {
  const surface = validateSurfacePath(options.decision.surface);
  validateProvider(options.provider);
  validateClientShape(options.clientShape);
  const requiresPosture =
    options.decision.kind === "unknown" || options.decision.kind === "unmetered_spend";
  if (!requiresPosture) {
    return options.execute();
  }

  const acknowledgment =
    options.decision.driftedFromRuleId === null
      ? acknowledgmentMatch(options.acknowledgments, options.decision.acknowledgmentToken, surface)
      : null;
  const guardable =
    options.decision.observedReturnShape === "resource" ||
    options.decision.observedReturnShape === "mapping";
  const executeGuarded = (): T => {
    if (!guardable) return options.execute();
    if (options.guardAcknowledgedDescendant === undefined) {
      throw new SolwynError(ACKNOWLEDGED_DESCENDANT_GUARD_ERROR);
    }
    return options.guardAcknowledgedDescendant(options.execute());
  };
  const exactRawResponse =
    acknowledgment === "exact" &&
    options.decision.kind === "unmetered_spend" &&
    options.decision.capabilityScope === "raw_response" &&
    options.decision.rule !== null;
  if (exactRawResponse) {
    return options.execute();
  }
  if (acknowledgment === "descendant") {
    // A descendant token permits traversal only. Recheck the evaluated value because
    // a getter or Proxy can return a different shape from its static descriptor.
    if (options.guardAcknowledgedDescendant === undefined) {
      throw new SolwynError(ACKNOWLEDGED_DESCENDANT_GUARD_ERROR);
    }
    const value = options.execute();
    const actual = observeEvaluatedProperty(surface, "field", value).returnShape;
    if (actual !== "resource" && actual !== "mapping") {
      throw new SolwynError("acknowledged descendant has unguardable prefix");
    }
    return options.guardAcknowledgedDescendant(value);
  }
  if (acknowledgment !== null) {
    return executeGuarded();
  }
  if (options.posture === "raise") {
    throw new UntrackedSpendSurfaceError({
      surface,
      token: options.decision.acknowledgmentToken,
      provider: options.provider,
      clientShape: options.clientShape,
      kind: options.decision.kind,
      capabilityScope: options.decision.capabilityScope,
      driftedFromRuleId: options.decision.driftedFromRuleId,
    });
  }

  const observedAt = (options.observedAt ?? Date.now)();
  const entry = options.registry.record({
    provider: options.provider,
    clientShape: options.clientShape,
    decision: options.decision,
    observedAt,
  });
  const wireEligible = isSurfacePathWireEligible(surface);
  if (wireEligible) {
    try {
      // Origin reporters own their bounds; global saturation only limits local warnings.
      options.report?.(
        entry ??
          Object.freeze({
            provider: options.provider,
            clientShape: options.clientShape,
            surface,
            kind: options.decision.kind,
            capabilityScope: options.decision.capabilityScope,
            driftedFromRuleId: options.decision.driftedFromRuleId,
            count: 1,
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
          }),
      );
    } catch {
      // Advisory reporting must never replace the provider operation's behavior.
    }
  }
  if (entry === undefined) {
    if (options.posture === "warn" && options.registry.claimOverflowWarning()) {
      try {
        options.logger?.warn(SURFACE_OBSERVATION_LIMIT_WARNING, options.registry.maxKeys);
      } catch {
        // A diagnostic logger is never allowed to change provider behavior.
      }
    }
    return executeGuarded();
  }
  if (
    options.posture === "warn" &&
    options.warningLatch.shouldWarn(options.provider, options.clientShape, surface)
  ) {
    try {
      if (wireEligible) {
        options.logger?.warn(
          options.decision.driftedFromRuleId === null
            ? UNTRACKED_SURFACE_WARNING
            : `${UNTRACKED_SURFACE_WARNING} Reviewed rule ${options.decision.driftedFromRuleId} no longer matches its shape.`,
          options.provider,
          options.clientShape,
          surface,
          options.decision.capabilityScope,
        );
      } else {
        options.logger?.warn(
          WIRE_INELIGIBLE_SURFACE_WARNING,
          options.provider,
          options.clientShape,
        );
      }
    } catch {
      // A diagnostic logger is never allowed to change provider behavior.
    }
  }
  return executeGuarded();
}

export type SurfaceReadGuard = (surface: string, execute: () => unknown) => unknown;

function contextKey(path: string, context: SurfaceContext): string {
  return JSON.stringify([path, context.provider, context.dialect, context.clientShape]);
}

/** Weak target cache for identity-stable fake/unit namespace guards. */
export class SurfaceNamespaceGuardCache {
  readonly #targets = new WeakMap<object, Map<string, object>>();

  getOrCreate<T extends object>(
    target: T,
    path: string,
    context: SurfaceContext,
    guardRead: SurfaceReadGuard,
  ): T {
    const validatedPath = validateSurfacePath(path);
    validateClientShape(context.clientShape);
    if (context.provider !== null) {
      validateProvider(context.provider);
    }
    let byContext = this.#targets.get(target);
    if (byContext === undefined) {
      byContext = new Map();
      this.#targets.set(target, byContext);
    }
    const key = contextKey(validatedPath, context);
    const cached = byContext.get(key);
    if (cached !== undefined) {
      return cached as T;
    }

    const boundMethods = new Map<
      PropertyKey,
      {
        readonly raw: (...args: unknown[]) => unknown;
        readonly bound: (...args: unknown[]) => unknown;
      }
    >();
    const guarded = new Proxy(target, {
      get(current, property): unknown {
        if (typeof property !== "string") {
          throw new SolwynError(SYMBOL_SURFACE_ERROR);
        }
        // JavaScript tooling and assertion libraries read `constructor` for identity and
        // formatting. It is intrinsic metadata, never a provider operation or spend surface.
        if (property === "constructor") {
          return Reflect.get(current, property, current);
        }
        const surface = validateSurfacePath(`${validatedPath}.${property}`);
        let fixedResult: { readonly value: unknown } | undefined;
        const result = guardRead(surface, () => {
          const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
          if (descriptor?.configurable === false) {
            if ("value" in descriptor && descriptor.writable === false) {
              fixedResult = { value: descriptor.value };
              return descriptor.value;
            }
            if (!("value" in descriptor) && descriptor.get === undefined) {
              fixedResult = { value: undefined };
              return undefined;
            }
          }
          return Reflect.get(current, property, current);
        });
        if (fixedResult !== undefined && !Object.is(result, fixedResult.value)) {
          throw new SolwynError(FIXED_SURFACE_RESULT_ERROR);
        }
        if (
          fixedResult === undefined &&
          typeof result === "function" &&
          observeEvaluatedProperty(surface, "field", result).returnShape === "function"
        ) {
          const raw = result as (...args: unknown[]) => unknown;
          const cachedMethod = boundMethods.get(property);
          if (cachedMethod?.raw === raw) {
            return cachedMethod.bound;
          }
          const bound = raw.bind(current);
          boundMethods.set(property, { raw, bound });
          return bound;
        }
        return result;
      },
      getOwnPropertyDescriptor(current, property): PropertyDescriptor | undefined {
        if (typeof property !== "string") {
          throw new SolwynError(SYMBOL_SURFACE_ERROR);
        }
        if (property === "constructor") {
          return Reflect.getOwnPropertyDescriptor(current, property);
        }
        validateSurfacePath(`${validatedPath}.${property}`);
        const descriptor = Reflect.getOwnPropertyDescriptor(current, property);
        if (descriptor === undefined) return undefined;
        if ("value" in descriptor) {
          return { ...descriptor, value: Reflect.get(guarded, property) };
        }
        if (descriptor.get === undefined && descriptor.set === undefined) return descriptor;
        if (descriptor.configurable === false) {
          // Proxy invariants forbid replacing a fixed getter or setter with its wrapper.
          throw new SolwynError(FIXED_SURFACE_RESULT_ERROR);
        }
        const setter = descriptor.set;
        return {
          ...descriptor,
          get: descriptor.get === undefined ? undefined : () => Reflect.get(guarded, property),
          set:
            setter === undefined
              ? undefined
              : (value: unknown): unknown => {
                  const result = Reflect.apply(setter, current, [value]);
                  boundMethods.delete(property);
                  return result;
                },
        };
      },
      set(current, property, value): boolean {
        const updated = Reflect.set(current, property, value, current);
        if (updated) {
          boundMethods.delete(property);
        }
        return updated;
      },
      deleteProperty(current, property): boolean {
        const deleted = Reflect.deleteProperty(current, property);
        if (deleted) {
          boundMethods.delete(property);
        }
        return deleted;
      },
      defineProperty(current, property, descriptor): boolean {
        const defined = Reflect.defineProperty(current, property, descriptor);
        if (defined) {
          boundMethods.delete(property);
        }
        return defined;
      },
    });
    byContext.set(key, guarded);
    return guarded;
  }
}

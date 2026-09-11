import { CoverageMismatchError } from "./errors";
import {
  MAX_SURFACE_INSPECTION_DEPTH,
  observePublicSurface,
  type SurfaceObservation,
} from "./surface-graph";
import { UNMETERED_POSTURES, type UnmeteredPosture } from "./surface-guard";
import {
  CAPABILITY_SCOPES,
  type CapabilityScope,
  contextIsDeclared,
  DESCRIPTOR_CATEGORIES,
  type DescriptorCategory,
  EFFECTIVE_SURFACE_KINDS,
  type EffectiveSurfaceKind,
  RETURN_SHAPES,
  type ReturnShape,
  resolveSurfaceRule,
  SURFACE_CLIENT_SHAPES,
  SURFACE_CONDITIONS,
  SURFACE_RULES,
  SURFACE_SOURCES,
  type SurfaceClientShape,
  type SurfaceCondition,
  type SurfaceContext,
  type SurfaceDialect,
  type SurfaceRule,
  type SurfaceSource,
  USAGE_BASES,
  type UsageBasis,
} from "./surfaces";

export const COVERAGE_CATEGORIES = Object.freeze([
  "conditional",
  "guarded_namespaces",
  "tracked",
  "unknown",
  "blocked",
  "unsupported",
  "safe",
  "scoped_escapes",
  "untracked",
] as const);

export type CoverageCategory = (typeof COVERAGE_CATEGORIES)[number];

export interface CoverageRuntime {
  readonly provider: string;
  readonly dialect: SurfaceDialect;
  readonly clientShape: SurfaceClientShape;
  readonly model: string;
}

export type CoveragePolicyAction =
  | "pass"
  | "track"
  | "block"
  | "unsupported"
  | "warn"
  | "raise"
  | "allow"
  | "acknowledged";

export type CoverageDispatchAction = "guard" | "intercept" | "refuse" | "return";

export interface CoverageEntry {
  readonly ruleId: string;
  readonly surface: string;
  readonly token: string;
  readonly kind: EffectiveSurfaceKind;
  readonly policyAction: CoveragePolicyAction;
  readonly dispatchAction: CoverageDispatchAction;
  readonly usageBasis: UsageBasis | null;
  readonly source: SurfaceSource;
  readonly capabilityScope: CapabilityScope | null;
  readonly condition: SurfaceCondition | null;
  readonly reason: string | null;
  readonly expectedDescriptorCategory: DescriptorCategory | null;
  readonly observedDescriptorCategory: DescriptorCategory;
  readonly expectedReturnShape: ReturnShape | null;
  readonly observedReturnShape: ReturnShape;
}

export interface CoverageAuditEntry extends CoverageEntry {}

export interface CoverageExpectation {
  readonly conditional: readonly CoverageAuditEntry[];
  readonly guarded_namespaces: readonly CoverageAuditEntry[];
  readonly tracked: readonly CoverageAuditEntry[];
  readonly unknown: readonly CoverageAuditEntry[];
  readonly blocked: readonly CoverageAuditEntry[];
  readonly unsupported: readonly CoverageAuditEntry[];
  readonly safe: readonly CoverageAuditEntry[];
  readonly scoped_escapes: readonly CoverageAuditEntry[];
  readonly untracked: readonly CoverageAuditEntry[];
}

export interface CoverageFingerprint {
  readonly conditional: `sha256:${string}`;
  readonly guarded_namespaces: `sha256:${string}`;
  readonly tracked: `sha256:${string}`;
  readonly unknown: `sha256:${string}`;
  readonly blocked: `sha256:${string}`;
  readonly unsupported: `sha256:${string}`;
  readonly safe: `sha256:${string}`;
  readonly scoped_escapes: `sha256:${string}`;
  readonly untracked: `sha256:${string}`;
}

export interface CoverageSource {
  readonly rawClient: object;
  readonly context: SurfaceContext;
  readonly providerChain: readonly CoverageRuntime[];
  readonly posture: UnmeteredPosture;
  readonly acknowledgments: readonly string[];
}

interface FrozenCoverageSource {
  readonly rawClient: object;
  readonly context: SurfaceContext;
  readonly providerChain: readonly CoverageRuntime[];
  readonly posture: UnmeteredPosture;
  readonly acknowledgments: readonly string[];
}

interface CoverageRegistration {
  readonly source: FrozenCoverageSource;
  readonly refresh: (() => CoverageSource) | null;
}

const coverageSources = new WeakMap<object, CoverageRegistration>();
const PROVIDER_LABEL_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;
const ROUTED_CHAT_SURFACES = new Set([
  "chat.completions.create",
  "messages.create",
  "models.generateContent",
  "models.generateContentStream",
  "generateContent",
  "ConverseCommand",
  "ConverseStreamCommand",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isClientShape(value: unknown): value is SurfaceClientShape {
  return SURFACE_CLIENT_SHAPES.includes(value as SurfaceClientShape);
}

function isDialect(value: unknown): value is SurfaceDialect {
  return value === "openai" || value === "anthropic" || value === "google" || value === "bedrock";
}

function isPosture(value: unknown): value is UnmeteredPosture {
  return UNMETERED_POSTURES.includes(value as UnmeteredPosture);
}

function invalidCoverageSource(): never {
  throw new TypeError("invalid coverage source");
}

function freezeRuntime(runtime: CoverageRuntime): CoverageRuntime {
  if (
    typeof runtime.provider !== "string" ||
    !PROVIDER_LABEL_PATTERN.test(runtime.provider) ||
    !isDialect(runtime.dialect) ||
    !isClientShape(runtime.clientShape) ||
    typeof runtime.model !== "string"
  ) {
    invalidCoverageSource();
  }
  const frozen = Object.freeze({
    provider: runtime.provider,
    dialect: runtime.dialect,
    clientShape: runtime.clientShape,
    model: runtime.model,
  });
  if (frozen.clientShape !== "undeclared_sdk" && !contextIsDeclared(frozen)) {
    invalidCoverageSource();
  }
  return frozen;
}

function freezeCoverageSource(source: CoverageSource): FrozenCoverageSource {
  if (
    !isObjectLike(source) ||
    !isObjectLike(source.rawClient) ||
    !isObjectLike(source.context) ||
    !Array.isArray(source.providerChain) ||
    source.providerChain.length === 0 ||
    !Array.isArray(source.acknowledgments) ||
    !isPosture(source.posture)
  ) {
    invalidCoverageSource();
  }
  const providerChain = Object.freeze(source.providerChain.map(freezeRuntime));
  const primary = providerChain[0];
  if (primary === undefined) {
    invalidCoverageSource();
  }
  const inputContext = source.context;
  if (
    (inputContext.provider !== null &&
      (typeof inputContext.provider !== "string" ||
        !PROVIDER_LABEL_PATTERN.test(inputContext.provider))) ||
    !isDialect(inputContext.dialect) ||
    !isClientShape(inputContext.clientShape)
  ) {
    invalidCoverageSource();
  }
  const context = Object.freeze({
    provider: inputContext.provider ?? primary.provider,
    dialect: inputContext.dialect,
    clientShape: inputContext.clientShape,
  });
  if (
    primary.provider !== context.provider ||
    primary.dialect !== context.dialect ||
    primary.clientShape !== context.clientShape
  ) {
    invalidCoverageSource();
  }
  if (source.acknowledgments.some((token) => typeof token !== "string" || token.length === 0)) {
    invalidCoverageSource();
  }
  const acknowledgments = Object.freeze([...new Set(source.acknowledgments)].sort(compareText));
  return Object.freeze({
    rawClient: source.rawClient,
    context,
    providerChain,
    posture: source.posture,
    acknowledgments,
  });
}

/** Register detached structural inputs plus an optional lazy lifecycle refresh. */
export function registerCoverageSource(
  wrapper: object,
  source: CoverageSource,
  refresh?: () => CoverageSource,
): void {
  if (!isObjectLike(wrapper) || (refresh !== undefined && typeof refresh !== "function")) {
    invalidCoverageSource();
  }
  coverageSources.set(
    wrapper,
    Object.freeze({
      source: freezeCoverageSource(source),
      refresh: refresh ?? null,
    }),
  );
}

function sourceForResolution(source: SurfaceSource): "raw" | "wrapper" | "synthetic_policy" {
  if (source === "wrapper") return "wrapper";
  if (source === "synthetic_policy") return "synthetic_policy";
  return "raw";
}

function ruleApplies(rule: SurfaceRule, context: SurfaceContext): boolean {
  const source = sourceForResolution(rule.source);
  return (
    resolveSurfaceRule({
      context,
      path: rule.surface,
      source,
      condition: rule.condition ?? undefined,
    })?.ruleId === rule.ruleId
  );
}

function namespacePaths(context: SurfaceContext): readonly string[] {
  const paths = new Set<string>();
  for (const rule of SURFACE_RULES) {
    if (
      rule.kind === "namespace" &&
      (rule.source === "raw" || rule.source === "both") &&
      ruleApplies(rule, context)
    ) {
      paths.add(rule.surface);
    }
  }
  return Object.freeze([...paths].sort(compareText));
}

function isGuardable(returnShape: ReturnShape): boolean {
  return returnShape === "resource" || returnShape === "mapping";
}

function effectiveActions(
  kind: EffectiveSurfaceKind,
  token: string,
  returnShape: ReturnShape,
  capabilityScope: CapabilityScope | null,
  posture: UnmeteredPosture,
  acknowledgments: readonly string[],
  honorAcknowledgment: boolean,
): readonly [CoveragePolicyAction, CoverageDispatchAction] {
  switch (kind) {
    case "namespace":
      return ["pass", "guard"];
    case "metered":
      return ["track", "intercept"];
    case "blocked":
      return ["block", "refuse"];
    case "unsupported":
      return ["unsupported", "refuse"];
    case "metadata":
    case "infrastructure":
      return ["pass", "return"];
    case "unmetered_spend":
    case "unknown": {
      const exact = honorAcknowledgment && acknowledgments.includes(token);
      const descendant =
        honorAcknowledgment &&
        acknowledgments.some((candidate) => candidate.startsWith(`${token}.`));
      if (exact && capabilityScope === "raw_response") return ["acknowledged", "return"];
      if (exact) return ["acknowledged", isGuardable(returnShape) ? "guard" : "return"];
      if (descendant) {
        // An accessor must cross the runtime guard once evaluated; a known terminal
        // value cannot borrow authorization from a token below it.
        return [
          "acknowledged",
          isGuardable(returnShape) || returnShape === "unevaluated_accessor" ? "guard" : "refuse",
        ];
      }
      if (posture === "raise") return ["raise", "refuse"];
      return [posture, isGuardable(returnShape) ? "guard" : "return"];
    }
  }
}

function effectiveUsageBasis(rule: SurfaceRule, source: FrozenCoverageSource): UsageBasis | null {
  if (!ROUTED_CHAT_SURFACES.has(rule.surface) || rule.usageBasis === null) {
    return rule.usageBasis;
  }
  for (const runtime of source.providerChain) {
    if (runtime.clientShape === "undeclared_sdk") {
      return "provider_or_estimate";
    }
    const reachable = resolveSurfaceRule({
      context: {
        provider: runtime.provider,
        dialect: runtime.dialect,
        clientShape: runtime.clientShape,
      },
      path: "chat.completions.create",
      source: "raw",
      condition: rule.condition ?? undefined,
    });
    if (reachable?.usageBasis === "provider_or_estimate") {
      return "provider_or_estimate";
    }
  }
  return rule.usageBasis;
}

function freezeEntry(entry: CoverageEntry): CoverageEntry {
  return Object.freeze({ ...entry });
}

function knownEntry(
  rule: SurfaceRule,
  observation: SurfaceObservation,
  source: FrozenCoverageSource,
): CoverageEntry {
  const matchingShape = rule.expectedShapes.find(
    (shape) =>
      shape.descriptorCategory === observation.descriptorCategory &&
      shape.returnShape === observation.returnShape,
  );
  const accepted = matchingShape !== undefined;
  const expected = matchingShape ?? rule.expectedShapes[0];
  if (expected === undefined) {
    throw new TypeError("invalid coverage rule");
  }
  const kind: EffectiveSurfaceKind = accepted ? rule.kind : "unknown";
  const token = accepted ? (rule.acknowledgmentToken ?? rule.surface) : observation.path;
  const [policyAction, dispatchAction] = effectiveActions(
    kind,
    token,
    observation.returnShape,
    accepted ? rule.capabilityScope : null,
    source.posture,
    source.acknowledgments,
    accepted,
  );
  return freezeEntry({
    ruleId: rule.ruleId,
    surface: observation.path,
    token,
    kind,
    policyAction,
    dispatchAction,
    usageBasis: accepted ? effectiveUsageBasis(rule, source) : null,
    source: rule.source,
    capabilityScope: accepted ? rule.capabilityScope : null,
    condition: rule.condition,
    reason: rule.reason,
    expectedDescriptorCategory: expected.descriptorCategory,
    observedDescriptorCategory: observation.descriptorCategory,
    expectedReturnShape: expected.returnShape,
    observedReturnShape: observation.returnShape,
  });
}

function unknownEntry(
  observation: SurfaceObservation,
  source: FrozenCoverageSource,
): CoverageEntry {
  const provider = source.providerChain[0]?.provider;
  if (provider === undefined) invalidCoverageSource();
  const [policyAction, dispatchAction] = effectiveActions(
    "unknown",
    observation.path,
    observation.returnShape,
    null,
    source.posture,
    source.acknowledgments,
    true,
  );
  return freezeEntry({
    ruleId: `unknown:${source.context.clientShape}:${provider}:${observation.path}`,
    surface: observation.path,
    token: observation.path,
    kind: "unknown",
    policyAction,
    dispatchAction,
    usageBasis: null,
    source: "raw",
    capabilityScope: null,
    condition: null,
    reason: null,
    expectedDescriptorCategory: null,
    observedDescriptorCategory: observation.descriptorCategory,
    expectedReturnShape: null,
    observedReturnShape: observation.returnShape,
  });
}

function compareEntry(left: CoverageEntry, right: CoverageEntry): number {
  return (
    compareText(left.surface, right.surface) ||
    compareText(left.ruleId, right.ruleId) ||
    compareText(left.source, right.source) ||
    compareText(left.observedDescriptorCategory, right.observedDescriptorCategory) ||
    compareText(left.observedReturnShape, right.observedReturnShape)
  );
}

function isProjection(rule: SurfaceRule): boolean {
  if (rule.source === "wrapper" || rule.source === "synthetic_policy") return true;
  return (
    rule.source === "both" &&
    rule.expectedShapes.some(
      (shape) =>
        shape.descriptorCategory === "command_class" || shape.returnShape === "command_class",
    )
  );
}

function buildEntries(source: FrozenCoverageSource): readonly CoverageEntry[] {
  const observations = observePublicSurface(source.rawClient, {
    namespaces: namespacePaths(source.context),
    maxDepth: MAX_SURFACE_INSPECTION_DEPTH,
    requireAllNamespaces: false,
  });
  const entries: CoverageEntry[] = [];
  const ruleIds = new Set<string>();
  for (const observation of observations) {
    const rule = resolveSurfaceRule({
      context: source.context,
      path: observation.path,
      source: "raw",
    });
    const entry =
      rule === undefined
        ? unknownEntry(observation, source)
        : knownEntry(rule, observation, source);
    entries.push(entry);
    ruleIds.add(entry.ruleId);
  }

  for (const rule of SURFACE_RULES) {
    if (!isProjection(rule) || !ruleApplies(rule, source.context) || ruleIds.has(rule.ruleId)) {
      continue;
    }
    const expected = rule.expectedShapes[0];
    if (expected === undefined) throw new TypeError("invalid coverage rule");
    const observation: SurfaceObservation = {
      path: rule.surface,
      descriptorCategory: expected.descriptorCategory,
      returnShape: expected.returnShape,
    };
    entries.push(knownEntry(rule, observation, source));
    ruleIds.add(rule.ruleId);
  }
  return Object.freeze(entries.sort(compareEntry));
}

const COVERAGE_POLICY_ACTIONS = Object.freeze([
  "pass",
  "track",
  "block",
  "unsupported",
  "warn",
  "raise",
  "allow",
  "acknowledged",
] as const);

const COVERAGE_DISPATCH_ACTIONS = Object.freeze([
  "guard",
  "intercept",
  "refuse",
  "return",
] as const);

const COVERAGE_ENTRY_KEYS = Object.freeze([
  "ruleId",
  "surface",
  "token",
  "kind",
  "policyAction",
  "dispatchAction",
  "usageBasis",
  "source",
  "capabilityScope",
  "condition",
  "reason",
  "expectedDescriptorCategory",
  "observedDescriptorCategory",
  "expectedReturnShape",
  "observedReturnShape",
] as const);

const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

function includesValue<T>(values: readonly T[], value: unknown): value is T {
  return values.includes(value as T);
}

function categoryFor(entry: CoverageEntry): CoverageCategory {
  if (entry.condition !== null) return "conditional";
  if (entry.kind === "namespace") return "guarded_namespaces";
  if (entry.kind === "metered") return "tracked";
  if (entry.kind === "unknown") return "unknown";
  if (entry.kind === "blocked") return "blocked";
  if (entry.kind === "unsupported") return "unsupported";
  if (entry.kind === "metadata" || entry.kind === "infrastructure") return "safe";
  if (
    entry.kind === "unmetered_spend" &&
    entry.capabilityScope !== null &&
    entry.capabilityScope !== "operation"
  ) {
    return "scoped_escapes";
  }
  if (entry.kind === "unmetered_spend") return "untracked";
  throw new TypeError("invalid coverage entry kind");
}

function auditEntry(entry: CoverageEntry): CoverageAuditEntry {
  return Object.freeze({
    ruleId: entry.ruleId,
    surface: entry.surface,
    token: entry.token,
    kind: entry.kind,
    policyAction: entry.policyAction,
    dispatchAction: entry.dispatchAction,
    usageBasis: entry.usageBasis,
    source: entry.source,
    capabilityScope: entry.capabilityScope,
    condition: entry.condition,
    reason: entry.reason,
    expectedDescriptorCategory: entry.expectedDescriptorCategory,
    observedDescriptorCategory: entry.observedDescriptorCategory,
    expectedReturnShape: entry.expectedReturnShape,
    observedReturnShape: entry.observedReturnShape,
  });
}

function categoryEntries(entries: readonly CoverageEntry[]): CoverageExpectation {
  const buckets: Record<CoverageCategory, CoverageAuditEntry[]> = {
    conditional: [],
    guarded_namespaces: [],
    tracked: [],
    unknown: [],
    blocked: [],
    unsupported: [],
    safe: [],
    scoped_escapes: [],
    untracked: [],
  };
  for (const entry of entries) {
    buckets[categoryFor(entry)].push(auditEntry(entry));
  }
  return Object.freeze({
    conditional: Object.freeze(buckets.conditional),
    guarded_namespaces: Object.freeze(buckets.guarded_namespaces),
    tracked: Object.freeze(buckets.tracked),
    unknown: Object.freeze(buckets.unknown),
    blocked: Object.freeze(buckets.blocked),
    unsupported: Object.freeze(buckets.unsupported),
    safe: Object.freeze(buckets.safe),
    scoped_escapes: Object.freeze(buckets.scoped_escapes),
    untracked: Object.freeze(buckets.untracked),
  });
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function canonicalValue(value: unknown, ancestors = new Set<object>()): CanonicalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("invalid canonical JSON");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("invalid canonical JSON");
  if (ancestors.has(value)) throw new TypeError("invalid canonical JSON");

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    const result: CanonicalJson[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("invalid canonical JSON");
      }
      result.push(canonicalValue(descriptor.value, nextAncestors));
    }
    return result;
  }

  let prototype: object | null;
  let keys: readonly (string | symbol)[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError("invalid canonical JSON");
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.some((key) => typeof key === "symbol")
  ) {
    throw new TypeError("invalid canonical JSON");
  }
  const result: Record<string, CanonicalJson> = {};
  for (const key of (keys as string[]).sort(compareText)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("invalid canonical JSON");
    }
    result[key] = canonicalValue(descriptor.value, nextAncestors);
  }
  return result;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

function sha256(bytes: Uint8Array): string {
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const paddedView = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = paddedView.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const before15 = words[index - 15] ?? 0;
      const before2 = words[index - 2] ?? 0;
      const gamma0 = rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3);
      const gamma1 = rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10);
      words[index] = (gamma1 + (words[index - 7] ?? 0) + gamma0 + (words[index - 16] ?? 0)) >>> 0;
    }

    let a = hash[0] ?? 0;
    let b = hash[1] ?? 0;
    let c = hash[2] ?? 0;
    let d = hash[3] ?? 0;
    let e = hash[4] ?? 0;
    let f = hash[5] ?? 0;
    let g = hash[6] ?? 0;
    let h = hash[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sigma1 + choose + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0;
    hash[1] = ((hash[1] ?? 0) + b) >>> 0;
    hash[2] = ((hash[2] ?? 0) + c) >>> 0;
    hash[3] = ((hash[3] ?? 0) + d) >>> 0;
    hash[4] = ((hash[4] ?? 0) + e) >>> 0;
    hash[5] = ((hash[5] ?? 0) + f) >>> 0;
    hash[6] = ((hash[6] ?? 0) + g) >>> 0;
    hash[7] = ((hash[7] ?? 0) + h) >>> 0;
  }
  return [...hash].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function hashAuditEntries(entries: readonly CoverageAuditEntry[]): `sha256:${string}` {
  return `sha256:${sha256(new TextEncoder().encode(canonicalJson(entries)))}`;
}

function fingerprintCategories(categories: CoverageExpectation): CoverageFingerprint {
  return Object.freeze({
    conditional: hashAuditEntries(categories.conditional),
    guarded_namespaces: hashAuditEntries(categories.guarded_namespaces),
    tracked: hashAuditEntries(categories.tracked),
    unknown: hashAuditEntries(categories.unknown),
    blocked: hashAuditEntries(categories.blocked),
    unsupported: hashAuditEntries(categories.unsupported),
    safe: hashAuditEntries(categories.safe),
    scoped_escapes: hashAuditEntries(categories.scoped_escapes),
    untracked: hashAuditEntries(categories.untracked),
  });
}

function fingerprintEntries(entries: readonly CoverageEntry[]): CoverageFingerprint {
  return fingerprintCategories(categoryEntries(entries));
}

function ownDataObject<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): { [Key in Keys[number]]: unknown } | null {
  if (!isObjectLike(value) || Array.isArray(value)) return null;
  let prototype: object | null;
  let ownKeys: readonly (string | symbol)[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return null;
  }
  const result = {} as { [Key in Keys[number]]: unknown };
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return null;
    result[key as Keys[number]] = descriptor.value;
  }
  return result;
}

function snapshotAuditEntry(value: unknown): CoverageAuditEntry | null {
  const entry = ownDataObject(value, COVERAGE_ENTRY_KEYS);
  if (entry === null) return null;
  if (
    typeof entry.ruleId !== "string" ||
    entry.ruleId.length === 0 ||
    typeof entry.surface !== "string" ||
    entry.surface.length === 0 ||
    typeof entry.token !== "string" ||
    entry.token.length === 0 ||
    !includesValue(EFFECTIVE_SURFACE_KINDS, entry.kind) ||
    !includesValue(COVERAGE_POLICY_ACTIONS, entry.policyAction) ||
    !includesValue(COVERAGE_DISPATCH_ACTIONS, entry.dispatchAction) ||
    (entry.usageBasis !== null && !includesValue(USAGE_BASES, entry.usageBasis)) ||
    !includesValue(SURFACE_SOURCES, entry.source) ||
    (entry.capabilityScope !== null && !includesValue(CAPABILITY_SCOPES, entry.capabilityScope)) ||
    (entry.condition !== null && !includesValue(SURFACE_CONDITIONS, entry.condition)) ||
    (entry.reason !== null && typeof entry.reason !== "string") ||
    (entry.expectedDescriptorCategory !== null &&
      !includesValue(DESCRIPTOR_CATEGORIES, entry.expectedDescriptorCategory)) ||
    !includesValue(DESCRIPTOR_CATEGORIES, entry.observedDescriptorCategory) ||
    (entry.expectedReturnShape !== null &&
      !includesValue(RETURN_SHAPES, entry.expectedReturnShape)) ||
    !includesValue(RETURN_SHAPES, entry.observedReturnShape)
  ) {
    return null;
  }
  return Object.freeze({
    ruleId: entry.ruleId,
    surface: entry.surface,
    token: entry.token,
    kind: entry.kind,
    policyAction: entry.policyAction,
    dispatchAction: entry.dispatchAction,
    usageBasis: entry.usageBasis,
    source: entry.source,
    capabilityScope: entry.capabilityScope,
    condition: entry.condition,
    reason: entry.reason,
    expectedDescriptorCategory: entry.expectedDescriptorCategory,
    observedDescriptorCategory: entry.observedDescriptorCategory,
    expectedReturnShape: entry.expectedReturnShape,
    observedReturnShape: entry.observedReturnShape,
  });
}

type SnapshotExpectation =
  | { readonly kind: "fingerprint"; readonly value: CoverageFingerprint }
  | { readonly kind: "literal"; readonly value: CoverageExpectation };

function invalidCoverageExpectation(): never {
  throw new TypeError("invalid coverage expectation");
}

function snapshotExpectation(expected: unknown): SnapshotExpectation {
  try {
    const object = ownDataObject(expected, COVERAGE_CATEGORIES);
    if (object === null) invalidCoverageExpectation();
    const values = COVERAGE_CATEGORIES.map((category) => object[category]);
    if (values.every((value) => typeof value === "string" && FINGERPRINT_PATTERN.test(value))) {
      return {
        kind: "fingerprint",
        value: Object.freeze({
          conditional: object.conditional as `sha256:${string}`,
          guarded_namespaces: object.guarded_namespaces as `sha256:${string}`,
          tracked: object.tracked as `sha256:${string}`,
          unknown: object.unknown as `sha256:${string}`,
          blocked: object.blocked as `sha256:${string}`,
          unsupported: object.unsupported as `sha256:${string}`,
          safe: object.safe as `sha256:${string}`,
          scoped_escapes: object.scoped_escapes as `sha256:${string}`,
          untracked: object.untracked as `sha256:${string}`,
        }),
      };
    }
    if (!values.every(Array.isArray)) invalidCoverageExpectation();

    const ids = new Set<string>();
    const categories: Record<CoverageCategory, readonly CoverageAuditEntry[]> = {
      conditional: [],
      guarded_namespaces: [],
      tracked: [],
      unknown: [],
      blocked: [],
      unsupported: [],
      safe: [],
      scoped_escapes: [],
      untracked: [],
    };
    for (const category of COVERAGE_CATEGORIES) {
      const entries = object[category] as unknown[];
      const snapshots: CoverageAuditEntry[] = [];
      for (const candidate of entries) {
        const snapshot = snapshotAuditEntry(candidate);
        if (snapshot === null || ids.has(snapshot.ruleId)) invalidCoverageExpectation();
        ids.add(snapshot.ruleId);
        snapshots.push(snapshot);
      }
      categories[category] = Object.freeze(snapshots);
    }
    return {
      kind: "literal",
      value: Object.freeze({
        conditional: categories.conditional,
        guarded_namespaces: categories.guarded_namespaces,
        tracked: categories.tracked,
        unknown: categories.unknown,
        blocked: categories.blocked,
        unsupported: categories.unsupported,
        safe: categories.safe,
        scoped_escapes: categories.scoped_escapes,
        untracked: categories.untracked,
      }),
    };
  } catch {
    invalidCoverageExpectation();
  }
}

function literalDifferences(
  expected: CoverageExpectation,
  actual: CoverageExpectation,
): readonly string[] {
  const differences: string[] = [];
  for (const category of COVERAGE_CATEGORIES) {
    const expectedEntries = expected[category];
    const actualEntries = actual[category];
    const expectedById = new Map(expectedEntries.map((entry) => [entry.ruleId, entry]));
    const actualById = new Map(actualEntries.map((entry) => [entry.ruleId, entry]));
    const missing = [...expectedById.keys()]
      .filter((ruleId) => !actualById.has(ruleId))
      .sort(compareText);
    const unexpected = [...actualById.keys()]
      .filter((ruleId) => !expectedById.has(ruleId))
      .sort(compareText);
    const changed = [...expectedById.keys()]
      .filter((ruleId) => {
        const actualEntry = actualById.get(ruleId);
        return (
          actualEntry !== undefined &&
          canonicalJson(expectedById.get(ruleId)) !== canonicalJson(actualEntry)
        );
      })
      .sort(compareText);
    if (
      expectedEntries.length === actualEntries.length &&
      missing.length === 0 &&
      unexpected.length === 0 &&
      changed.length === 0
    ) {
      continue;
    }
    const suffixes: string[] = [];
    if (missing.length > 0) suffixes.push(`missing [${missing.join(", ")}]`);
    if (changed.length > 0) suffixes.push(`changed [${changed.join(", ")}]`);
    if (unexpected.length > 0) suffixes.push(`unexpected [${unexpected.join(", ")}]`);
    let difference = `${category}: expected ${expectedEntries.length} entries, got ${actualEntries.length}`;
    if (suffixes.length > 0) difference += `, ${suffixes.join(", ")}`;
    differences.push(difference);
  }
  return differences;
}

function fingerprintDifferences(
  expected: CoverageFingerprint,
  actual: CoverageFingerprint,
  categories: CoverageExpectation,
): readonly string[] {
  const differences: string[] = [];
  for (const category of COVERAGE_CATEGORIES) {
    if (expected[category] === actual[category]) continue;
    differences.push(
      `${category}: fingerprint mismatch (expected ${expected[category]}, got ${actual[category]}, ` +
        `entries ${categories[category].length})`,
    );
  }
  return differences;
}

export class CoverageReport {
  readonly provider: string;
  readonly dialect: SurfaceDialect;
  readonly clientShape: SurfaceClientShape;
  readonly posture: UnmeteredPosture;
  readonly providerChain: readonly CoverageRuntime[];
  readonly acknowledgments: readonly string[];
  readonly entries: readonly CoverageEntry[];

  constructor(source: FrozenCoverageSource, entries: readonly CoverageEntry[]) {
    const primary = source.providerChain[0];
    if (primary === undefined) invalidCoverageSource();
    this.provider = primary.provider;
    this.dialect = source.context.dialect;
    this.clientShape = source.context.clientShape;
    this.posture = source.posture;
    this.providerChain = Object.freeze(
      source.providerChain.map((runtime) => freezeRuntime(runtime)),
    );
    this.acknowledgments = Object.freeze([...source.acknowledgments]);
    this.entries = Object.freeze(entries.map(freezeEntry));
    Object.freeze(this);
  }

  fingerprint(): CoverageFingerprint {
    return fingerprintEntries(this.entries);
  }

  expect(expected: CoverageExpectation | CoverageFingerprint): void {
    const snapshot = snapshotExpectation(expected);
    const categories = categoryEntries(this.entries);
    const differences =
      snapshot.kind === "literal"
        ? literalDifferences(snapshot.value, categories)
        : fingerprintDifferences(snapshot.value, fingerprintCategories(categories), categories);
    if (differences.length > 0) {
      throw new CoverageMismatchError({ differences });
    }
  }
}

/** Build a local structural coverage report for a registered Solwyn wrapper. */
export function coverage(client: object): CoverageReport {
  const registration = isObjectLike(client) ? coverageSources.get(client) : undefined;
  if (registration === undefined) {
    throw new TypeError("coverage requires a registered Solwyn wrapper");
  }
  const source =
    registration.refresh === null
      ? registration.source
      : freezeCoverageSource(registration.refresh());
  if (registration.refresh !== null) {
    coverageSources.set(client, Object.freeze({ source, refresh: registration.refresh }));
  }
  return new CoverageReport(source, buildEntries(source));
}

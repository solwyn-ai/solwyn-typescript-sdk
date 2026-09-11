import { SolwynError } from "./errors";
import { OPENAI_TTS_ACKNOWLEDGMENT_TOKEN, SURFACE_RULE_INPUTS } from "./surface-rules";

/** Authored posture categories. `unknown` is an effective result, never a rule kind. */
export const SURFACE_KINDS = [
  "metered",
  "metadata",
  "namespace",
  "unmetered_spend",
  "unsupported",
  "blocked",
  "infrastructure",
] as const;

export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export const EFFECTIVE_SURFACE_KINDS = [...SURFACE_KINDS, "unknown"] as const;
export type EffectiveSurfaceKind = (typeof EFFECTIVE_SURFACE_KINDS)[number];

export const SURFACE_SOURCES = ["raw", "wrapper", "both", "synthetic_policy"] as const;
export type SurfaceSource = (typeof SURFACE_SOURCES)[number];
export type ObservedSurfaceSource = Exclude<SurfaceSource, "both">;

export const USAGE_BASES = [
  "provider",
  "provider_or_estimate",
  "provider_and_request",
  "request_derived",
] as const;
export type UsageBasis = (typeof USAGE_BASES)[number];

export const CAPABILITY_SCOPES = [
  "operation",
  "client",
  "resource",
  "raw_response",
  "arbitrary_endpoint",
] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

export const SURFACE_CONDITIONS = ["openai_untracked_tts_model"] as const;
export type SurfaceCondition = (typeof SURFACE_CONDITIONS)[number];

export const DESCRIPTOR_CATEGORIES = [
  "getter",
  "setter_only",
  "method",
  "field",
  "command_class",
] as const;
export type DescriptorCategory = (typeof DESCRIPTOR_CATEGORIES)[number];

export const RETURN_SHAPES = [
  "scalar",
  "function",
  "class",
  "resource",
  "mapping",
  "sequence",
  "opaque",
  "unevaluated_accessor",
  "command_class",
] as const;
export type ReturnShape = (typeof RETURN_SHAPES)[number];

/** Local SDK-shape vocabulary. It intentionally differs from the current wire enum. */
export const SURFACE_CLIENT_SHAPES = [
  "openai_sdk",
  "native_together",
  "anthropic_sdk",
  "google_genai",
  "google_generativeai",
  "bedrock_v3",
  "undeclared_sdk",
] as const;
export type SurfaceClientShape = (typeof SURFACE_CLIENT_SHAPES)[number];

export type SurfaceDialect = "openai" | "anthropic" | "google" | "bedrock";

export interface SurfaceContext {
  readonly provider: string | null;
  readonly dialect: SurfaceDialect;
  readonly clientShape: SurfaceClientShape;
}

export interface SurfaceSelector {
  readonly provider: string | null;
  readonly dialect: SurfaceDialect | null;
  readonly clientShape: SurfaceClientShape | null;
}

export interface ExpectedSurfaceShape {
  readonly descriptorCategory: DescriptorCategory;
  readonly returnShape: ReturnShape;
}

/** Structural observation input accepted by a rule without importing the graph module. */
export interface SurfaceShapeObservation extends ExpectedSurfaceShape {
  readonly path: string;
}

/** Immutable authored decision row used by resolution and capture auditing. */
export interface SurfaceRule {
  readonly ruleId: string;
  readonly surface: string;
  readonly selectors: readonly SurfaceSelector[];
  readonly kind: SurfaceKind;
  readonly source: SurfaceSource;
  readonly expectedShapes: readonly ExpectedSurfaceShape[];
  readonly usageBasis: UsageBasis | null;
  readonly acknowledgmentToken: string | null;
  readonly capabilityScope: CapabilityScope | null;
  readonly condition: SurfaceCondition | null;
  readonly reason: string | null;
  acceptsShape(observation: SurfaceShapeObservation): boolean;
}

const declaredContexts: SurfaceContext[] = [
  { provider: null, dialect: "openai", clientShape: "openai_sdk" },
  { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
  { provider: "azure_openai", dialect: "openai", clientShape: "openai_sdk" },
  { provider: "together", dialect: "openai", clientShape: "openai_sdk" },
  { provider: "together", dialect: "openai", clientShape: "native_together" },
  { provider: "anthropic", dialect: "anthropic", clientShape: "anthropic_sdk" },
  { provider: "google", dialect: "google", clientShape: "google_genai" },
  { provider: "google", dialect: "google", clientShape: "google_generativeai" },
  { provider: "bedrock", dialect: "bedrock", clientShape: "bedrock_v3" },
];

for (const context of declaredContexts) {
  Object.freeze(context);
}

/** Contexts for which the hand-authored E1 rule table is authoritative. */
export const DECLARED_SURFACE_CONTEXTS: readonly SurfaceContext[] = Object.freeze(declaredContexts);

/** Whether a runtime context falls under a declared exact or provider-wildcard context. */
export function contextIsDeclared(context: SurfaceContext): boolean {
  return DECLARED_SURFACE_CONTEXTS.some(
    (candidate) =>
      (candidate.provider === null || candidate.provider === context.provider) &&
      candidate.dialect === context.dialect &&
      candidate.clientShape === context.clientShape,
  );
}

const LOCAL_IDENTIFIER = /^(?:[$\p{ID_Start}])(?:[$\p{ID_Continue}])*$/u;
const WIRE_SURFACE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/;
const WIRE_SURFACE_MAX_LENGTH = 128;

/**
 * Validate a local public-surface path without reflecting unsafe input in the error.
 * Unicode identifiers and paths beyond the advisory wire limits remain valid locally.
 */
export function validateSurfacePath(path: string): string {
  const segments = typeof path === "string" ? path.split(".") : [];
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment.startsWith("_") || !LOCAL_IDENTIFIER.test(segment),
    )
  ) {
    throw new SolwynError("invalid public surface path");
  }
  return path;
}

/** Whether a structurally valid local path can be projected into today's wire contract. */
export function isSurfacePathWireEligible(path: string): boolean {
  const validated = validateSurfacePath(path);
  return validated.length <= WIRE_SURFACE_MAX_LENGTH && WIRE_SURFACE.test(validated);
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function prototypeChain(value: unknown): readonly object[] {
  if (!isObjectLike(value)) {
    return [];
  }
  const chain: object[] = [];
  let current: object | null = value;
  try {
    for (let depth = 0; current !== null && depth < 24; depth += 1) {
      chain.push(current);
      current = Reflect.getPrototypeOf(current);
    }
  } catch {
    return chain;
  }
  return chain;
}

/** Constructor labels only; no instance getter or provider operation is evaluated. */
function constructorNames(value: unknown): readonly string[] {
  const names: string[] = [];
  for (const current of prototypeChain(value)) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(current, "constructor");
    } catch {
      continue;
    }
    const ctor = descriptor !== undefined && "value" in descriptor ? descriptor.value : null;
    const name = typeof ctor === "function" ? staticDataProperty(ctor, "name") : undefined;
    if (typeof name === "string" && name.length > 0) {
      names.push(name);
    }
  }
  return names;
}

function staticDataProperty(value: unknown, key: string): unknown {
  for (const current of prototypeChain(value)) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(current, key);
    } catch {
      return undefined;
    }
    if (descriptor === undefined) {
      continue;
    }
    return "value" in descriptor ? descriptor.value : undefined;
  }
  return undefined;
}

function staticPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    current = staticDataProperty(current, segment);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function hasConstructorName(names: readonly string[], pattern: RegExp): boolean {
  return names.some((name) => pattern.test(name));
}

/**
 * Derive the SDK object's local shape using constructor ancestry and static duck typing.
 * The precedence is load-bearing and this function never calls provider operations/getters.
 */
export function deriveSurfaceClientShape(client: unknown): SurfaceClientShape {
  const names = constructorNames(client);
  const hasStaticChatCompletion =
    typeof staticPath(client, ["chat", "completions", "create"]) === "function";
  const hasStaticResponsesCreate =
    typeof staticPath(client, ["responses", "create"]) === "function";

  if (hasConstructorName(names, /Together/i) && hasStaticChatCompletion) {
    return "native_together";
  }
  if (hasStaticChatCompletion || hasStaticResponsesCreate) {
    return "openai_sdk";
  }
  if (typeof staticPath(client, ["messages", "create"]) === "function") {
    return "anthropic_sdk";
  }
  if (
    typeof staticPath(client, ["models", "generateContent"]) === "function" ||
    typeof staticPath(client, ["models", "generateContentStream"]) === "function"
  ) {
    return "google_genai";
  }
  if (typeof staticPath(client, ["getGenerativeModel"]) === "function") {
    return "google_generativeai";
  }
  if (
    hasConstructorName(names, /BedrockRuntime/i) &&
    typeof staticPath(client, ["send"]) === "function"
  ) {
    return "bedrock_v3";
  }
  return "undeclared_sdk";
}

export interface SurfaceRuleInput {
  readonly ruleId: string;
  readonly surface: string;
  readonly selectors: readonly SurfaceSelector[];
  readonly kind: SurfaceKind;
  readonly source: SurfaceSource;
  readonly expectedShapes: readonly ExpectedSurfaceShape[];
  readonly usageBasis?: UsageBasis;
  readonly acknowledgmentToken?: string;
  readonly capabilityScope?: CapabilityScope;
  readonly condition?: SurfaceCondition;
  readonly reason?: string;
}

/** Typed, content-free failure for authored-table invariants and resolver ambiguity. */
export class SurfaceRuleError extends SolwynError {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceRuleError";
  }
}

function includes<T>(values: readonly T[], value: unknown): value is T {
  return values.includes(value as T);
}

function invalidRule(): never {
  throw new SurfaceRuleError("invalid surface rule");
}

function kebabSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function expectedRuleIdPrefix(surface: string, kind: SurfaceKind): string {
  return `surface.${surface.split(".").map(kebabSegment).join("-")}.${kind}`;
}

function selectorKey(selector: SurfaceSelector): string {
  return `${selector.provider ?? "*"}|${selector.dialect ?? "*"}|${selector.clientShape ?? "*"}`;
}

function shapeKey(shape: ExpectedSurfaceShape): string {
  return `${shape.descriptorCategory}|${shape.returnShape}`;
}

function applicabilityKey(input: SurfaceRuleInput): string {
  const selectors = input.selectors.map(selectorKey).sort().join(",");
  return `${input.surface}|${selectors}|${input.source}|${input.condition ?? ""}`;
}

function validateSelector(selector: SurfaceSelector): void {
  if (
    (selector.provider !== null && !/^[a-z][a-z0-9_]*$/.test(selector.provider)) ||
    (selector.dialect !== null &&
      !includes<SurfaceDialect>(["openai", "anthropic", "google", "bedrock"], selector.dialect)) ||
    (selector.clientShape !== null && !includes(SURFACE_CLIENT_SHAPES, selector.clientShape))
  ) {
    invalidRule();
  }
}

function validateAcknowledgmentToken(
  token: string,
  surface: string,
  condition: SurfaceCondition | undefined,
): void {
  if (condition === "openai_untracked_tts_model") {
    if (surface !== "audio.speech.create" || token !== OPENAI_TTS_ACKNOWLEDGMENT_TOKEN) {
      invalidRule();
    }
    return;
  }
  if (token.includes(":") || !isSurfacePathWireEligible(token)) {
    invalidRule();
  }
}

function validateRuleInput(input: SurfaceRuleInput): void {
  let surface: string;
  try {
    surface = validateSurfacePath(input.surface);
  } catch {
    invalidRule();
  }
  if (!isSurfacePathWireEligible(surface)) {
    invalidRule();
  }

  const prefix = expectedRuleIdPrefix(surface, input.kind);
  if (
    !input.ruleId.startsWith(prefix) ||
    !new RegExp(
      `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.[a-z0-9][a-z0-9-]*)*$`,
    ).test(input.ruleId) ||
    !includes(SURFACE_KINDS, input.kind) ||
    !includes(SURFACE_SOURCES, input.source) ||
    input.selectors.length === 0 ||
    input.expectedShapes.length === 0
  ) {
    invalidRule();
  }

  const selectorKeys = new Set<string>();
  for (const selector of input.selectors) {
    validateSelector(selector);
    const key = selectorKey(selector);
    if (selectorKeys.has(key)) {
      invalidRule();
    }
    selectorKeys.add(key);
  }

  const shapeKeys = new Set<string>();
  for (const shape of input.expectedShapes) {
    if (
      !includes(DESCRIPTOR_CATEGORIES, shape.descriptorCategory) ||
      !includes(RETURN_SHAPES, shape.returnShape)
    ) {
      invalidRule();
    }
    const key = shapeKey(shape);
    if (shapeKeys.has(key)) {
      invalidRule();
    }
    shapeKeys.add(key);
  }

  if (input.kind === "metered") {
    if (input.usageBasis === undefined || !includes(USAGE_BASES, input.usageBasis)) {
      invalidRule();
    }
  } else if (input.usageBasis !== undefined) {
    invalidRule();
  }

  if (input.kind === "unmetered_spend") {
    if (
      input.acknowledgmentToken === undefined ||
      input.capabilityScope === undefined ||
      !includes(CAPABILITY_SCOPES, input.capabilityScope)
    ) {
      invalidRule();
    }
    validateAcknowledgmentToken(input.acknowledgmentToken, surface, input.condition);
  } else if (input.acknowledgmentToken !== undefined || input.capabilityScope !== undefined) {
    invalidRule();
  }

  if (input.condition !== undefined && !includes(SURFACE_CONDITIONS, input.condition)) {
    invalidRule();
  }
  if (
    (input.kind === "blocked" || input.kind === "unsupported") &&
    (input.reason === undefined ||
      input.reason.length === 0 ||
      input.reason.length > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9 .,/:()'_-]*$/.test(input.reason))
  ) {
    invalidRule();
  }

  const exposesRaw = input.source === "raw" || input.source === "both";
  const callable = input.expectedShapes.some(
    (shape) =>
      shape.descriptorCategory === "method" ||
      shape.descriptorCategory === "command_class" ||
      shape.returnShape === "function" ||
      shape.returnShape === "class" ||
      shape.returnShape === "command_class",
  );
  if (input.kind === "infrastructure" && exposesRaw && callable) {
    invalidRule();
  }
}

function freezeRule(input: SurfaceRuleInput): SurfaceRule {
  const surface = input.surface;
  const selectors = Object.freeze(
    input.selectors.map((selector) => Object.freeze({ ...selector })),
  );
  const expectedShapes = Object.freeze(
    input.expectedShapes.map((expectedShape) => Object.freeze({ ...expectedShape })),
  );
  const rule: SurfaceRule = {
    ruleId: input.ruleId,
    surface,
    selectors,
    kind: input.kind,
    source: input.source,
    expectedShapes,
    usageBasis: input.usageBasis ?? null,
    acknowledgmentToken: input.acknowledgmentToken ?? null,
    capabilityScope: input.capabilityScope ?? null,
    condition: input.condition ?? null,
    reason: input.reason ?? null,
    acceptsShape(observation: SurfaceShapeObservation): boolean {
      return (
        observation.path === surface &&
        expectedShapes.some(
          (expected) =>
            expected.descriptorCategory === observation.descriptorCategory &&
            expected.returnShape === observation.returnShape,
        )
      );
    },
  };
  return Object.freeze(rule);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Validate, detach, sort, and deeply freeze an authored rule collection. */
export function createSurfaceRules(inputs: readonly SurfaceRuleInput[]): readonly SurfaceRule[] {
  const ids = new Set<string>();
  const applicability = new Set<string>();
  const rules: SurfaceRule[] = [];
  for (const input of inputs) {
    validateRuleInput(input);
    const key = applicabilityKey(input);
    if (ids.has(input.ruleId) || applicability.has(key)) {
      invalidRule();
    }
    ids.add(input.ruleId);
    applicability.add(key);
    rules.push(freezeRule(input));
  }
  rules.sort(
    (left, right) =>
      compareText(left.surface, right.surface) || compareText(left.ruleId, right.ruleId),
  );
  return Object.freeze(rules);
}

export interface ResolveSurfaceRuleOptions {
  readonly context: SurfaceContext;
  readonly path: string;
  readonly source: ObservedSurfaceSource;
  readonly condition?: SurfaceCondition;
  readonly rules?: readonly SurfaceRule[];
}

interface ScoredRule {
  readonly rule: SurfaceRule;
  readonly contextScore: number;
  readonly sourceScore: number;
  readonly conditionScore: number;
}

function matchingSelectorScore(rule: SurfaceRule, context: SurfaceContext): number | null {
  let best: number | null = null;
  for (const selector of rule.selectors) {
    if (
      (selector.provider === null || selector.provider === context.provider) &&
      (selector.dialect === null || selector.dialect === context.dialect) &&
      (selector.clientShape === null || selector.clientShape === context.clientShape)
    ) {
      const score =
        Number(selector.provider !== null) +
        Number(selector.dialect !== null) +
        Number(selector.clientShape !== null);
      best = best === null ? score : Math.max(best, score);
    }
  }
  return best;
}

function compareScore(left: ScoredRule, right: ScoredRule): number {
  return (
    left.contextScore - right.contextScore ||
    left.sourceScore - right.sourceScore ||
    left.conditionScore - right.conditionScore
  );
}

/** Resolve the single most-specific authored row, returning no row for local-only paths. */
export function resolveSurfaceRule(options: ResolveSurfaceRuleOptions): SurfaceRule | undefined {
  const path = validateSurfacePath(options.path);
  if (!isSurfacePathWireEligible(path)) {
    return undefined;
  }

  const candidates: ScoredRule[] = [];
  for (const rule of options.rules ?? SURFACE_RULES) {
    if (rule.surface !== path) {
      continue;
    }
    const sourceMatches =
      rule.source === options.source ||
      (rule.source === "both" && (options.source === "raw" || options.source === "wrapper"));
    if (!sourceMatches) {
      continue;
    }
    if (rule.condition !== null && rule.condition !== options.condition) {
      continue;
    }
    const contextScore = matchingSelectorScore(rule, options.context);
    if (contextScore === null) {
      continue;
    }
    candidates.push({
      rule,
      contextScore,
      sourceScore: rule.source === options.source ? 1 : 0,
      conditionScore: rule.condition === null ? 0 : 1,
    });
  }
  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort((left, right) => compareScore(right, left));
  const top = candidates[0];
  if (top === undefined) {
    return undefined;
  }
  const tied = candidates.filter((candidate) => compareScore(candidate, top) === 0);
  if (tied.length > 1) {
    const ids = tied.map(({ rule }) => rule.ruleId).sort();
    throw new SurfaceRuleError(`ambiguous surface rules: ${ids.join(", ")}`);
  }
  return top.rule;
}

/** The hand-authored, deeply frozen E1a rule table. */
export const SURFACE_RULES: readonly SurfaceRule[] = createSurfaceRules(SURFACE_RULE_INPUTS);

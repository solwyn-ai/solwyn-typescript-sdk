import { observePublicSurface, type SurfaceObservation } from "../../src/surface-graph";
import {
  resolveSurfaceRule,
  SURFACE_RULES,
  type SurfaceContext,
  type SurfaceRule,
} from "../../src/surfaces";

export class SurfaceCanaryError extends Error {
  readonly clientFamily: string;
  readonly installedVersion: string;
  readonly path: string;
  readonly stage: "rule_resolution" | "unknown_classification" | "shape_drift";
  readonly causeType?: string;

  constructor(options: {
    readonly clientFamily: string;
    readonly installedVersion: string;
    readonly path: string;
    readonly stage: "rule_resolution" | "unknown_classification" | "shape_drift";
    readonly causeType?: string;
  }) {
    const suffix = options.causeType === undefined ? "" : ` (${options.causeType})`;
    super(
      `Surface canary failed for ${options.clientFamily} ${options.installedVersion} at '${options.path}' during ${options.stage}${suffix}`,
    );
    this.name = "SurfaceCanaryError";
    this.clientFamily = options.clientFamily;
    this.installedVersion = options.installedVersion;
    this.path = options.path;
    this.stage = options.stage;
    this.causeType = options.causeType;
  }
}

export type BaselineRow = readonly [path: string, shapes: readonly string[]];

export interface ReviewedSurfaceResult {
  readonly namespaces: readonly string[];
  readonly observations: readonly SurfaceObservation[];
}

type RawRuleWinner = (path: string) => SurfaceRule | undefined;

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function selectorApplies(
  selector: SurfaceRule["selectors"][number],
  context: SurfaceContext,
): boolean {
  return (
    (selector.provider === null || selector.provider === context.provider) &&
    (selector.dialect === null || selector.dialect === context.dialect) &&
    (selector.clientShape === null || selector.clientShape === context.clientShape)
  );
}

function compareNullableText(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareText(left, right);
}

function compareSelectors(
  left: SurfaceRule["selectors"][number],
  right: SurfaceRule["selectors"][number],
): number {
  return (
    compareNullableText(left.provider, right.provider) ||
    compareNullableText(left.dialect, right.dialect) ||
    compareNullableText(left.clientShape, right.clientShape)
  );
}

const SURFACE_ACTIONS = {
  namespace: ["pass", "guard"],
  metered: ["track", "intercept"],
  blocked: ["block", "refuse"],
  unsupported: ["unsupported", "refuse"],
  unmetered_spend: ["posture", "posture"],
  metadata: ["pass", "return"],
  infrastructure: ["pass", "return"],
} as const satisfies Record<SurfaceRule["kind"], readonly [string, string]>;

/** Deterministic JSON-ready authored-rule slice for one declared runtime context. */
export function contextContractData(context: SurfaceContext): unknown {
  return SURFACE_RULES.filter((rule) =>
    rule.selectors.some((selector) => selectorApplies(selector, context)),
  )
    .map((rule) => {
      const [policyAction, dispatchAction] = SURFACE_ACTIONS[rule.kind];
      return {
        id: rule.ruleId,
        surface: rule.surface,
        token: rule.acknowledgmentToken ?? rule.surface,
        selectors: [...rule.selectors].sort(compareSelectors).map((selector) => ({
          provider: selector.provider,
          dialect: selector.dialect,
          client_shape: selector.clientShape,
        })),
        kind: rule.kind,
        source: rule.source,
        policy_action: policyAction,
        dispatch_action: dispatchAction,
        usage_basis: rule.usageBasis,
        acknowledgment_token: rule.acknowledgmentToken,
        capability_scope: rule.capabilityScope,
        condition: rule.condition,
        reason: rule.reason,
        expected_attribute_shapes: [...rule.expectedShapes]
          .sort(
            (left, right) =>
              compareText(left.descriptorCategory, right.descriptorCategory) ||
              compareText(left.returnShape, right.returnShape),
          )
          .map((shape) => ({
            descriptor_category: shape.descriptorCategory,
            return_shape: shape.returnShape,
          })),
      };
    })
    .sort(
      (left, right) => compareText(left.surface, right.surface) || compareText(left.id, right.id),
    );
}

function createRawRuleWinner(
  context: SurfaceContext,
  rules: readonly SurfaceRule[],
): RawRuleWinner {
  const winners = new Map<string, SurfaceRule | undefined>();
  return (path) => {
    if (winners.has(path)) {
      return winners.get(path);
    }
    const winner = resolveSurfaceRule({ context, path, source: "raw", rules });
    winners.set(path, winner);
    return winner;
  };
}

function resolvedNamespacePaths(
  rules: readonly SurfaceRule[],
  winnerForPath: RawRuleWinner,
): readonly string[] {
  return resolvedReviewedRuleFrontier(rules, winnerForPath).namespacePaths;
}

interface ReviewedRuleFrontier {
  readonly namespacePaths: readonly string[];
  readonly terminalResourcePaths: ReadonlySet<string>;
}

function resolvedReviewedRuleFrontier(
  rules: readonly SurfaceRule[],
  winnerForPath: RawRuleWinner,
): ReviewedRuleFrontier {
  const rawRules = rules.filter((rule) => rule.source === "raw" || rule.source === "both");
  const applicableResourceRules = rawRules.filter((rule) => {
    if (!rule.expectedShapes.some((shape) => shape.returnShape === "resource")) {
      return false;
    }
    return winnerForPath(rule.surface)?.ruleId === rule.ruleId;
  });

  const namespaces = new Set<string>();
  const terminalResources = new Set<string>();
  for (const rule of applicableResourceRules) {
    if (rule.kind === "infrastructure") {
      terminalResources.add(rule.surface);
    }
    if (
      rule.kind === "namespace" ||
      rawRules.some(
        (candidate) =>
          candidate.surface.startsWith(`${rule.surface}.`) &&
          winnerForPath(candidate.surface)?.ruleId === candidate.ruleId,
      )
    ) {
      namespaces.add(rule.surface);
    }
  }
  return Object.freeze({
    namespacePaths: Object.freeze([...namespaces].sort()),
    terminalResourcePaths: terminalResources,
  });
}

/** Raw resolver-aware namespace paths for use with the descriptor observer. */
export function declaredNamespacePaths(context: SurfaceContext): string[] {
  return [...resolvedNamespacePaths(SURFACE_RULES, createRawRuleWinner(context, SURFACE_RULES))];
}

interface ReviewedSurfaceOptions {
  readonly context: SurfaceContext;
  readonly baselineRows: readonly BaselineRow[];
  readonly maxDepth?: number;
  readonly rules?: readonly SurfaceRule[];
}

function baselineResourcePaths(rows: readonly BaselineRow[]): readonly string[] {
  return rows
    .filter(
      ([, shapes]) => shapes.length > 0 && shapes.every((shape) => shape.endsWith(":resource")),
    )
    .map(([path]) => path);
}

function isAtOrBelow(path: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) {
    if (path === root || path.startsWith(`${root}.`)) {
      return true;
    }
  }
  return false;
}

function reviewedNamespaceSeed(
  options: ReviewedSurfaceOptions,
  frontier: ReviewedRuleFrontier,
): Set<string> {
  return new Set([
    ...frontier.namespacePaths,
    ...baselineResourcePaths(options.baselineRows).filter(
      (path) => !isAtOrBelow(path, frontier.terminalResourcePaths),
    ),
  ]);
}

function observeWithReviewedFrontier(
  root: unknown,
  options: ReviewedSurfaceOptions,
  namespaces: Set<string>,
  terminalResourcePaths: ReadonlySet<string>,
): ReviewedSurfaceResult {
  while (true) {
    const observations = observePublicSurface(root, {
      namespaces: [...namespaces].sort(),
      maxDepth: options.maxDepth,
      requireAllNamespaces: false,
    });
    let expanded = false;
    for (const observation of observations) {
      if (
        observation.descriptorCategory === "field" &&
        observation.returnShape === "resource" &&
        !isAtOrBelow(observation.path, terminalResourcePaths) &&
        !namespaces.has(observation.path)
      ) {
        namespaces.add(observation.path);
        expanded = true;
      }
    }
    if (!expanded) {
      return Object.freeze({
        namespaces: Object.freeze([...namespaces].sort()),
        observations,
      });
    }
  }
}

/**
 * Observe the curated/baseline-reviewed namespace frontier, recursively adding only
 * data-descriptor resources. Unreviewed accessors remain unevaluated.
 */
export function observeReviewedPublicSurface(
  root: unknown,
  options: ReviewedSurfaceOptions,
): ReviewedSurfaceResult {
  const rules = options.rules ?? SURFACE_RULES;
  const winnerForPath = createRawRuleWinner(options.context, rules);
  const frontier = resolvedReviewedRuleFrontier(rules, winnerForPath);
  return observeWithReviewedFrontier(
    root,
    options,
    reviewedNamespaceSeed(options, frontier),
    frontier.terminalResourcePaths,
  );
}

function encodedShape(observation: SurfaceObservation): string {
  return `${observation.descriptorCategory}:${observation.returnShape}`;
}

function baselineShapeMap(rows: readonly BaselineRow[]): ReadonlyMap<string, ReadonlySet<string>> {
  const baseline = new Map<string, Set<string>>();
  for (const [path, shapes] of rows) {
    let merged = baseline.get(path);
    if (merged === undefined) {
      merged = new Set<string>();
      baseline.set(path, merged);
    }
    for (const shape of shapes) {
      merged.add(shape);
    }
  }
  return baseline;
}

interface AuditOptions {
  readonly context: SurfaceContext;
  readonly clientFamily: string;
  readonly installedVersion: string;
  readonly baselineRows: readonly BaselineRow[];
  readonly commandClasses?: readonly string[];
  readonly maxDepth?: number;
  readonly rules?: readonly SurfaceRule[];
}

function canaryFailure(
  options: Pick<AuditOptions, "clientFamily" | "installedVersion">,
  path: string,
  stage: SurfaceCanaryError["stage"],
  causeType?: string,
): never {
  throw new SurfaceCanaryError({ ...options, path, stage, causeType });
}

function resolveForAudit(
  options: AuditOptions,
  path: string,
  winnerForPath: RawRuleWinner,
): SurfaceRule | undefined {
  try {
    return winnerForPath(path);
  } catch {
    return canaryFailure(options, path, "rule_resolution", "SurfaceRuleError");
  }
}

function joinObservation(
  observation: SurfaceObservation,
  options: AuditOptions,
  baseline: ReadonlyMap<string, ReadonlySet<string>>,
  winnerForPath: RawRuleWinner,
): void {
  const rule = resolveForAudit(options, observation.path, winnerForPath);
  if (rule !== undefined) {
    if (!rule.acceptsShape(observation)) {
      canaryFailure(options, observation.path, "shape_drift");
    }
    return;
  }
  const shapes = baseline.get(observation.path);
  if (shapes === undefined) {
    canaryFailure(options, observation.path, "unknown_classification");
  }
  if (!shapes.has(encodedShape(observation))) {
    canaryFailure(options, observation.path, "shape_drift");
  }
}

export function auditPublicSurface(
  root: unknown,
  options: AuditOptions,
): readonly SurfaceObservation[] {
  const rules = options.rules ?? SURFACE_RULES;
  const winnerForPath = createRawRuleWinner(options.context, rules);
  let namespaceSeed: Set<string>;
  let terminalResourcePaths: ReadonlySet<string>;
  try {
    const frontier = resolvedReviewedRuleFrontier(rules, winnerForPath);
    terminalResourcePaths = frontier.terminalResourcePaths;
    namespaceSeed = reviewedNamespaceSeed(options, frontier);
  } catch {
    return canaryFailure(options, "<root>", "rule_resolution", "SurfaceRuleError");
  }
  const observations = observeWithReviewedFrontier(
    root,
    options,
    namespaceSeed,
    terminalResourcePaths,
  ).observations;
  const baseline = baselineShapeMap(options.baselineRows);
  for (const observation of observations) {
    joinObservation(observation, options, baseline, winnerForPath);
  }
  for (const path of [...new Set(options.commandClasses ?? [])].sort()) {
    joinObservation(
      { path, descriptorCategory: "command_class", returnShape: "command_class" },
      options,
      baseline,
      winnerForPath,
    );
  }
  return observations;
}

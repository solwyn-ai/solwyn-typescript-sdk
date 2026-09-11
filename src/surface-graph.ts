import { registerErrorFamily, SolwynError } from "./errors";
import { type DescriptorCategory, type ReturnShape, validateSurfacePath } from "./surfaces";

export const SURFACE_INSPECTION_STAGES = [
  "public_enumeration",
  "invalid_public_name",
  "static_inspection",
  "namespace_evaluation",
  "invalid_namespace_shape",
  "missing_namespace",
  "depth_exhaustion",
  "cycle",
] as const;

export type SurfaceInspectionStage = (typeof SURFACE_INSPECTION_STAGES)[number];

export interface SurfaceObservation {
  readonly path: string;
  readonly descriptorCategory: DescriptorCategory;
  readonly returnShape: ReturnShape;
}

export interface ObservePublicSurfaceOptions {
  readonly namespaces?: readonly string[];
  readonly maxDepth?: number;
  readonly requireAllNamespaces?: boolean;
}

export interface SurfaceInspectionErrorOptions {
  readonly path: string;
  readonly stage: SurfaceInspectionStage;
  readonly causeType: string;
}

const surfaceInspectionErrors = new WeakSet<object>();

/** Typed observer failure containing only a safe path, stage, and cause class label. */
export class SurfaceInspectionError extends SolwynError {
  readonly path: string;
  readonly stage: SurfaceInspectionStage;
  readonly causeType: string;

  constructor(options: SurfaceInspectionErrorOptions) {
    const path = options.path.length === 0 ? "<root>" : options.path;
    super(`surface inspection failed at ${path} during ${options.stage}`);
    this.name = "SurfaceInspectionError";
    brandSurfaceInspectionError(this);
    this.path = options.path;
    this.stage = options.stage;
    this.causeType = options.causeType;
    surfaceInspectionErrors.add(this);
  }
}

const brandSurfaceInspectionError = registerErrorFamily(
  SurfaceInspectionError,
  "SurfaceInspectionError",
);

/** Today's wire surface grammar permits at most eight path segments. */
export const MAX_SURFACE_INSPECTION_DEPTH = 8;

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isNamespaceValue(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

const MAX_PROTOTYPE_LINKS = 24;
const prototypeTraversalErrors = new WeakSet<object>();

class PrototypeTraversalError extends Error {
  readonly safeCauseType: "PrototypeCycle" | "PrototypeDepthLimit";

  constructor(safeCauseType: "PrototypeCycle" | "PrototypeDepthLimit") {
    super(safeCauseType);
    this.safeCauseType = safeCauseType;
    prototypeTraversalErrors.add(this);
  }
}

interface PrototypeWalkResult {
  readonly terminal: "null" | "object" | "function";
  readonly links: number;
}

/** Descriptor-only, bounded prototype traversal safe against hostile Proxy chains. */
function walkPrototypeDescriptors(
  value: object,
  visit: (current: object) => void,
): PrototypeWalkResult {
  const seen = new Set<object>();
  let current: object | null = value;
  let links = 0;
  while (current !== null) {
    if (current === Object.prototype) return { terminal: "object", links };
    if (current === Function.prototype) return { terminal: "function", links };
    if (seen.has(current)) throw new PrototypeTraversalError("PrototypeCycle");
    seen.add(current);
    visit(current);
    if (links >= MAX_PROTOTYPE_LINKS) {
      throw new PrototypeTraversalError("PrototypeDepthLimit");
    }
    current = Reflect.getPrototypeOf(current);
    links += 1;
  }
  return { terminal: "null", links };
}

function staticStringProperty(value: object, key: string): string | undefined {
  let result: string | undefined;
  let found = false;
  walkPrototypeDescriptors(value, (current) => {
    if (found) return;
    const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      found = true;
      result =
        "value" in descriptor && typeof descriptor.value === "string"
          ? descriptor.value
          : undefined;
    }
  });
  return result;
}

const MAX_STRUCTURAL_CAUSE_TYPE_LENGTH = 64;

function causeType(cause: unknown): string {
  const fallback = cause === null ? "null" : typeof cause;
  if (isObjectLike(cause) && prototypeTraversalErrors.has(cause)) {
    return (cause as PrototypeTraversalError).safeCauseType;
  }
  if (!isObjectLike(cause)) {
    return fallback;
  }
  try {
    let first = true;
    let result: string | undefined;
    walkPrototypeDescriptors(cause, (current) => {
      if (first || result !== undefined) {
        first = false;
        return;
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(current, "constructor");
      if (descriptor !== undefined) {
        const ctor = "value" in descriptor ? descriptor.value : null;
        if (typeof ctor !== "function") return;
        const nameDescriptor = Reflect.getOwnPropertyDescriptor(ctor, "name");
        const name =
          nameDescriptor !== undefined && "value" in nameDescriptor
            ? nameDescriptor.value
            : undefined;
        if (
          typeof name === "string" &&
          name.length > 0 &&
          name.length <= MAX_STRUCTURAL_CAUSE_TYPE_LENGTH &&
          /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
        ) {
          result = name;
        }
      }
    });
    return result ?? fallback;
  } catch {
    return fallback;
  }
}

function inspectionFailure(path: string, stage: SurfaceInspectionStage, cause: unknown): never {
  throw new SurfaceInspectionError({ path, stage, causeType: causeType(cause) });
}

function syntheticFailure(
  path: string,
  stage: SurfaceInspectionStage,
  syntheticCauseType: string,
): never {
  throw new SurfaceInspectionError({ path, stage, causeType: syntheticCauseType });
}

function safePath(parent: string, name: string): string {
  const path = parent.length === 0 ? name : `${parent}.${name}`;
  try {
    return validateSurfacePath(path);
  } catch {
    syntheticFailure(parent, "invalid_public_name", "InvalidPublicName");
  }
}

type Callable = (...args: never[]) => unknown;

function functionName(value: Callable): string {
  return staticStringProperty(value, "name") ?? "";
}

function isClassFunction(value: Callable): boolean {
  try {
    return /^class\s/.test(Function.prototype.toString.call(value));
  } catch {
    return false;
  }
}

function callableShape(value: Callable): {
  descriptorCategory: DescriptorCategory;
  returnShape: ReturnShape;
} {
  if (/Command$/.test(functionName(value))) {
    return { descriptorCategory: "command_class", returnShape: "command_class" };
  }
  if (isClassFunction(value)) {
    return { descriptorCategory: "field", returnShape: "class" };
  }
  return {
    descriptorCategory: "method",
    returnShape: "function",
  };
}

function returnShape(value: unknown): ReturnShape {
  if (
    value === null ||
    value === undefined ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return "scalar";
  }
  if (typeof value === "function") {
    const callable = callableShape(value as Callable);
    return callable.returnShape;
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return "sequence";
  }
  let builtin: ReturnShape | undefined;
  const walked = walkPrototypeDescriptors(value, (current) => {
    if (current === Map.prototype || current === Set.prototype) {
      builtin = "mapping";
    }
    if (
      current === Date.prototype ||
      current === RegExp.prototype ||
      current === Promise.prototype ||
      current === Error.prototype ||
      current === ArrayBuffer.prototype
    ) {
      builtin = "opaque";
    }
  });
  if (builtin !== undefined) return builtin;
  return walked.terminal === "null" || (walked.terminal === "object" && walked.links <= 1)
    ? "mapping"
    : "resource";
}

function observedShape(
  value: unknown,
  path: string,
): { readonly descriptorCategory: DescriptorCategory; readonly returnShape: ReturnShape } {
  try {
    if (typeof value === "function") {
      return callableShape(value as Callable);
    }
    return { descriptorCategory: "field", returnShape: returnShape(value) };
  } catch (cause) {
    inspectionFailure(path, "static_inspection", cause);
  }
}

function classifyReturnShape(value: unknown, path: string): ReturnShape {
  try {
    return returnShape(value);
  } catch (cause) {
    inspectionFailure(path, "static_inspection", cause);
  }
}

interface StaticDescriptor {
  readonly name: string;
  readonly descriptor: PropertyDescriptor;
}

function staticDescriptor(
  target: object,
  name: string,
  path: string,
): PropertyDescriptor | undefined {
  let found: PropertyDescriptor | undefined;
  try {
    walkPrototypeDescriptors(target, (current) => {
      if (found !== undefined) return;
      const descriptor = Reflect.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) found = descriptor;
    });
  } catch (cause) {
    if (isObjectLike(cause) && surfaceInspectionErrors.has(cause)) throw cause;
    inspectionFailure(path, "static_inspection", cause);
  }
  return found;
}

/** Descriptor-only observation of one public property; accessors are never evaluated. */
export function observePublicProperty(
  target: object,
  name: string,
  path: string,
): SurfaceObservation | undefined {
  const validatedPath = validateSurfacePath(path);
  if (name.length === 0 || name.startsWith("_") || validatedPath.split(".").at(-1) !== name) {
    syntheticFailure(path, "invalid_public_name", "InvalidPublicName");
  }
  const descriptor = staticDescriptor(target, name, validatedPath);
  if (descriptor === undefined) return undefined;
  if ("value" in descriptor) {
    const shape = observedShape(descriptor.value, validatedPath);
    return Object.freeze({ path: validatedPath, ...shape });
  }
  return Object.freeze({
    path: validatedPath,
    descriptorCategory: descriptor.get === undefined ? "setter_only" : "getter",
    returnShape: "unevaluated_accessor",
  });
}

/** Reclassify an evaluated property while preserving its static descriptor category. */
export function observeEvaluatedProperty(
  path: string,
  descriptorCategory: DescriptorCategory,
  value: unknown,
): SurfaceObservation {
  const validatedPath = validateSurfacePath(path);
  const shape =
    descriptorCategory === "getter" || descriptorCategory === "setter_only"
      ? classifyReturnShape(value, validatedPath)
      : observedShape(value, validatedPath).returnShape;
  return Object.freeze({
    path: validatedPath,
    descriptorCategory,
    returnShape: shape,
  });
}

function publicDescriptors(target: object, path: string): readonly StaticDescriptor[] {
  const descriptors: StaticDescriptor[] = [];
  const seen = new Set<string>();
  try {
    walkPrototypeDescriptors(target, (current) => {
      let keys: readonly (string | symbol)[];
      try {
        keys = Reflect.ownKeys(current);
      } catch (cause) {
        inspectionFailure(path, "public_enumeration", cause);
      }
      for (const key of keys) {
        if (
          typeof key !== "string" ||
          key === "constructor" ||
          key.startsWith("_") ||
          seen.has(key)
        ) {
          continue;
        }
        const fullPath = safePath(path, key);
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Reflect.getOwnPropertyDescriptor(current, key);
        } catch (cause) {
          inspectionFailure(fullPath, "static_inspection", cause);
        }
        if (descriptor !== undefined) {
          descriptors.push({ name: key, descriptor });
          seen.add(key);
        }
      }
    });
  } catch (cause) {
    if (isObjectLike(cause) && surfaceInspectionErrors.has(cause)) throw cause;
    inspectionFailure(path, "public_enumeration", cause);
  }
  return descriptors.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function declaredNamespacePaths(namespaces: readonly string[]): {
  requested: readonly string[];
  traversable: ReadonlySet<string>;
} {
  const requested = [...new Set(namespaces)].sort();
  const traversable = new Set<string>();
  for (const namespace of requested) {
    let valid: string;
    try {
      valid = validateSurfacePath(namespace);
    } catch {
      syntheticFailure("", "invalid_public_name", "InvalidPublicName");
    }
    const segments = valid.split(".");
    for (let index = 1; index <= segments.length; index += 1) {
      traversable.add(segments.slice(0, index).join("."));
    }
  }
  return { requested: Object.freeze(requested), traversable };
}

/**
 * Observe public SDK structure using descriptors only. Declared namespace accessors may
 * be evaluated to continue the walk; callable terminal values are never invoked.
 */
export function observePublicSurface(
  root: unknown,
  options: ObservePublicSurfaceOptions = {},
): readonly SurfaceObservation[] {
  if (!isObjectLike(root)) {
    syntheticFailure("", "invalid_namespace_shape", causeType(root));
  }
  const maxDepth = options.maxDepth ?? MAX_SURFACE_INSPECTION_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_SURFACE_INSPECTION_DEPTH) {
    syntheticFailure("", "depth_exhaustion", "DepthLimit");
  }
  const { requested, traversable } = declaredNamespacePaths(options.namespaces ?? []);
  const found = new Set<string>();
  const observations = new Map<string, SurfaceObservation>();

  const walk = (
    target: object,
    parentPath: string,
    depth: number,
    ancestors: Set<object>,
  ): void => {
    for (const { name, descriptor } of publicDescriptors(target, parentPath)) {
      const path = safePath(parentPath, name);
      const namespaceDeclared = traversable.has(path);
      let value: unknown;
      let descriptorCategory: DescriptorCategory;
      let observedReturnShape: ReturnShape;

      if ("value" in descriptor) {
        value = descriptor.value;
        const shape = observedShape(value, path);
        descriptorCategory = shape.descriptorCategory;
        observedReturnShape = shape.returnShape;
      } else if (descriptor.get !== undefined) {
        descriptorCategory = "getter";
        if (namespaceDeclared) {
          try {
            value = Reflect.apply(descriptor.get, target, []);
          } catch (cause) {
            inspectionFailure(path, "namespace_evaluation", cause);
          }
          observedReturnShape = classifyReturnShape(value, path);
        } else {
          value = undefined;
          observedReturnShape = "unevaluated_accessor";
        }
      } else {
        value = undefined;
        descriptorCategory = "setter_only";
        observedReturnShape = "unevaluated_accessor";
      }

      observations.set(
        path,
        Object.freeze({ path, descriptorCategory, returnShape: observedReturnShape }),
      );

      if (!namespaceDeclared) {
        continue;
      }
      found.add(path);
      if (!isNamespaceValue(value)) {
        syntheticFailure(path, "invalid_namespace_shape", causeType(value));
      }
      if (ancestors.has(value)) {
        syntheticFailure(path, "cycle", "Cycle");
      }
      if (depth >= maxDepth) {
        syntheticFailure(path, "depth_exhaustion", "DepthLimit");
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(value);
      walk(value, path, depth + 1, nextAncestors);
    }
  };

  walk(root, "", 1, new Set([root]));

  if (options.requireAllNamespaces === true) {
    const missing = requested.find((namespace) => !found.has(namespace));
    if (missing !== undefined) {
      syntheticFailure(missing, "missing_namespace", "MissingNamespace");
    }
  }

  return Object.freeze(
    [...observations.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  );
}

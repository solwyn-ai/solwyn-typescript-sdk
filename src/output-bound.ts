import type { Dialect } from "./providers/protocol";

export interface OutputBoundHop {
  readonly provider: string;
  readonly dialect: Dialect;
  readonly model: string;
  readonly defaultParams?: unknown;
}

export interface EffectiveOutputBoundOptions {
  readonly sourceProvider: string;
  readonly sourceDialect: Dialect;
  readonly sourceModel: string;
  readonly globalDefaults: unknown;
  readonly callParams: unknown;
  readonly hops: readonly OutputBoundHop[];
  readonly defaultBound: number;
  readonly responses?: boolean;
}

interface CapSlot {
  readonly value: unknown;
}

interface ProjectedCaps {
  maxTokens?: CapSlot;
  maxCompletionTokens?: CapSlot;
  googleConfigMaxOutputTokens?: CapSlot;
  bedrockMaxTokens?: CapSlot;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function ownSlot(value: unknown, key: string): CapSlot | undefined {
  if (!isObject(value) || !Object.hasOwn(value, key)) {
    return undefined;
  }
  return { value: Reflect.get(value, key) };
}

function nestedSlot(value: unknown, outerKey: string, innerKey: string): CapSlot | undefined {
  const outer = ownSlot(value, outerKey);
  if (outer === undefined) {
    return undefined;
  }
  if (!isObject(outer.value) || Array.isArray(outer.value)) {
    throw new TypeError("malformed structural output-cap object");
  }
  return ownSlot(outer.value, innerKey);
}

function usesOpenaiCompletionTokens(provider: string, model: string): boolean {
  if (provider !== "openai" && provider !== "azure_openai") {
    return false;
  }
  return (
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("gpt-5")
  );
}

/** Normalize one layer before merging, so caller cap aliases override default aliases. */
export function normalizeOpenaiOutputCap(
  provider: string,
  model: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const modern = ownSlot(params, "max_completion_tokens");
  const legacy = ownSlot(params, "max_tokens");
  const cap = modern ?? legacy;
  if (cap === undefined) return params;
  const normalized = { ...params };
  delete normalized["max_tokens"];
  delete normalized["max_completion_tokens"];
  normalized[usesOpenaiCompletionTokens(provider, model) ? "max_completion_tokens" : "max_tokens"] =
    cap.value;
  return normalized;
}

function projectCaps(
  value: unknown,
  dialect: Dialect,
  provider: string,
  model: string,
): ProjectedCaps {
  if (dialect === "openai") {
    const maxTokens = ownSlot(value, "max_tokens");
    const maxCompletionTokens = ownSlot(value, "max_completion_tokens");
    const normalized = normalizeOpenaiOutputCap(provider, model, {
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens.value }),
      ...(maxCompletionTokens === undefined
        ? {}
        : { max_completion_tokens: maxCompletionTokens.value }),
    });
    return {
      maxTokens: ownSlot(normalized, "max_tokens"),
      maxCompletionTokens: ownSlot(normalized, "max_completion_tokens"),
    };
  }
  if (dialect === "anthropic") {
    return { maxTokens: ownSlot(value, "max_tokens") };
  }
  if (dialect === "google") {
    return {
      googleConfigMaxOutputTokens:
        ownSlot(value, "config") === undefined
          ? undefined
          : (nestedSlot(value, "config", "maxOutputTokens") ?? { value: undefined }),
    };
  }
  return {
    bedrockMaxTokens:
      ownSlot(value, "inferenceConfig") === undefined
        ? undefined
        : (nestedSlot(value, "inferenceConfig", "maxTokens") ?? { value: undefined }),
  };
}

function overlayCaps(target: ProjectedCaps, source: ProjectedCaps): void {
  if (source.maxTokens !== undefined) target.maxTokens = source.maxTokens;
  if (source.maxCompletionTokens !== undefined) {
    target.maxCompletionTokens = source.maxCompletionTokens;
  }
  if (source.googleConfigMaxOutputTokens !== undefined) {
    target.googleConfigMaxOutputTokens = source.googleConfigMaxOutputTokens;
  }
  if (source.bedrockMaxTokens !== undefined) {
    target.bedrockMaxTokens = source.bedrockMaxTokens;
  }
}

export function positiveOutputBound(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function positiveCap(slot: CapSlot | undefined): number | null {
  return positiveOutputBound(slot?.value);
}

function resolvedProjectedCap(caps: ProjectedCaps, dialect: Dialect): number | null {
  if (dialect === "openai") {
    return positiveCap(caps.maxCompletionTokens ?? caps.maxTokens);
  }
  if (dialect === "anthropic") {
    return positiveCap(caps.maxTokens);
  }
  if (dialect === "google") {
    return positiveCap(caps.googleConfigMaxOutputTokens);
  }
  return positiveCap(caps.bedrockMaxTokens);
}

function resolveHop(options: EffectiveOutputBoundOptions, hop: OutputBoundHop): number {
  const crossDialect = hop.dialect !== options.sourceDialect;
  const dialect = crossDialect ? options.sourceDialect : hop.dialect;
  const provider = crossDialect ? options.sourceProvider : hop.provider;
  const model = crossDialect ? options.sourceModel : hop.model;
  const caps: ProjectedCaps = {};
  overlayCaps(caps, projectCaps(options.globalDefaults, dialect, provider, model));
  overlayCaps(caps, projectCaps(hop.defaultParams, dialect, provider, model));
  overlayCaps(caps, projectCaps(options.callParams, dialect, provider, model));
  return resolvedProjectedCap(caps, dialect) ?? options.defaultBound;
}

export function resolveEffectiveOutputBound(options: EffectiveOutputBoundOptions): number {
  if (options.responses === true) {
    try {
      return positiveCap(ownSlot(options.callParams, "max_output_tokens")) ?? options.defaultBound;
    } catch {
      return options.defaultBound;
    }
  }

  let largest = 0;
  let sawHop = false;
  try {
    for (const hop of options.hops) {
      sawHop = true;
      let contribution: number;
      try {
        contribution = resolveHop(options, hop);
      } catch {
        contribution = options.defaultBound;
      }
      largest = Math.max(largest, contribution);
    }
  } catch {
    return options.defaultBound;
  }
  return sawHop ? largest : options.defaultBound;
}

export function resolveAiSdkOutputBound(params: unknown, defaultBound: number): number {
  try {
    return positiveCap(ownSlot(params, "maxOutputTokens")) ?? defaultBound;
  } catch {
    return defaultBound;
  }
}

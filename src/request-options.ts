import { ConfigurationError } from "./errors";
import type { Dialect } from "./providers/protocol";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Snapshot native structural configuration; content-bearing nested values stay opaque. */
export function snapshotRequestStructure(params: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(params, "config") && !Object.hasOwn(params, "inferenceConfig")) return params;
  const copy = { ...params };
  for (const key of ["config", "inferenceConfig"]) {
    const value = copy[key];
    if (record(value)) copy[key] = { ...value };
  }
  const config = copy["config"];
  if (record(config) && record(config["httpOptions"])) {
    config["httpOptions"] = { ...config["httpOptions"] };
  }
  return copy;
}

/** A Google source's HTTP carrier has no role in a different dialect's canonical request. */
export function withoutGoogleRequestTransport(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const config = params["config"];
  if (!record(config)) return params;
  const copy = { ...config };
  delete copy["httpOptions"];
  delete copy["abortSignal"];
  return { ...params, config: copy };
}

/** Capture own option descriptors before async work without evaluating option getters. */
export function snapshotRequestOptions(args: readonly unknown[]): readonly unknown[] {
  return args.map((value) => {
    if (value === null || typeof value !== "object") return value;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fetchOptions = descriptors["fetchOptions"];
    if (fetchOptions !== undefined && "value" in fetchOptions && record(fetchOptions.value)) {
      fetchOptions.value = Object.defineProperties(
        {},
        Object.getOwnPropertyDescriptors(fetchOptions.value),
      );
    }
    return Object.defineProperties({}, descriptors);
  });
}

/** Native option payloads cannot replace the request that admission inspects. */
export function captureMeteredRequestOptions(args: readonly unknown[]): readonly unknown[] {
  return args.map((value) => {
    if (value === null || typeof value !== "object") return value;
    const forbidden = ["body", "query", "method", "path", "defaultBaseURL", "stream"].filter(
      (key) => Object.hasOwn(value, key),
    );
    if (forbidden.length > 0) {
      throw new ConfigurationError(
        `Whole-body/query RequestOptions overrides cannot be metered by Solwyn: ${forbidden.sort().join(", ")}`,
        { field: "extra_body" },
      );
    }
    const copy: Record<string, unknown> = { ...value };
    const fetchOptions = copy["fetchOptions"];
    if (record(fetchOptions)) {
      if (["body", "method"].some((key) => Object.hasOwn(fetchOptions, key))) {
        throw new ConfigurationError("Fetch payload/method overrides cannot be metered by Solwyn", {
          field: "fetchOptions",
        });
      }
      copy["fetchOptions"] = { ...fetchOptions };
    }
    return copy;
  });
}

/** Google exposes request-body overrides inside its native nested HTTP carrier. */
export function validateMeteredGoogleOptions(params: Record<string, unknown>): void {
  const config = params["config"];
  if (config === null || typeof config !== "object") return;
  const http = Reflect.get(config, "httpOptions");
  if (http !== null && typeof http === "object" && Object.hasOwn(http, "extraBody")) {
    throw new ConfigurationError("Whole-body HTTP overrides cannot be metered by Solwyn", {
      field: "extra_body",
    });
  }
}

/** Only endpoint-independent transport controls may move to another provider. */
export function crossProviderRequestOptions(
  args: readonly unknown[],
  sourceParams: Record<string, unknown>,
  sourceDialect: Dialect,
  targetDialect: Dialect,
): readonly unknown[] {
  const original = args[0];
  const copied: Record<string, unknown> = {};
  if (record(original)) {
    for (const key of ["timeout", "requestTimeout", "maxRetries"]) {
      if (Object.hasOwn(original, key)) copied[key] = original[key];
    }
  }
  const config = sourceParams["config"];
  const fetchOptions = record(original) ? original["fetchOptions"] : undefined;
  const signal =
    sourceDialect === "google" && record(config)
      ? config["abortSignal"]
      : record(original)
        ? (original["signal"] ??
          original["abortSignal"] ??
          (record(fetchOptions) ? fetchOptions["signal"] : undefined))
        : undefined;
  if (signal !== undefined)
    copied[targetDialect === "google" || targetDialect === "bedrock" ? "abortSignal" : "signal"] =
      signal;
  if (Object.keys(copied).length === 0) return [];
  return [copied];
}

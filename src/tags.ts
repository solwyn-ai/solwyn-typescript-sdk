import { SolwynError } from "./errors";
import type { Logger } from "./logging";

export const TAGS_MAX_KEYS = 10;
export const TAG_KEY_MAX_LENGTH = 64;
export const TAG_VALUE_MAX_LENGTH = 256;

const PLAIN_TAG_RECORD_DETAIL = "requires a plain record of string keys to string values";

export type TagParameter = "solwyn.run(tags)" | "solwyn_tags" | "tags" | "SOLWYN_TAGS";
export type Tags = Record<string, string>;

export interface CaptureTagsOptions {
  readonly perCallTags?: unknown;
  readonly runTags?: unknown;
  readonly defaultTags?: unknown;
  readonly logger: Logger;
}

export function exceedsCodePointLimit(value: string, limit: number): boolean {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > limit) return true;
  }
  return false;
}

function invalid(parameter: TagParameter, detail: string): never {
  throw new SolwynError(`${parameter} ${detail}`);
}

function inspectTagRecord<T>(parameter: TagParameter, inspect: () => T): T {
  try {
    return inspect();
  } catch {
    return invalid(parameter, PLAIN_TAG_RECORD_DETAIL);
  }
}

function safeRecord(entries: readonly (readonly [string, string])[]): Tags {
  return Object.fromEntries(entries);
}

function copyTagsInternal(
  input: unknown,
  parameter: TagParameter,
  enforceKeyLimit: boolean,
): Tags | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input !== "object" || inspectTagRecord(parameter, () => Array.isArray(input))) {
    return invalid(parameter, PLAIN_TAG_RECORD_DETAIL);
  }

  const prototype = inspectTagRecord(parameter, () => Object.getPrototypeOf(input));
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(parameter, PLAIN_TAG_RECORD_DETAIL);
  }
  if (inspectTagRecord(parameter, () => Object.getOwnPropertySymbols(input)).length > 0) {
    return invalid(parameter, "keys must be strings");
  }

  const keys = inspectTagRecord(parameter, () => Object.getOwnPropertyNames(input));
  if (enforceKeyLimit && keys.length > TAGS_MAX_KEYS) {
    return invalid(parameter, `allows at most ${TAGS_MAX_KEYS} keys`);
  }

  const entries: Array<readonly [string, string]> = [];
  for (const key of keys) {
    if (key.length === 0) {
      return invalid(parameter, "keys must be non-empty");
    }
    if (key.includes("\0")) {
      return invalid(parameter, "keys must not contain NUL characters");
    }
    if (exceedsCodePointLimit(key, TAG_KEY_MAX_LENGTH)) {
      return invalid(parameter, `key exceeds max length ${TAG_KEY_MAX_LENGTH}`);
    }

    const descriptor = inspectTagRecord(parameter, () =>
      Object.getOwnPropertyDescriptor(input, key),
    );
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      return invalid(parameter, "values must be strings");
    }
    if (descriptor.value.includes("\0")) {
      return invalid(parameter, "values must not contain NUL characters");
    }
    if (exceedsCodePointLimit(descriptor.value, TAG_VALUE_MAX_LENGTH)) {
      return invalid(parameter, `value exceeds max length ${TAG_VALUE_MAX_LENGTH}`);
    }
    entries.push([key, descriptor.value]);
  }

  return entries.length === 0 ? undefined : safeRecord(entries);
}

/** Validate and defensively copy one caller-supplied tag layer. */
export function copyTags(input: unknown, parameter: TagParameter): Tags | undefined {
  return copyTagsInternal(input, parameter, true);
}

/**
 * Capture the later call-entry tag snapshot. Direct inputs are independently validated;
 * an inherited run layer may exceed the direct-input cap and is clamped only after merge.
 */
export function captureTags(options: CaptureTagsOptions): Tags | undefined {
  const layers = [
    copyTags(options.perCallTags, "solwyn_tags"),
    copyTagsInternal(options.runTags, "solwyn.run(tags)", false),
    copyTags(options.defaultTags, "tags"),
  ];
  const mergedEntries: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  let clamped = false;

  for (const layer of layers) {
    if (layer === undefined) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (seen.has(key)) continue;
      if (mergedEntries.length === TAGS_MAX_KEYS) {
        clamped = true;
        continue;
      }
      seen.add(key);
      mergedEntries.push([key, value]);
    }
  }

  if (clamped) {
    try {
      options.logger.warn(
        `merged tags exceed ${TAGS_MAX_KEYS} keys; lower-priority tags were dropped`,
      );
    } catch {
      // Logging is best-effort and must never block capture or dispatch.
    }
  }

  return mergedEntries.length === 0 ? undefined : safeRecord(mergedEntries);
}

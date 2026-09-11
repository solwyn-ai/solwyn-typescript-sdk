import type { Logger } from "./logging";
import { buildTokenDetails, type TokenDetails } from "./token-details";
import type { MediaUsage } from "./types";

export interface FailSoftUsage {
  readonly tokenDetails: TokenDetails;
  readonly usageUnmeasured: boolean;
}

/** Empty lease IDs are wire-valid authority; legacy empty reservation IDs remain absent. */
export function hasSettlementFunding(funding: {
  readonly reservationId: string | null;
  readonly leaseId: string | null;
}): boolean {
  return funding.leaseId !== null || Boolean(funding.reservationId);
}

interface UsageOptions {
  readonly extract: () => TokenDetails | null | undefined;
  readonly estimate: () => TokenDetails | null | undefined;
  readonly estimatedInputTokens: number;
  readonly logger: Logger;
  readonly estimateEmptyUsage?: boolean;
}

interface MediaUsageOptions {
  readonly extractUsage: () => TokenDetails | null | undefined;
  readonly measureRequest: () => TokenDetails | null | undefined;
  readonly measureMedia: () => MediaUsage | null | undefined;
  readonly logger: Logger;
}

export function extractUsageFailSoft(options: UsageOptions): FailSoftUsage {
  let extracted: TokenDetails | null | undefined;
  try {
    extracted = options.extract();
  } catch (error) {
    warnFailSoft(options.logger, "settlement.extract_usage_failed_fail_soft: %s", error);
  }
  const providerUsageEmpty =
    extracted === null ||
    extracted === undefined ||
    (extracted.input_tokens === 0 && extracted.output_tokens === 0);

  let estimated: TokenDetails | null | undefined;
  try {
    estimated = options.estimate();
  } catch (error) {
    warnFailSoft(options.logger, "settlement.estimate_usage_failed_fail_soft: %s", error);
  }

  const selected = estimated ?? extracted;
  if (options.estimateEmptyUsage === true && providerUsageEmpty) {
    if (estimated?.is_estimated === true) {
      return { tokenDetails: estimated, usageUnmeasured: true };
    }
    return {
      tokenDetails: buildTokenDetails({
        input_tokens: options.estimatedInputTokens,
        output_tokens: 0,
        is_estimated: true,
      }),
      usageUnmeasured: true,
    };
  }
  if (selected !== null && selected !== undefined) {
    return { tokenDetails: selected, usageUnmeasured: selected.is_estimated };
  }
  return {
    tokenDetails: buildTokenDetails({
      input_tokens: options.estimatedInputTokens,
      output_tokens: 0,
      is_estimated: true,
    }),
    usageUnmeasured: true,
  };
}

export function safeExtractRegion(
  extract: () => string | null | undefined,
  logger: Logger,
): string | null {
  return safeStringRead(extract, logger, "settlement.extract_region_failed_fail_soft: %s");
}

export function safeExtractServiceTier(
  extract: () => string | null | undefined,
  logger: Logger,
): string | null {
  return safeStringRead(extract, logger, "settlement.extract_service_tier_failed_fail_soft: %s");
}

export function extractMediaUsageFailSoft(options: MediaUsageOptions): {
  readonly tokenDetails: TokenDetails | null;
  readonly mediaUsage: MediaUsage | null;
} {
  let tokenDetails: TokenDetails | null | undefined;
  try {
    tokenDetails = options.extractUsage();
  } catch (error) {
    warnFailSoft(options.logger, "settlement.media_extract_usage_failed_fail_soft: %s", error);
  }

  if (tokenDetails === null || tokenDetails === undefined) {
    try {
      tokenDetails = options.measureRequest();
    } catch (error) {
      warnFailSoft(options.logger, "settlement.media_measure_request_failed_fail_soft: %s", error);
    }
  }

  let mediaUsage: MediaUsage | null | undefined;
  try {
    mediaUsage = options.measureMedia();
  } catch (error) {
    warnFailSoft(options.logger, "settlement.media_measure_media_failed_fail_soft: %s", error);
  }

  return { tokenDetails: tokenDetails ?? null, mediaUsage: mediaUsage ?? null };
}

function safeStringRead(
  read: () => string | null | undefined,
  logger: Logger,
  template: string,
): string | null {
  try {
    return read() ?? null;
  } catch (error) {
    warnFailSoft(logger, template, error);
    return null;
  }
}

function warnFailSoft(logger: Logger, template: string, error: unknown): void {
  const label = trustedExceptionLabel(error);
  try {
    logger.warn(template, label);
  } catch {
    // Diagnostics are observational; a caller-owned sink cannot change settlement control flow.
  }
}

function trustedExceptionLabel(error: unknown): string {
  try {
    if (error instanceof TypeError) return "TypeError";
    if (error instanceof RangeError) return "RangeError";
    if (error instanceof ReferenceError) return "ReferenceError";
    if (error instanceof SyntaxError) return "SyntaxError";
    if (error instanceof EvalError) return "EvalError";
    if (error instanceof URIError) return "URIError";
    if (error instanceof AggregateError) return "AggregateError";
    if (error instanceof Error) return "Error";
  } catch {
    // A revoked/hostile proxy may throw during built-in identity checks. Fall through safely.
  }
  return error === null ? "null" : typeof error;
}

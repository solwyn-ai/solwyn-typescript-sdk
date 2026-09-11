import { describe, expect, it, vi } from "vitest";
import {
  extractMediaUsageFailSoft,
  extractUsageFailSoft,
  safeExtractRegion,
  safeExtractServiceTier,
} from "../../src/fail-soft";
import type { Logger } from "../../src/logging";
import { buildTokenDetails } from "../../src/token-details";

function recordingLogger(): { logger: Logger; warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  return {
    logger: {
      debug() {},
      info() {},
      warn(...args: unknown[]) {
        warnings.push(args);
      },
      error() {},
    },
    warnings,
  };
}

describe("fail-soft usage ladder", () => {
  it("returns extracted details by identity while still invoking an absent estimate", () => {
    const extracted = buildTokenDetails({ input_tokens: 7, output_tokens: 3 });
    const estimate = vi.fn(() => null);

    const result = extractUsageFailSoft({
      extract: () => extracted,
      estimate,
      estimatedInputTokens: 11,
      logger: recordingLogger().logger,
    });

    expect(estimate).toHaveBeenCalledOnce();
    expect(result.tokenDetails).toBe(extracted);
    expect(result.usageUnmeasured).toBe(false);
  });

  it("lets a non-null estimate replace extracted details by identity and retain the reservation", () => {
    const extracted = buildTokenDetails({ input_tokens: 7, output_tokens: 3 });
    const estimated = buildTokenDetails({
      input_tokens: 8,
      output_tokens: 4,
      is_estimated: true,
    });

    const result = extractUsageFailSoft({
      extract: () => extracted,
      estimate: () => estimated,
      estimatedInputTokens: 11,
      logger: recordingLogger().logger,
    });

    expect(result.tokenDetails).toBe(estimated);
    expect(result.usageUnmeasured).toBe(true);
  });

  it("contains extraction failure and lets the independently-run estimate win", () => {
    const estimated = buildTokenDetails({ input_tokens: 9, output_tokens: 5 });
    const result = extractUsageFailSoft({
      extract: () => {
        throw new TypeError("untrusted");
      },
      estimate: () => estimated,
      estimatedInputTokens: 11,
      logger: recordingLogger().logger,
    });

    expect(result).toEqual({ tokenDetails: estimated, usageUnmeasured: false });
  });

  it.each([
    "throw",
    "null",
  ] as const)("synthesizes the exact conservative bottom tier when extraction throws and estimate is %s", (estimateOutcome) => {
    const result = extractUsageFailSoft({
      extract: () => {
        throw new TypeError("untrusted");
      },
      estimate: () => {
        if (estimateOutcome === "throw") {
          throw new RangeError("untrusted");
        }
        return null;
      },
      estimatedInputTokens: 123,
      logger: recordingLogger().logger,
    });

    expect(result.tokenDetails).toEqual(
      buildTokenDetails({ input_tokens: 123, output_tokens: 0, is_estimated: true }),
    );
    expect(result.usageUnmeasured).toBe(true);
  });

  it.each([
    ["absent", null],
    ["all-zero", buildTokenDetails()],
  ] as const)("marks a retained adapter estimate unmeasured when empty-usage policy sees %s provider usage", (_providerUsage, extracted) => {
    const estimated = buildTokenDetails({
      input_tokens: 4,
      output_tokens: 2,
      is_estimated: true,
    });

    const result = extractUsageFailSoft({
      extract: () => extracted,
      estimate: () => estimated,
      estimatedInputTokens: 10,
      logger: recordingLogger().logger,
      estimateEmptyUsage: true,
    });

    expect(result.tokenDetails).toBe(estimated);
    expect(result.usageUnmeasured).toBe(true);
  });

  it("marks a retained adapter estimate unmeasured for default/chat all-zero usage", () => {
    const estimated = buildTokenDetails({
      input_tokens: 4,
      output_tokens: 2,
      is_estimated: true,
    });

    expect(
      extractUsageFailSoft({
        extract: () => buildTokenDetails(),
        estimate: () => estimated,
        estimatedInputTokens: 10,
        logger: recordingLogger().logger,
      }),
    ).toEqual({ tokenDetails: estimated, usageUnmeasured: true });
  });

  it("keeps all-zero extraction measured by default and only synthesizes when asked", () => {
    const zero = buildTokenDetails();

    const defaultResult = extractUsageFailSoft({
      extract: () => zero,
      estimate: () => null,
      estimatedInputTokens: 10,
      logger: recordingLogger().logger,
    });
    const optedInSynthetic = extractUsageFailSoft({
      extract: () => zero,
      estimate: () => null,
      estimatedInputTokens: 10,
      logger: recordingLogger().logger,
      estimateEmptyUsage: true,
    });

    expect(defaultResult).toEqual({ tokenDetails: zero, usageUnmeasured: false });
    expect(optedInSynthetic).toEqual({
      tokenDetails: buildTokenDetails({
        input_tokens: 10,
        output_tokens: 0,
        is_estimated: true,
      }),
      usageUnmeasured: true,
    });
  });

  it("treats zero main counters as empty even when subsidiary counters are nonzero", () => {
    const extracted = buildTokenDetails({
      cached_input_tokens: 17,
      reasoning_tokens: 9,
    });

    const result = extractUsageFailSoft({
      extract: () => extracted,
      estimate: () => null,
      estimatedInputTokens: 23,
      logger: recordingLogger().logger,
      estimateEmptyUsage: true,
    });

    expect(result).toEqual({
      tokenDetails: buildTokenDetails({
        input_tokens: 23,
        output_tokens: 0,
        is_estimated: true,
      }),
      usageUnmeasured: true,
    });
  });

  it("synthesizes instead of retaining an unmarked estimate for empty provider usage", () => {
    const unmarkedEstimate = buildTokenDetails({ input_tokens: 6, output_tokens: 4 });

    const result = extractUsageFailSoft({
      extract: () => null,
      estimate: () => unmarkedEstimate,
      estimatedInputTokens: 23,
      logger: recordingLogger().logger,
      estimateEmptyUsage: true,
    });

    expect(result.tokenDetails).not.toBe(unmarkedEstimate);
    expect(result).toEqual({
      tokenDetails: buildTokenDetails({
        input_tokens: 23,
        output_tokens: 0,
        is_estimated: true,
      }),
      usageUnmeasured: true,
    });
  });

  it("retains a zero-valued marked estimate by identity for empty provider usage", () => {
    const markedEstimate = buildTokenDetails({ is_estimated: true });

    const result = extractUsageFailSoft({
      extract: () => buildTokenDetails({ reasoning_tokens: 3 }),
      estimate: () => markedEstimate,
      estimatedInputTokens: 23,
      logger: recordingLogger().logger,
      estimateEmptyUsage: true,
    });

    expect(result.tokenDetails).toBe(markedEstimate);
    expect(result.usageUnmeasured).toBe(true);
  });
});

describe("fail-soft diagnostics", () => {
  it("emits every warning family as the exact template and one trusted structural label", () => {
    const { logger, warnings } = recordingLogger();

    extractUsageFailSoft({
      extract: () => {
        throw new TypeError("extract secret");
      },
      estimate: () => {
        throw new RangeError("estimate secret");
      },
      estimatedInputTokens: 1,
      logger,
    });
    safeExtractRegion(() => {
      throw new ReferenceError("region secret");
    }, logger);
    safeExtractServiceTier(() => {
      throw new SyntaxError("tier secret");
    }, logger);
    extractMediaUsageFailSoft({
      extractUsage: () => {
        throw new EvalError("media extract secret");
      },
      measureRequest: () => {
        throw new URIError("media request secret");
      },
      measureMedia: () => {
        throw new Error("media secret");
      },
      logger,
    });

    expect(warnings).toEqual([
      ["settlement.extract_usage_failed_fail_soft: %s", "TypeError"],
      ["settlement.estimate_usage_failed_fail_soft: %s", "RangeError"],
      ["settlement.extract_region_failed_fail_soft: %s", "ReferenceError"],
      ["settlement.extract_service_tier_failed_fail_soft: %s", "SyntaxError"],
      ["settlement.media_extract_usage_failed_fail_soft: %s", "EvalError"],
      ["settlement.media_measure_request_failed_fail_soft: %s", "URIError"],
      ["settlement.media_measure_media_failed_fail_soft: %s", "Error"],
    ]);
  });

  it("contains hostile and revoked thrown values without leaking them or trusting the logger", () => {
    const secret = "SENTINEL_MUST_NOT_LEAK";
    const hostile = {};
    Object.defineProperties(hostile, {
      constructor: {
        get(): never {
          throw new Error(secret);
        },
      },
      message: {
        get(): never {
          throw new Error(secret);
        },
      },
    });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const { logger, warnings } = recordingLogger();

    expect(() =>
      extractUsageFailSoft({
        extract: () => {
          throw hostile;
        },
        estimate: () => {
          throw proxy;
        },
        estimatedInputTokens: 2,
        logger,
      }),
    ).not.toThrow();
    expect(warnings).toEqual([
      ["settlement.extract_usage_failed_fail_soft: %s", "object"],
      ["settlement.estimate_usage_failed_fail_soft: %s", "object"],
    ]);
    expect(JSON.stringify(warnings)).not.toContain(secret);

    const throwingLogger: Logger = {
      debug() {},
      info() {},
      warn() {
        throw new Error("logger must not escape");
      },
      error() {},
    };
    expect(() =>
      safeExtractRegion(() => {
        throw hostile;
      }, throwingLogger),
    ).not.toThrow();
  });
});

describe("safe field and media extraction", () => {
  it("passes region and tier through and degrades failures to absence", () => {
    const { logger } = recordingLogger();

    expect(safeExtractRegion(() => "us-east-1", logger)).toBe("us-east-1");
    expect(safeExtractServiceTier(() => "priority", logger)).toBe("priority");
    expect(
      safeExtractRegion(() => {
        throw new Error("untrusted");
      }, logger),
    ).toBeNull();
    expect(
      safeExtractServiceTier(() => {
        throw new Error("untrusted");
      }, logger),
    ).toBeNull();
  });

  it("runs media fallbacks independently and always runs media measurement", () => {
    const calls: string[] = [];
    const requestDetails = buildTokenDetails({ input_tokens: 6, is_estimated: true });
    const mediaUsage = { image_count: 2, is_estimated: false } as const;

    const result = extractMediaUsageFailSoft({
      extractUsage: () => {
        calls.push("extract");
        throw new Error("untrusted");
      },
      measureRequest: () => {
        calls.push("request");
        return requestDetails;
      },
      measureMedia: () => {
        calls.push("media");
        return mediaUsage;
      },
      logger: recordingLogger().logger,
    });

    expect(calls).toEqual(["extract", "request", "media"]);
    expect(result.tokenDetails).toBe(requestDetails);
    expect(result.mediaUsage).toBe(mediaUsage);
  });

  it("contains request fallback failure and still runs later media measurement", () => {
    const measureMedia = vi.fn(() => null);
    const result = extractMediaUsageFailSoft({
      extractUsage: () => null,
      measureRequest: () => {
        throw new Error("untrusted");
      },
      measureMedia,
      logger: recordingLogger().logger,
    });

    expect(measureMedia).toHaveBeenCalledOnce();
    expect(result).toEqual({ tokenDetails: null, mediaUsage: null });
  });

  it("does not run the request fallback when extraction succeeds but still measures media", () => {
    const details = buildTokenDetails({ input_tokens: 3, output_tokens: 1 });
    const measureRequest = vi.fn(() => null);
    const measureMedia = vi.fn(() => null);

    const result = extractMediaUsageFailSoft({
      extractUsage: () => details,
      measureRequest,
      measureMedia,
      logger: recordingLogger().logger,
    });

    expect(measureRequest).not.toHaveBeenCalled();
    expect(measureMedia).toHaveBeenCalledOnce();
    expect(result).toEqual({ tokenDetails: details, mediaUsage: null });
  });
});

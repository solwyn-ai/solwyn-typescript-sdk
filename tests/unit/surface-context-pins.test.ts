import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../scripts/capture-surface-inventory";
import { DECLARED_SURFACE_CONTEXTS, type SurfaceContext } from "../../src/surfaces";
import { contextContractData } from "../helpers/surface-audit";

const OPENAI: SurfaceContext = {
  provider: "openai",
  dialect: "openai",
  clientShape: "openai_sdk",
};

const PINNED_CONTEXTS = [
  {
    context: { provider: null, dialect: "openai", clientShape: "openai_sdk" },
    digest: "3b6576c4b60101fbdc0424ec18a43848f6a5e34b30154aefd9385d296ff695b8", // 49 rules
    count: 49,
  },
  {
    context: { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
    digest: "ab4b1a63ce7b576154cb24d0def6615c41921e10c45e137aff9924f4057e7931", // 63 rules
    count: 63,
  },
  {
    context: { provider: "azure_openai", dialect: "openai", clientShape: "openai_sdk" },
    digest: "5381844c5db9bea405c64163190f41b002f5102d8758c94709c92a4ad6eb2d03", // 62 rules
    count: 62,
  },
  {
    context: { provider: "together", dialect: "openai", clientShape: "openai_sdk" },
    digest: "3b6576c4b60101fbdc0424ec18a43848f6a5e34b30154aefd9385d296ff695b8", // 49 rules
    count: 49,
  },
  {
    context: { provider: "together", dialect: "openai", clientShape: "native_together" },
    digest: "7125cd6cb2f0c63650ab7de5f65dd626e8a397e544aad95defd78eaea51c9179", // 47 rules
    count: 47,
  },
  {
    context: { provider: "anthropic", dialect: "anthropic", clientShape: "anthropic_sdk" },
    digest: "7ce48d92513fa4312cc2204b46f3bc435712a79856790d5d117a3fedf183a3e2", // 76 rules
    count: 76,
  },
  {
    context: { provider: "google", dialect: "google", clientShape: "google_genai" },
    digest: "83b0686f9805cd1da5ef3acdc38010fec0a49206a25a20b16fcf03dd6290298a", // 43 rules
    count: 43,
  },
  {
    context: {
      provider: "google",
      dialect: "google",
      clientShape: "google_generativeai",
    },
    digest: "fbc4ce8f156f0aa9e7434ed0996eab31b9e08b0797b4f20a64ff8c545175c1bd", // 38 rules
    count: 38,
  },
  {
    context: { provider: "bedrock", dialect: "bedrock", clientShape: "bedrock_v3" },
    digest: "e4c5119e39ea86927aabfa24f729bc0de5b62dc68d6baa58ad505ab60180c1f7", // 42 rules
    count: 42,
  },
] as const satisfies readonly {
  readonly context: SurfaceContext;
  readonly digest: string;
  readonly count: number;
}[];

describe("per-context surface contract data", () => {
  it("includes selector-applicable rules in the stable contract data form", () => {
    const data = contextContractData(OPENAI) as readonly Record<string, unknown>[];

    expect(data).toHaveLength(63);
    expect(
      data.find((row) => row["id"] === "surface.audio-speech-create.unmetered_spend.tts-model"),
    ).toEqual({
      id: "surface.audio-speech-create.unmetered_spend.tts-model",
      surface: "audio.speech.create",
      token: "audio.speech.create:gpt-4o-mini-tts",
      selectors: [
        { provider: "azure_openai", dialect: "openai", client_shape: "openai_sdk" },
        { provider: "openai", dialect: "openai", client_shape: "openai_sdk" },
      ],
      kind: "unmetered_spend",
      source: "synthetic_policy",
      policy_action: "posture",
      dispatch_action: "posture",
      usage_basis: null,
      acknowledgment_token: "audio.speech.create:gpt-4o-mini-tts",
      capability_scope: "operation",
      condition: "openai_untracked_tts_model",
      reason: null,
      expected_attribute_shapes: [
        { descriptor_category: "field", return_shape: "function" },
        { descriptor_category: "method", return_shape: "function" },
      ],
    });
  });

  it("pins the deterministic curated contract for every declared context", () => {
    expect(PINNED_CONTEXTS.map(({ context }) => context)).toEqual(DECLARED_SURFACE_CONTEXTS);
    for (const { context, digest, count } of PINNED_CONTEXTS) {
      const data = contextContractData(context) as readonly unknown[];
      expect(data).toHaveLength(count);
      expect(createHash("sha256").update(canonicalJson(data)).digest("hex")).toBe(digest);
    }
  });
});

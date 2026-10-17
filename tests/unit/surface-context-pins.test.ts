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
    digest: "8eb013188612290a453713886b9966193b598461d901d2c3ee356391e1c217e8", // 49 rules
    count: 49,
  },
  {
    context: { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
    digest: "6d8fc08636e7079b6c3bf0f6ff9da89840f73cbf993093c9a457d8d610591d2d", // 100 rules
    count: 100,
  },
  {
    context: { provider: "azure_openai", dialect: "openai", clientShape: "openai_sdk" },
    digest: "583b31c74e9ae1ec3e5e16df68fae7031c99c974e92749f97248ce9e8ee1d8cd", // 99 rules
    count: 99,
  },
  {
    context: { provider: "together", dialect: "openai", clientShape: "openai_sdk" },
    digest: "8eb013188612290a453713886b9966193b598461d901d2c3ee356391e1c217e8", // 49 rules
    count: 49,
  },
  {
    context: { provider: "together", dialect: "openai", clientShape: "native_together" },
    digest: "fe3bbbac27d5a5c8c0145dc11b64aaf9b5053ae7dd09ff941e39a534ecb768bc", // 59 rules
    count: 59,
  },
  {
    context: { provider: "anthropic", dialect: "anthropic", clientShape: "anthropic_sdk" },
    digest: "30f68fa41850d2ac563fd613c8fb5610a46fd85a9b180abd686412aafc7fc976", // 77 rules
    count: 77,
  },
  {
    context: { provider: "google", dialect: "google", clientShape: "google_genai" },
    digest: "181a8b88f29a38defb73061baab993b6478ede26e5f108f79f41ae3b4475e8ae", // 90 rules
    count: 90,
  },
  {
    context: {
      provider: "google",
      dialect: "google",
      clientShape: "google_generativeai",
    },
    digest: "57c3904e950b26bf9906a52571abcdc64656c1812226249eba0110b54ba390dc", // 38 rules
    count: 38,
  },
  {
    context: { provider: "bedrock", dialect: "bedrock", clientShape: "bedrock_v3" },
    digest: "87f2d6b8b39ef198bf30f78759a0ef5e18483a8d81448a80675936b02aabd124", // 42 rules
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

    expect(data).toHaveLength(100);
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

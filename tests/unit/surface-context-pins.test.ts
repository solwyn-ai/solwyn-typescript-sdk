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
    digest: "2bbdb0a80159ee72821e92b85e8fcf1c22a3d394f0d06643f794f4bf9a3cce0e", // 49 rules
    count: 49,
  },
  {
    context: { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
    digest: "64c3617e2e074597b34d36aeb7bd19f67fd08ef2ebc95ba1459de188c31fdb0f", // 100 rules
    count: 100,
  },
  {
    context: { provider: "azure_openai", dialect: "openai", clientShape: "openai_sdk" },
    digest: "c3ba73238c888bf8d12febe2af6a96f63d756cf72fd91405e87f6cd019f45a01", // 99 rules
    count: 99,
  },
  {
    context: { provider: "together", dialect: "openai", clientShape: "openai_sdk" },
    digest: "2bbdb0a80159ee72821e92b85e8fcf1c22a3d394f0d06643f794f4bf9a3cce0e", // 49 rules
    count: 49,
  },
  {
    context: { provider: "together", dialect: "openai", clientShape: "native_together" },
    digest: "2e0345b53bfcd56aa7a4b4d600d209a49bc6f4cc76121bdc6373deeac4cd59c9", // 59 rules
    count: 59,
  },
  {
    context: { provider: "anthropic", dialect: "anthropic", clientShape: "anthropic_sdk" },
    digest: "a52d02879b19a3be4111c199c8a518a9c69a8e64f2a3e71a3f90ba7ea114a2d0", // 77 rules
    count: 77,
  },
  {
    context: { provider: "google", dialect: "google", clientShape: "google_genai" },
    digest: "ac5f7bc6809c988957b0c3b8433300b9178f62a39aefde53fdd5b1d2e08d7f4d", // 101 rules
    count: 101,
  },
  {
    context: {
      provider: "google",
      dialect: "google",
      clientShape: "google_generativeai",
    },
    digest: "5ac00cbbc9599d3267654dac853650026a2f6aa3b31c3136db3d2ed44a97753b", // 38 rules
    count: 38,
  },
  {
    context: { provider: "bedrock", dialect: "bedrock", clientShape: "bedrock_v3" },
    digest: "ec2244e35bacabce9d7788dcc9d6d846528afaa2d782e49b92b6448664661918", // 42 rules
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

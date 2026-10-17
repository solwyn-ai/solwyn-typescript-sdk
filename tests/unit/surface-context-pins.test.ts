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
    digest: "3834b95553047914a73d5e70187658a135f6a10ef3f6a5f84e356646bad70eda", // 117 rules
    count: 117,
  },
  {
    context: { provider: "azure_openai", dialect: "openai", clientShape: "openai_sdk" },
    digest: "da92f4e8f28d90b405c91c612bcb4701c972a693c31fcc219e1d053ad891c29e", // 116 rules
    count: 116,
  },
  {
    context: { provider: "together", dialect: "openai", clientShape: "openai_sdk" },
    digest: "2bbdb0a80159ee72821e92b85e8fcf1c22a3d394f0d06643f794f4bf9a3cce0e", // 49 rules
    count: 49,
  },
  {
    context: { provider: "together", dialect: "openai", clientShape: "native_together" },
    digest: "0a1e92c3cac0c9dd5af7ac02d4045bba0a51f71b9afae20782228cf9ce996c56", // 74 rules
    count: 74,
  },
  {
    context: { provider: "anthropic", dialect: "anthropic", clientShape: "anthropic_sdk" },
    digest: "c0fe7741e4f1e172157b5856698992fa4329bd1fddf9da5949fa47583788e247", // 92 rules
    count: 92,
  },
  {
    context: { provider: "google", dialect: "google", clientShape: "google_genai" },
    digest: "05ddefc7992f0c73f6d202b7cb6cf78315f93a1e9c55161c0fbc43305d29800b", // 233 rules
    count: 233,
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
    digest: "6c1c5c2e68f511abd15ee9f5ece9155a30388a4cff86fc5a2e8e1c6fa9a5a3a7", // 43 rules
    count: 43,
  },
] as const satisfies readonly {
  readonly context: SurfaceContext;
  readonly digest: string;
  readonly count: number;
}[];

describe("per-context surface contract data", () => {
  it("includes selector-applicable rules in the stable contract data form", () => {
    const data = contextContractData(OPENAI) as readonly Record<string, unknown>[];

    expect(data).toHaveLength(117);
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

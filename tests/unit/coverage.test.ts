import { describe, expect, it, vi } from "vitest";
import {
  COVERAGE_CATEGORIES,
  type CoverageAuditEntry,
  type CoverageCategory,
  type CoverageEntry,
  type CoverageExpectation,
  type CoverageFingerprint,
  type CoverageReport,
  type CoverageRuntime,
  coverage,
  registerCoverageSource,
} from "../../src/coverage";
import { CoverageMismatchError } from "../../src/errors";
import { Solwyn } from "../../src/proxies";
import { SurfaceInspectionError } from "../../src/surface-graph";
import type { SurfaceClientShape, SurfaceDialect } from "../../src/surfaces";

function operationMustNotRun(): never {
  throw new Error("coverage must never invoke provider operations");
}

function requireFixtureValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("invalid coverage test fixture");
  return value;
}

function openAiShapedClient(): object {
  return {
    chat: { completions: { create: operationMustNotRun } },
    responses: {
      create: operationMustNotRun,
      parse: operationMustNotRun,
      stream: operationMustNotRun,
    },
    embeddings: { create: operationMustNotRun },
    images: { generate: operationMustNotRun, edit: operationMustNotRun },
    audio: {
      transcriptions: { create: operationMustNotRun },
      speech: { create: operationMustNotRun },
      translations: {},
    },
    videos: { create: operationMustNotRun },
  };
}

function undeclaredReport(
  rawClient: object = {},
  posture: "warn" | "raise" | "allow" = "warn",
): CoverageReport {
  const wrapper = {};
  registerCoverageSource(wrapper, {
    rawClient,
    context: { provider: "custom", dialect: "openai", clientShape: "undeclared_sdk" },
    providerChain: [
      {
        provider: "custom",
        dialect: "openai",
        clientShape: "undeclared_sdk",
        model: "custom-model",
      },
    ],
    posture,
    acknowledgments: [],
  });
  return coverage(wrapper);
}

function emptyExpectation(): Record<keyof CoverageExpectation, CoverageAuditEntry[]> {
  return {
    conditional: [],
    guarded_namespaces: [],
    tracked: [],
    unknown: [],
    blocked: [],
    unsupported: [],
    safe: [],
    scoped_escapes: [],
    untracked: [],
  };
}

function categoryForTest(entry: CoverageEntry): CoverageCategory {
  if (entry.condition !== null) return "conditional";
  if (entry.kind === "namespace") return "guarded_namespaces";
  if (entry.kind === "metered") return "tracked";
  if (entry.kind === "unknown") return "unknown";
  if (entry.kind === "blocked") return "blocked";
  if (entry.kind === "unsupported") return "unsupported";
  if (entry.kind === "metadata" || entry.kind === "infrastructure") return "safe";
  if (entry.capabilityScope !== null && entry.capabilityScope !== "operation") {
    return "scoped_escapes";
  }
  return "untracked";
}

function literalForReport(report: CoverageReport): CoverageExpectation {
  const expectation = emptyExpectation();
  for (const entry of report.entries) {
    expectation[categoryForTest(entry)].push({ ...entry });
  }
  return expectation;
}

function registeredReport(
  rawClient: object,
  context: {
    provider: string | null;
    dialect: SurfaceDialect;
    clientShape: SurfaceClientShape;
  },
  providerChain: Array<{
    provider: string;
    dialect: SurfaceDialect;
    clientShape: SurfaceClientShape;
    model: string;
  }>,
  posture: "warn" | "raise" | "allow" = "warn",
  acknowledgments: string[] = [],
): CoverageReport {
  const wrapper = {};
  registerCoverageSource(wrapper, {
    rawClient,
    context,
    providerChain,
    posture,
    acknowledgments,
  });
  return coverage(wrapper);
}

describe("coverage", () => {
  it("rejects an unregistered object with the exact data-free TypeError", () => {
    expect(() => coverage({})).toThrowError(
      new TypeError("coverage requires a registered Solwyn wrapper"),
    );
  });

  it("publishes the nine frozen categories in their binding order", () => {
    expect(COVERAGE_CATEGORIES).toEqual([
      "conditional",
      "guarded_namespaces",
      "tracked",
      "unknown",
      "blocked",
      "unsupported",
      "safe",
      "scoped_escapes",
      "untracked",
    ]);
    expect(Object.isFrozen(COVERAGE_CATEGORIES)).toBe(true);
  });

  it("reports the nested Anthropic beta skills download as an untracked operation without invoking it", () => {
    const download = vi.fn(operationMustNotRun);
    const report = registeredReport(
      {
        messages: {},
        files: {},
        skills: { versions: {} },
        beta: {
          files: {},
          skills: { versions: { download } },
        },
      },
      { provider: "anthropic", dialect: "anthropic", clientShape: "anthropic_sdk" },
      [
        {
          provider: "anthropic",
          dialect: "anthropic",
          clientShape: "anthropic_sdk",
          model: "claude-sonnet-4",
        },
      ],
    );

    expect(literalForReport(report).untracked).toContainEqual(
      expect.objectContaining({
        surface: "beta.skills.versions.download",
        token: "beta.skills.versions.download",
        kind: "unmetered_spend",
        source: "raw",
        capabilityScope: "operation",
      }),
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("detaches registration inputs and projects reviewed Bedrock command classes", () => {
    const wrapper = {};
    const rawClient = {};
    const context: {
      provider: string | null;
      dialect: SurfaceDialect;
      clientShape: SurfaceClientShape;
    } = {
      provider: "bedrock",
      dialect: "bedrock",
      clientShape: "bedrock_v3",
    };
    const providerChain: Array<{
      provider: string;
      dialect: SurfaceDialect;
      clientShape: SurfaceClientShape;
      model: string;
    }> = [
      {
        provider: "bedrock",
        dialect: "bedrock",
        clientShape: "bedrock_v3",
        model: "anthropic.claude-3",
      },
    ];
    const acknowledgments = ["zeta.operation", "alpha.operation", "zeta.operation"];

    registerCoverageSource(wrapper, {
      rawClient,
      context,
      providerChain,
      posture: "raise",
      acknowledgments,
    });
    context.provider = "changed";
    context.dialect = "openai";
    const mutablePrimary = requireFixtureValue(providerChain[0]);
    mutablePrimary.provider = "changed";
    mutablePrimary.model = "changed";
    acknowledgments.push("later.operation");

    const report = coverage(wrapper);
    expect(report).toMatchObject({
      provider: "bedrock",
      dialect: "bedrock",
      clientShape: "bedrock_v3",
      posture: "raise",
      acknowledgments: ["alpha.operation", "zeta.operation"],
      providerChain: [
        {
          provider: "bedrock",
          dialect: "bedrock",
          clientShape: "bedrock_v3",
          model: "anthropic.claude-3",
        },
      ],
    });
    expect(report.entries.find((entry) => entry.surface === "ConverseCommand")).toEqual({
      ruleId: "surface.converse-command.metered",
      surface: "ConverseCommand",
      token: "ConverseCommand",
      kind: "metered",
      policyAction: "track",
      dispatchAction: "intercept",
      usageBasis: "provider",
      source: "both",
      capabilityScope: null,
      condition: null,
      reason: null,
      expectedDescriptorCategory: "command_class",
      observedDescriptorCategory: "command_class",
      expectedReturnShape: "command_class",
      observedReturnShape: "command_class",
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.providerChain)).toBe(true);
    expect(Object.isFrozen(report.providerChain[0])).toBe(true);
    expect(Object.isFrozen(report.acknowledgments)).toBe(true);
    expect(Object.isFrozen(report.entries)).toBe(true);
    expect(report.entries.every(Object.isFrozen)).toBe(true);
  });

  it("rejects malformed registrations before retaining a source", () => {
    const validSource = {
      rawClient: {},
      context: {
        provider: "openai",
        dialect: "openai" as const,
        clientShape: "openai_sdk" as const,
      },
      providerChain: [
        {
          provider: "openai",
          dialect: "openai" as const,
          clientShape: "openai_sdk" as const,
          model: "gpt-5",
        },
      ],
      posture: "warn" as const,
      acknowledgments: [],
    };

    expect(() => registerCoverageSource(null as unknown as object, validSource)).toThrowError(
      TypeError,
    );
    expect(() =>
      registerCoverageSource({}, { ...validSource, rawClient: null as unknown as object }),
    ).toThrowError(TypeError);
    expect(() => registerCoverageSource({}, { ...validSource, providerChain: [] })).toThrowError(
      TypeError,
    );
    expect(() =>
      registerCoverageSource(
        {},
        {
          ...validSource,
          providerChain: [
            {
              ...requireFixtureValue(validSource.providerChain[0]),
              model: null as unknown as string,
            },
          ],
        },
      ),
    ).toThrowError(TypeError);
    expect(() =>
      registerCoverageSource(
        {},
        {
          ...validSource,
          providerChain: [
            {
              ...requireFixtureValue(validSource.providerChain[0]),
              clientShape: "native_together" as const,
            },
          ],
        },
      ),
    ).toThrowError(TypeError);
    const perCallModelWrapper = {};
    registerCoverageSource(perCallModelWrapper, {
      ...validSource,
      rawClient: openAiShapedClient(),
      providerChain: [{ ...requireFixtureValue(validSource.providerChain[0]), model: "" }],
    });
    expect(coverage(perCallModelWrapper).providerChain[0]?.model).toBe("");
  });

  it.each([
    "OpenAI",
    "bad-provider",
    "bad provider",
    `${"a".repeat(129)}`,
  ])("rejects unsafe provider label %j before it can enter a synthetic id", (provider) => {
    let caught: unknown;
    try {
      registerCoverageSource(
        {},
        {
          rawClient: { novelOperation: operationMustNotRun },
          context: { provider, dialect: "openai", clientShape: "undeclared_sdk" },
          providerChain: [
            {
              provider,
              dialect: "openai",
              clientShape: "undeclared_sdk",
              model: "custom-model",
            },
          ],
          posture: "warn",
          acknowledgments: [],
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe("invalid coverage source");
    expect((caught as Error).message).not.toContain(provider);
  });

  it("rejects impossible known-shape fallback runtimes but permits undeclared shapes", () => {
    const base = {
      rawClient: openAiShapedClient(),
      context: {
        provider: "openai",
        dialect: "openai" as const,
        clientShape: "openai_sdk" as const,
      },
      posture: "warn" as const,
      acknowledgments: [],
    };
    const primary = {
      provider: "openai",
      dialect: "openai" as const,
      clientShape: "openai_sdk" as const,
      model: "gpt-5",
    };

    expect(() =>
      registerCoverageSource(
        {},
        {
          ...base,
          providerChain: [
            primary,
            {
              provider: "openai",
              dialect: "anthropic",
              clientShape: "anthropic_sdk",
              model: "impossible",
            },
          ],
        },
      ),
    ).toThrowError(new TypeError("invalid coverage source"));

    const wrapper = {};
    expect(() =>
      registerCoverageSource(wrapper, {
        ...base,
        providerChain: [
          primary,
          {
            provider: "custom",
            dialect: "anthropic",
            clientShape: "undeclared_sdk",
            model: "custom-model",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("normalizes a null primary provider before native-versus-compatible resolution", () => {
    const native = registeredReport(
      openAiShapedClient(),
      { provider: null, dialect: "openai", clientShape: "openai_sdk" },
      [
        {
          provider: "openai",
          dialect: "openai",
          clientShape: "openai_sdk",
          model: "gpt-5",
        },
      ],
    );
    expect(native.entries.find((entry) => entry.surface === "responses.create")).toMatchObject({
      kind: "metered",
      usageBasis: "provider",
    });

    const compatible = registeredReport(
      openAiShapedClient(),
      { provider: null, dialect: "openai", clientShape: "openai_sdk" },
      [
        {
          provider: "groq",
          dialect: "openai",
          clientShape: "openai_sdk",
          model: "llama-3.3-70b",
        },
      ],
      "allow",
    );
    expect(compatible.entries.find((entry) => entry.surface === "responses.create")).toMatchObject({
      kind: "unmetered_spend",
      policyAction: "allow",
    });
  });

  it("conservatively upgrades chat usage for a reachable undeclared fallback", () => {
    const report = registeredReport(
      openAiShapedClient(),
      { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
      [
        {
          provider: "openai",
          dialect: "openai",
          clientShape: "openai_sdk",
          model: "gpt-5",
        },
        {
          provider: "custom",
          dialect: "anthropic",
          clientShape: "undeclared_sdk",
          model: "custom-model",
        },
      ],
    );

    expect(
      report.entries.find((entry) => entry.surface === "chat.completions.create"),
    ).toMatchObject({ usageBasis: "provider_or_estimate" });
    expect(
      report.entries.find(
        (entry) => entry.surface === "chat.completions.create" && entry.source === "wrapper",
      ),
    ).toMatchObject({ usageBasis: "provider_or_estimate" });
  });

  it.each<{
    surface: string;
    rawClient: object;
    primary: CoverageRuntime;
  }>([
    {
      surface: "chat.completions.create",
      rawClient: { chat: { completions: { create: operationMustNotRun } } },
      primary: {
        provider: "openai",
        dialect: "openai",
        clientShape: "openai_sdk",
        model: "gpt-5",
      },
    },
    {
      surface: "messages.create",
      rawClient: { messages: { create: operationMustNotRun } },
      primary: {
        provider: "anthropic",
        dialect: "anthropic",
        clientShape: "anthropic_sdk",
        model: "claude-sonnet-4",
      },
    },
    {
      surface: "models.generateContent",
      rawClient: { models: { generateContent: operationMustNotRun } },
      primary: {
        provider: "google",
        dialect: "google",
        clientShape: "google_genai",
        model: "gemini-2.5-pro",
      },
    },
    {
      surface: "models.generateContentStream",
      rawClient: { models: { generateContentStream: operationMustNotRun } },
      primary: {
        provider: "google",
        dialect: "google",
        clientShape: "google_genai",
        model: "gemini-2.5-pro",
      },
    },
    {
      surface: "generateContent",
      rawClient: { generateContent: operationMustNotRun },
      primary: {
        provider: "google",
        dialect: "google",
        clientShape: "google_generativeai",
        model: "gemini-2.5-pro",
      },
    },
    {
      surface: "ConverseCommand",
      rawClient: {},
      primary: {
        provider: "bedrock",
        dialect: "bedrock",
        clientShape: "bedrock_v3",
        model: "anthropic.claude-3",
      },
    },
    {
      surface: "ConverseStreamCommand",
      rawClient: {},
      primary: {
        provider: "bedrock",
        dialect: "bedrock",
        clientShape: "bedrock_v3",
        model: "anthropic.claude-3",
      },
    },
  ])("aggregates reachable fallback estimates for $surface", ({ surface, rawClient, primary }) => {
    const nativeOnly = registeredReport(rawClient, primary, [primary]);
    expect(nativeOnly.entries.find((entry) => entry.surface === surface)).toMatchObject({
      kind: "metered",
      usageBasis: "provider",
    });

    const fallbacks: CoverageRuntime[] = [
      {
        provider: "groq",
        dialect: "openai",
        clientShape: "openai_sdk",
        model: "llama-3.3-70b",
      },
      {
        provider: "custom",
        dialect: "openai",
        clientShape: "undeclared_sdk",
        model: "custom-model",
      },
    ];
    for (const fallback of fallbacks) {
      const report = registeredReport(rawClient, primary, [primary, fallback]);
      expect(report.entries.find((entry) => entry.surface === surface)).toMatchObject({
        kind: "metered",
        usageBasis: "provider_or_estimate",
      });
      expect(
        report.entries.find(
          (entry) => entry.surface === "chat.completions.create" && entry.source === "wrapper",
        ),
      ).toMatchObject({ usageBasis: "provider_or_estimate" });
    }
  });

  it("reports native Together chat usage as provider-or-estimate", () => {
    const primary: CoverageRuntime = {
      provider: "together",
      dialect: "openai",
      clientShape: "native_together",
      model: "meta-llama/Llama-3",
    };
    const report = registeredReport(
      { chat: { completions: { create: operationMustNotRun } } },
      primary,
      [primary],
    );
    const entries = report.entries.filter((entry) => entry.surface === "chat.completions.create");

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.usageBasis === "provider_or_estimate")).toBe(true);
  });

  it("uses the primary runtime provider for a generic context and overwrites registration", () => {
    const wrapper = {};
    registerCoverageSource(wrapper, {
      rawClient: openAiShapedClient(),
      context: { provider: null, dialect: "openai", clientShape: "openai_sdk" },
      providerChain: [
        {
          provider: "groq",
          dialect: "openai",
          clientShape: "openai_sdk",
          model: "llama-3.3-70b",
        },
      ],
      posture: "warn",
      acknowledgments: [],
    });
    expect(coverage(wrapper).provider).toBe("groq");

    registerCoverageSource(wrapper, {
      rawClient: {},
      context: { provider: "custom", dialect: "openai", clientShape: "undeclared_sdk" },
      providerChain: [
        {
          provider: "custom",
          dialect: "openai",
          clientShape: "undeclared_sdk",
          model: "replacement-model",
        },
      ],
      posture: "allow",
      acknowledgments: ["zeta", "alpha"],
    });
    expect(coverage(wrapper)).toMatchObject({
      provider: "custom",
      clientShape: "undeclared_sdk",
      posture: "allow",
      acknowledgments: ["alpha", "zeta"],
      entries: [],
    });
  });

  it("observes structure without calling operations or non-namespace getters", () => {
    let getterEvaluations = 0;
    const rawClient = {
      completions: {},
      novelOperation: operationMustNotRun,
      timeout: operationMustNotRun,
      get baseURL(): string {
        getterEvaluations += 1;
        throw new Error("PRIVATE_DESCRIPTOR_CONTENT");
      },
    };
    const wrapper = {};
    registerCoverageSource(wrapper, {
      rawClient,
      context: {
        provider: "together",
        dialect: "openai",
        clientShape: "native_together",
      },
      providerChain: [
        {
          provider: "together",
          dialect: "openai",
          clientShape: "native_together",
          model: "meta-llama/Llama-3",
        },
      ],
      posture: "raise",
      acknowledgments: ["completions.child"],
    });

    const report = coverage(wrapper);
    expect(getterEvaluations).toBe(0);
    expect(report.entries.find((entry) => entry.surface === "novelOperation")).toMatchObject({
      ruleId: "unknown:native_together:together:novelOperation",
      token: "novelOperation",
      kind: "unknown",
      policyAction: "raise",
      dispatchAction: "refuse",
      usageBasis: null,
      source: "raw",
      capabilityScope: null,
      condition: null,
      reason: null,
      expectedDescriptorCategory: null,
      observedDescriptorCategory: "method",
      expectedReturnShape: null,
      observedReturnShape: "function",
    });
    expect(report.entries.find((entry) => entry.surface === "completions")).toMatchObject({
      kind: "unmetered_spend",
      policyAction: "acknowledged",
      dispatchAction: "guard",
      capabilityScope: "resource",
    });
    expect(report.entries.find((entry) => entry.surface === "baseURL")).toMatchObject({
      kind: "metadata",
      policyAction: "pass",
      dispatchAction: "return",
      observedDescriptorCategory: "getter",
      observedReturnShape: "unevaluated_accessor",
      expectedDescriptorCategory: "getter",
      expectedReturnShape: "unevaluated_accessor",
    });
    expect(report.entries.find((entry) => entry.surface === "timeout")).toMatchObject({
      ruleId: "surface.timeout.infrastructure.raw",
      kind: "unknown",
      token: "timeout",
      usageBasis: null,
      capabilityScope: null,
      expectedDescriptorCategory: "field",
      observedDescriptorCategory: "method",
      expectedReturnShape: "scalar",
      observedReturnShape: "function",
    });
    expect(report.entries.find((entry) => entry.surface === "close")).toMatchObject({
      kind: "infrastructure",
      source: "wrapper",
      policyAction: "pass",
      dispatchAction: "return",
    });
  });

  it("distinguishes native and compatible Responses and aggregates failover usage basis", () => {
    const nativeWrapper = {};
    registerCoverageSource(nativeWrapper, {
      rawClient: openAiShapedClient(),
      context: { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
      providerChain: [
        {
          provider: "openai",
          dialect: "openai",
          clientShape: "openai_sdk",
          model: "gpt-5",
        },
        {
          provider: "groq",
          dialect: "openai",
          clientShape: "openai_sdk",
          model: "llama-3.3-70b",
        },
      ],
      posture: "warn",
      acknowledgments: [],
    });
    const native = coverage(nativeWrapper);
    expect(native.entries.find((entry) => entry.surface === "responses.create")).toMatchObject({
      kind: "metered",
      policyAction: "track",
      dispatchAction: "intercept",
      usageBasis: "provider",
    });
    expect(
      native.entries.find((entry) => entry.surface === "chat.completions.create"),
    ).toMatchObject({ kind: "metered", usageBasis: "provider_or_estimate" });
    expect(
      native.entries.find(
        (entry) => entry.surface === "chat.completions.create" && entry.source === "wrapper",
      ),
    ).toMatchObject({ kind: "metered", usageBasis: "provider_or_estimate" });
    expect(
      native.entries.find(
        (entry) => entry.surface === "audio.speech.create" && entry.source === "synthetic_policy",
      ),
    ).toMatchObject({
      kind: "unmetered_spend",
      condition: "openai_untracked_tts_model",
      policyAction: "warn",
      dispatchAction: "return",
    });
    expect(native.entries.find((entry) => entry.surface === "close")).toMatchObject({
      source: "wrapper",
      kind: "infrastructure",
    });
    expect(new Set(native.entries.map((entry) => entry.ruleId)).size).toBe(native.entries.length);

    const compatibleWrapper = {};
    registerCoverageSource(compatibleWrapper, {
      rawClient: openAiShapedClient(),
      context: { provider: "groq", dialect: "openai", clientShape: "openai_sdk" },
      providerChain: [
        {
          provider: "groq",
          dialect: "openai",
          clientShape: "openai_sdk",
          model: "llama-3.3-70b",
        },
      ],
      posture: "allow",
      acknowledgments: [],
    });
    expect(
      coverage(compatibleWrapper).entries.find((entry) => entry.surface === "responses.create"),
    ).toMatchObject({
      kind: "unmetered_spend",
      policyAction: "allow",
      dispatchAction: "return",
      capabilityScope: "operation",
    });
  });

  it("hashes every empty category with the standard SHA-256 digest of compact []", () => {
    const report = undeclaredReport();
    const fingerprint = report.fingerprint();
    const emptyDigest = "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

    expect(Object.keys(fingerprint)).toEqual(COVERAGE_CATEGORIES);
    expect(fingerprint).toEqual({
      conditional: emptyDigest,
      guarded_namespaces: emptyDigest,
      tracked: emptyDigest,
      unknown: emptyDigest,
      blocked: emptyDigest,
      unsupported: emptyDigest,
      safe: emptyDigest,
      scoped_escapes: emptyDigest,
      untracked: emptyDigest,
    });
    expect(Object.isFrozen(fingerprint)).toBe(true);
    const next = report.fingerprint();
    expect(next).toEqual(fingerprint);
    expect(next).not.toBe(fingerprint);
  });

  it("canonicalizes every explicit null and object key before hashing audit entries", () => {
    const fingerprint = undeclaredReport({ novelOperation: operationMustNotRun }).fingerprint();
    expect(fingerprint.unknown).toBe(
      "sha256:739230fe589b22eaa647a825a6b6d09dde706e556081abbb22927035e388f7bd",
    );
  });

  it("matches a detached literal regardless of audit-entry object insertion order", () => {
    const report = undeclaredReport({ novelOperation: operationMustNotRun });
    const actual = requireFixtureValue(report.entries[0]);
    const reversed = Object.fromEntries(Object.entries(actual).reverse()) as CoverageAuditEntry;
    const expected = emptyExpectation();
    expected.unknown.push(reversed);

    expect(report.expect(expected)).toBeUndefined();
    expect(Object.isFrozen(expected)).toBe(false);
    expect(Object.isFrozen(expected.unknown)).toBe(false);
    expect(Object.isFrozen(reversed)).toBe(false);
  });

  it("reports one exact bidirectional literal difference per category", () => {
    const report = undeclaredReport({
      novelA: operationMustNotRun,
      novelB: operationMustNotRun,
    });
    const novelA = requireFixtureValue(report.entries.find((entry) => entry.surface === "novelA"));
    const expected = emptyExpectation();
    expected.unknown.push(
      { ...novelA, policyAction: "allow" },
      {
        ...novelA,
        ruleId: "unknown:undeclared_sdk:custom:novelC",
        surface: "novelC",
        token: "novelC",
      },
    );

    let caught: unknown;
    try {
      report.expect(expected);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CoverageMismatchError);
    expect(caught).toMatchObject({
      differences: [
        "unknown: expected 2 entries, got 2, " +
          "missing [unknown:undeclared_sdk:custom:novelC], " +
          "changed [unknown:undeclared_sdk:custom:novelA], " +
          "unexpected [unknown:undeclared_sdk:custom:novelB]",
      ],
    });
  });

  it("compares all nine fingerprint categories in order and includes actual counts", () => {
    const report = undeclaredReport({ novelOperation: operationMustNotRun });
    const actual = report.fingerprint();
    expect(report.expect(actual)).toBeUndefined();

    const zeros = `sha256:${"0".repeat(64)}` as const;
    const ones = `sha256:${"1".repeat(64)}` as const;
    const expected: CoverageFingerprint = {
      ...actual,
      conditional: zeros,
      untracked: ones,
    };

    let caught: unknown;
    try {
      report.expect(expected);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CoverageMismatchError);
    expect(caught).toMatchObject({
      differences: [
        `conditional: fingerprint mismatch (expected ${zeros}, got ${actual.conditional}, entries 0)`,
        `untracked: fingerprint mismatch (expected ${ones}, got ${actual.untracked}, entries 0)`,
      ],
    });
  });

  it("rejects malformed and duplicate literal expectations without freezing the caller", () => {
    const report = undeclaredReport({ novelOperation: operationMustNotRun });
    const entry = requireFixtureValue(report.entries[0]);
    const duplicate = emptyExpectation();
    duplicate.conditional.push(entry);
    duplicate.unknown.push(entry);

    expect(() => report.expect(duplicate)).toThrowError(
      new TypeError("invalid coverage expectation"),
    );
    expect(Object.isFrozen(duplicate)).toBe(false);
    expect(Object.isFrozen(duplicate.conditional)).toBe(false);

    const mixed = { ...report.fingerprint(), tracked: [] } as unknown as CoverageFingerprint;
    expect(() => report.expect(mixed)).toThrowError(new TypeError("invalid coverage expectation"));
    const { safe: _safe, ...missingCategory } = report.fingerprint();
    expect(() => report.expect(missingCategory as CoverageFingerprint)).toThrowError(
      new TypeError("invalid coverage expectation"),
    );
  });

  it("classifies all nine categories in binding order across representative runtimes", () => {
    const openAiRaw = { ...openAiShapedClient(), novelOpenAi: operationMustNotRun, timeout: 30 };
    const openAi = registeredReport(
      openAiRaw,
      { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
      [
        {
          provider: "openai",
          dialect: "openai",
          clientShape: "openai_sdk",
          model: "gpt-5",
        },
      ],
    );
    const bedrock = registeredReport(
      { novelBedrock: operationMustNotRun, timeout: 30 },
      { provider: "bedrock", dialect: "bedrock", clientShape: "bedrock_v3" },
      [
        {
          provider: "bedrock",
          dialect: "bedrock",
          clientShape: "bedrock_v3",
          model: "anthropic.claude-3",
        },
      ],
    );
    const compatible = registeredReport(
      openAiShapedClient(),
      { provider: "groq", dialect: "openai", clientShape: "openai_sdk" },
      [
        {
          provider: "groq",
          dialect: "openai",
          clientShape: "openai_sdk",
          model: "llama-3.3-70b",
        },
      ],
      "allow",
    );

    const populated = new Set<CoverageCategory>();
    for (const report of [openAi, bedrock, compatible]) {
      const expected = literalForReport(report);
      expect(report.expect(expected)).toBeUndefined();
      for (const category of COVERAGE_CATEGORIES) {
        if (expected[category].length > 0) populated.add(category);
      }
    }
    expect([...populated].sort()).toEqual([...COVERAGE_CATEGORIES].sort());

    expect(bedrock.entries.find((entry) => entry.surface === "InvokeModelCommand")).toMatchObject({
      kind: "blocked",
      policyAction: "block",
      dispatchAction: "refuse",
    });
    expect(
      bedrock.entries.find(
        (entry) => entry.surface === "embeddings.create" && entry.source === "wrapper",
      ),
    ).toMatchObject({
      kind: "unsupported",
      policyAction: "unsupported",
      dispatchAction: "refuse",
    });
  });

  it("keeps reports independent and freezes every newly allocated public layer", () => {
    const rawClient = { novelOperation: operationMustNotRun };
    const wrapper = {};
    registerCoverageSource(wrapper, {
      rawClient,
      context: { provider: "custom", dialect: "openai", clientShape: "undeclared_sdk" },
      providerChain: [
        {
          provider: "custom",
          dialect: "openai",
          clientShape: "undeclared_sdk",
          model: "custom-model",
        },
      ],
      posture: "warn",
      acknowledgments: ["novelOperation"],
    });

    const first = coverage(wrapper);
    const second = coverage(wrapper);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.providerChain).not.toBe(second.providerChain);
    expect(first.providerChain[0]).not.toBe(second.providerChain[0]);
    expect(first.acknowledgments).not.toBe(second.acknowledgments);
    expect(first.entries).not.toBe(second.entries);
    expect(first.entries[0]).not.toBe(second.entries[0]);
    expect(Reflect.set(requireFixtureValue(first.entries[0]), "surface", "changed")).toBe(false);
    expect(Reflect.set(requireFixtureValue(first.providerChain[0]), "model", "changed")).toBe(
      false,
    );
    expect(Reflect.set(first.fingerprint(), "unknown", `sha256:${"0".repeat(64)}`)).toBe(false);
    expect(second.entries[0]?.surface).toBe("novelOperation");
    expect(Object.isFrozen(rawClient)).toBe(false);
  });

  it("keeps an exactly acknowledged resource guarded", () => {
    const exact = registeredReport(
      { completions: {} },
      { provider: "together", dialect: "openai", clientShape: "native_together" },
      [
        {
          provider: "together",
          dialect: "openai",
          clientShape: "native_together",
          model: "meta-llama/Llama-3",
        },
      ],
      "raise",
      ["completions"],
    );
    expect(exact.entries.find((entry) => entry.surface === "completions")).toMatchObject({
      policyAction: "acknowledged",
      dispatchAction: "guard",
    });
  });

  it.each([
    "raise",
    "warn",
    "allow",
  ] as const)("uses %s posture instead of acknowledgment for a drifted known surface", (posture) => {
    const report = registeredReport(
      { completions: () => undefined },
      { provider: "together", dialect: "openai", clientShape: "native_together" },
      [
        {
          provider: "together",
          dialect: "openai",
          clientShape: "native_together",
          model: "meta-llama/Llama-3",
        },
      ],
      posture,
      ["completions"],
    );

    expect(report.entries.find((entry) => entry.surface === "completions")).toMatchObject({
      kind: "unknown",
      capabilityScope: null,
      policyAction: posture,
    });
  });

  it("uses posture-based resource guards", () => {
    const warning = undeclaredReport({ futureResource: {} }, "warn");
    expect(warning.entries[0]).toMatchObject({
      kind: "unknown",
      policyAction: "warn",
      dispatchAction: "guard",
    });
  });

  it.each([
    {
      provider: "openai",
      rawClient: { chat: { completions: { create: operationMustNotRun } } },
      surface: "chat.completions.create",
    },
    {
      provider: "anthropic",
      rawClient: { messages: { create: operationMustNotRun }, skills: {} },
      surface: "messages.create",
    },
  ])("reports constructor-accepted partial $provider graphs", async ({ rawClient, surface }) => {
    const wrapper = new Solwyn(rawClient, {
      apiKey: `sk_proj_${"a".repeat(64)}`,
      model: "test-model",
      fetch: operationMustNotRun,
    });
    try {
      const report = coverage(wrapper);
      expect(report.entries.find((entry) => entry.surface === surface)).toMatchObject({
        kind: "metered",
        policyAction: "track",
        usageBasis: "provider",
      });
      expect(report.entries.some((entry) => entry.surface === "skills.versions")).toBe(false);
    } finally {
      await wrapper.close();
    }
  });

  it("propagates sanitized observer failures without evaluating provider operations", () => {
    const rawClient = openAiShapedClient();
    Object.defineProperty(rawClient, "chat", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE_DESCRIPTOR_CONTENT");
      },
    });
    const throwingWrapper = {};
    registerCoverageSource(throwingWrapper, {
      rawClient,
      context: { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
      providerChain: [
        {
          provider: "openai",
          dialect: "openai",
          clientShape: "openai_sdk",
          model: "gpt-5",
        },
      ],
      posture: "warn",
      acknowledgments: [],
    });
    let caught: unknown;
    try {
      coverage(throwingWrapper);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SurfaceInspectionError);
    expect(caught).toMatchObject({ path: "chat", stage: "namespace_evaluation" });
    expect(String(caught)).not.toContain("PRIVATE_DESCRIPTOR_CONTENT");

    const cyclicRaw = openAiShapedClient() as Record<string, unknown>;
    cyclicRaw["chat"] = cyclicRaw;
    const cyclicWrapper = {};
    registerCoverageSource(cyclicWrapper, {
      rawClient: cyclicRaw,
      context: { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
      providerChain: [
        {
          provider: "openai",
          dialect: "openai",
          clientShape: "openai_sdk",
          model: "gpt-5",
        },
      ],
      posture: "warn",
      acknowledgments: [],
    });
    let cyclic: unknown;
    try {
      coverage(cyclicWrapper);
    } catch (error) {
      cyclic = error;
    }
    expect(cyclic).toBeInstanceOf(SurfaceInspectionError);
    expect(cyclic).toMatchObject({ path: "chat", stage: "cycle" });
  });
});

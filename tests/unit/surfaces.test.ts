import { describe, expect, it, vi } from "vitest";
import { COMPAT_PROFILES } from "../../src/providers/detection";
import {
  CAPABILITY_SCOPES,
  contextIsDeclared,
  createSurfaceRules,
  DECLARED_SURFACE_CONTEXTS,
  DESCRIPTOR_CATEGORIES,
  deriveSurfaceClientShape,
  EFFECTIVE_SURFACE_KINDS,
  isSurfacePathWireEligible,
  RETURN_SHAPES,
  resolveSurfaceRule,
  SURFACE_CLIENT_SHAPES,
  SURFACE_CONDITIONS,
  SURFACE_KINDS,
  SURFACE_RULES,
  SURFACE_SOURCES,
  type SurfaceContext,
  type SurfaceRuleInput,
  USAGE_BASES,
  validateSurfacePath,
} from "../../src/surfaces";

const OPENAI: SurfaceContext = {
  provider: "openai",
  dialect: "openai",
  clientShape: "openai_sdk",
};

const AZURE: SurfaceContext = {
  provider: "azure_openai",
  dialect: "openai",
  clientShape: "openai_sdk",
};

const GROQ_COMPAT: SurfaceContext = {
  provider: "groq",
  dialect: "openai",
  clientShape: "openai_sdk",
};

const TOGETHER_NATIVE: SurfaceContext = {
  provider: "together",
  dialect: "openai",
  clientShape: "native_together",
};

const ANTHROPIC: SurfaceContext = {
  provider: "anthropic",
  dialect: "anthropic",
  clientShape: "anthropic_sdk",
};

const GOOGLE: SurfaceContext = {
  provider: "google",
  dialect: "google",
  clientShape: "google_genai",
};

const LEGACY_GOOGLE: SurfaceContext = {
  provider: "google",
  dialect: "google",
  clientShape: "google_generativeai",
};

const BEDROCK: SurfaceContext = {
  provider: "bedrock",
  dialect: "bedrock",
  clientShape: "bedrock_v3",
};

describe("Responses compat rule closure", () => {
  it.each(
    COMPAT_PROFILES.filter((profile) => profile.name !== "azure_openai"),
  )("keeps $name Responses create/parse/stream RAW-only", (profile) => {
    const context: SurfaceContext = {
      provider: profile.name,
      dialect: "openai",
      clientShape: "openai_sdk",
    };
    for (const path of ["responses.create", "responses.parse", "responses.stream"]) {
      expect(resolveSurfaceRule({ context, path, source: "raw" })).toMatchObject({
        kind: "unmetered_spend",
        source: "raw",
        acknowledgmentToken: path,
      });
      expect(resolveSurfaceRule({ context, path, source: "wrapper" })).toBeUndefined();
    }
  });
});

function rule(
  overrides: Partial<SurfaceRuleInput> & Pick<SurfaceRuleInput, "ruleId">,
): SurfaceRuleInput {
  const { ruleId, ...rest } = overrides;
  return {
    surface: "widgets.create",
    selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
    kind: "metered",
    source: "raw",
    expectedShapes: [{ descriptorCategory: "method", returnShape: "function" }],
    usageBasis: "provider",
    ...rest,
    ruleId,
  };
}

function resolve(
  context: SurfaceContext,
  path: string,
  source: "raw" | "wrapper" | "synthetic_policy" = "raw",
  condition?: "openai_untracked_tts_model",
) {
  return resolveSurfaceRule({ context, path, source, condition });
}

describe("surface contract vocabulary", () => {
  it("pins the authored and effective kind vocabularies without authoring unknown rows", () => {
    expect(SURFACE_KINDS).toEqual([
      "metered",
      "metadata",
      "namespace",
      "unmetered_spend",
      "unsupported",
      "blocked",
      "infrastructure",
    ]);
    expect(EFFECTIVE_SURFACE_KINDS).toEqual([...SURFACE_KINDS, "unknown"]);
    expect(SURFACE_RULES.some((candidate) => candidate.kind === ("unknown" as never))).toBe(false);
  });

  it("pins the remaining structural vocabularies", () => {
    expect(SURFACE_SOURCES).toEqual(["raw", "wrapper", "both", "synthetic_policy"]);
    expect(USAGE_BASES).toEqual([
      "provider",
      "provider_or_estimate",
      "provider_and_request",
      "request_derived",
    ]);
    expect(CAPABILITY_SCOPES).toEqual([
      "operation",
      "client",
      "resource",
      "raw_response",
      "arbitrary_endpoint",
    ]);
    expect(SURFACE_CONDITIONS).toEqual(["openai_untracked_tts_model"]);
    expect(DESCRIPTOR_CATEGORIES).toEqual([
      "getter",
      "setter_only",
      "method",
      "field",
      "command_class",
    ]);
    expect(RETURN_SHAPES).toEqual([
      "scalar",
      "function",
      "class",
      "resource",
      "mapping",
      "sequence",
      "opaque",
      "unevaluated_accessor",
      "command_class",
    ]);
    expect(SURFACE_CLIENT_SHAPES).toEqual([
      "openai_sdk",
      "native_together",
      "anthropic_sdk",
      "google_genai",
      "google_generativeai",
      "bedrock_v3",
      "undeclared_sdk",
    ]);
  });

  it("exports nine deeply frozen declared contexts with the normalized legacy Google spelling", () => {
    expect(DECLARED_SURFACE_CONTEXTS).toHaveLength(9);
    expect(DECLARED_SURFACE_CONTEXTS).toContainEqual({
      provider: "google",
      dialect: "google",
      clientShape: "google_generativeai",
    });
    expect(JSON.stringify(DECLARED_SURFACE_CONTEXTS)).not.toContain("google_generative_ai");
    expect(Object.isFrozen(DECLARED_SURFACE_CONTEXTS)).toBe(true);
    expect(DECLARED_SURFACE_CONTEXTS.every(Object.isFrozen)).toBe(true);
  });
});

describe("surface path validation", () => {
  it("accepts structural Unicode identifiers while keeping non-wire paths local", () => {
    const longIdentifier = "a".repeat(129);
    expect(validateSurfacePath("café.create")).toBe("café.create");
    expect(validateSurfacePath("a‌b.create")).toBe("a‌b.create");
    expect(validateSurfacePath(longIdentifier)).toBe(longIdentifier);
    expect(isSurfacePathWireEligible("café.create")).toBe(false);
    expect(isSurfacePathWireEligible(longIdentifier)).toBe(false);
    expect(isSurfacePathWireEligible("chat.completions.create")).toBe(true);
  });

  it.each([
    "",
    "_private",
    "chat._private",
    "bad-name",
    "chat..create",
    "1invalid",
  ])("fails closed for malformed path %j without echoing it", (path) => {
    let thrown: unknown;
    try {
      validateSurfacePath(path);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("invalid public surface path");
    if (path.length > 0) {
      expect((thrown as Error).message).not.toContain(path);
    }
  });

  it("validates before resolving and returns no rule for a clean but wire-ineligible path", () => {
    expect(() => resolve(OPENAI, "bad-name")).toThrow("invalid public surface path");
    expect(resolve(OPENAI, "a".repeat(129))).toBeUndefined();
  });
});

describe("surface rule construction invariants", () => {
  it("exposes the E2 resolver and rule table from the surface contract module", () => {
    expect(typeof resolveSurfaceRule).toBe("function");
    expect(SURFACE_RULES.length).toBeGreaterThan(0);
  });

  it("deeply freezes rules, selectors, expected shapes, and the exported table", () => {
    const [created] = createSurfaceRules([rule({ ruleId: "surface.widgets-create.metered" })]);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created?.selectors)).toBe(true);
    expect(Object.isFrozen(created?.selectors[0])).toBe(true);
    expect(Object.isFrozen(created?.expectedShapes)).toBe(true);
    expect(Object.isFrozen(created?.expectedShapes[0])).toBe(true);
    expect(Object.isFrozen(SURFACE_RULES)).toBe(true);
    expect(SURFACE_RULES.every(Object.isFrozen)).toBe(true);
  });

  it("accepts only observations for the rule's exact surface and expected shape", () => {
    const [created] = createSurfaceRules([
      rule({
        ruleId: "surface.widgets-create.metered",
        expectedShapes: [
          { descriptorCategory: "method", returnShape: "function" },
          { descriptorCategory: "field", returnShape: "function" },
        ],
      }),
    ]);

    expect(
      created?.acceptsShape({
        path: "widgets.create",
        descriptorCategory: "method",
        returnShape: "function",
      }),
    ).toBe(true);
    expect(
      created?.acceptsShape({
        path: "widgets.create",
        descriptorCategory: "getter",
        returnShape: "unevaluated_accessor",
      }),
    ).toBe(false);
    expect(
      created?.acceptsShape({
        path: "other.create",
        descriptorCategory: "method",
        returnShape: "function",
      }),
    ).toBe(false);
  });

  it("detaches accepted-shape behavior from mutable input objects", () => {
    const mutable = rule({ ruleId: "surface.widgets-create.metered" }) as {
      surface: string;
      selectors: Array<{ provider: string | null; dialect: "openai"; clientShape: "openai_sdk" }>;
    } & SurfaceRuleInput;
    const [created] = createSurfaceRules([mutable]);

    mutable.surface = "other.create";
    mutable.selectors[0] = {
      provider: null,
      dialect: "openai",
      clientShape: "openai_sdk",
    };

    expect(
      created?.acceptsShape({
        path: "widgets.create",
        descriptorCategory: "method",
        returnShape: "function",
      }),
    ).toBe(true);
    expect(created?.surface).toBe("widgets.create");
    expect(created?.selectors[0]?.provider).toBe("openai");
  });

  it("sorts every constructed rule collection by surface then rule id", () => {
    const inputs = [
      rule({
        ruleId: "surface.zeta-create.metered",
        surface: "zeta.create",
      }),
      rule({
        ruleId: "surface.alpha-create.metered.zulu",
        surface: "alpha.create",
      }),
      rule({
        ruleId: "surface.alpha-create.metered.alpha",
        surface: "alpha.create",
        source: "wrapper",
      }),
    ];

    expect(createSurfaceRules(inputs).map(({ ruleId }) => ruleId)).toEqual([
      "surface.alpha-create.metered.alpha",
      "surface.alpha-create.metered.zulu",
      "surface.zeta-create.metered",
    ]);
    expect(inputs.map(({ ruleId }) => ruleId)).toEqual([
      "surface.zeta-create.metered",
      "surface.alpha-create.metered.zulu",
      "surface.alpha-create.metered.alpha",
    ]);
    expect(SURFACE_RULES.map(({ surface, ruleId }) => `${surface}|${ruleId}`)).toEqual(
      [...SURFACE_RULES]
        .sort(
          (left, right) =>
            (left.surface < right.surface ? -1 : left.surface > right.surface ? 1 : 0) ||
            (left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0),
        )
        .map(({ surface, ruleId }) => `${surface}|${ruleId}`),
    );
  });

  it.each([
    [
      "metered_without_basis",
      rule({ ruleId: "surface.widgets-create.metered", usageBasis: undefined }),
    ],
    [
      "non_metered_with_basis",
      rule({
        ruleId: "surface.widgets-create.metadata",
        kind: "metadata",
        usageBasis: "provider",
      }),
    ],
    [
      "untracked_without_token",
      rule({
        ruleId: "surface.widgets-create.unmetered_spend",
        kind: "unmetered_spend",
        usageBasis: undefined,
        capabilityScope: "operation",
      }),
    ],
    [
      "untracked_without_scope",
      rule({
        ruleId: "surface.widgets-create.unmetered_spend",
        kind: "unmetered_spend",
        usageBasis: undefined,
        acknowledgmentToken: "widgets.create",
      }),
    ],
    [
      "non_untracked_with_token",
      rule({
        ruleId: "surface.widgets-create.metered",
        acknowledgmentToken: "widgets.create",
      }),
    ],
    [
      "non_untracked_with_scope",
      rule({ ruleId: "surface.widgets-create.metered", capabilityScope: "operation" }),
    ],
    [
      "namespace_token",
      rule({
        ruleId: "surface.widgets-create.namespace",
        kind: "namespace",
        usageBasis: undefined,
        acknowledgmentToken: "widgets.create",
      }),
    ],
    [
      "blocked_without_reason",
      rule({
        ruleId: "surface.widgets-create.blocked",
        kind: "blocked",
        usageBasis: undefined,
      }),
    ],
    [
      "unsupported_without_reason",
      rule({
        ruleId: "surface.widgets-create.unsupported",
        kind: "unsupported",
        usageBasis: undefined,
      }),
    ],
    ["no_selectors", rule({ ruleId: "surface.widgets-create.metered", selectors: [] })],
    ["no_shapes", rule({ ruleId: "surface.widgets-create.metered", expectedShapes: [] })],
    [
      "raw_callable_infrastructure",
      rule({
        ruleId: "surface.widgets-create.infrastructure",
        kind: "infrastructure",
        usageBasis: undefined,
      }),
    ],
    [
      "non_wire_authored_path",
      rule({
        ruleId: "surface.widgets-create.metered",
        surface: "a".repeat(129),
      }),
    ],
    ["bad_rule_id", rule({ ruleId: "not a safe id" })],
  ] as const)("rejects the %s invariant", (_name, invalidRule) => {
    expect(() => createSurfaceRules([invalidRule])).toThrow(/invalid surface rule/);
  });

  it("rejects repeated selectors, expected shapes, rule ids, and equivalent applicability rows", () => {
    const valid = rule({ ruleId: "surface.widgets-create.metered" });
    expect(() =>
      createSurfaceRules([
        {
          ...valid,
          selectors: [
            { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
            { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
          ],
        },
      ]),
    ).toThrow(/invalid surface rule/);
    expect(() =>
      createSurfaceRules([
        {
          ...valid,
          expectedShapes: [
            { descriptorCategory: "method", returnShape: "function" },
            { descriptorCategory: "method", returnShape: "function" },
          ],
        },
      ]),
    ).toThrow(/invalid surface rule/);
    expect(() => createSurfaceRules([valid, { ...valid }])).toThrow(/invalid surface rule/);
    expect(() =>
      createSurfaceRules([
        valid,
        rule({
          ruleId: "surface.widgets-create.metered.second",
          kind: "metadata",
          usageBasis: undefined,
        }),
      ]),
    ).toThrow(/invalid surface rule/);
  });

  it("permits only the canonical TTS qualified acknowledgment token and condition", () => {
    const canonical = rule({
      ruleId: "surface.audio-speech-create.unmetered_spend.conditional",
      surface: "audio.speech.create",
      kind: "unmetered_spend",
      source: "synthetic_policy",
      usageBasis: undefined,
      acknowledgmentToken: "audio.speech.create:gpt-4o-mini-tts",
      capabilityScope: "operation",
      condition: "openai_untracked_tts_model",
    });

    expect(createSurfaceRules([canonical])).toHaveLength(1);
    expect(() =>
      createSurfaceRules([
        {
          ...canonical,
          ruleId: "surface.widgets-create.unmetered_spend.conditional",
          surface: "widgets.create",
          acknowledgmentToken: "widgets.create:special",
        },
      ]),
    ).toThrow(/invalid surface rule/);
    expect(() => createSurfaceRules([{ ...canonical, condition: undefined }])).toThrow(
      /invalid surface rule/,
    );
    expect(() =>
      createSurfaceRules([
        {
          ...canonical,
          ruleId: "surface.widgets-create.unmetered_spend.conditional",
          surface: "widgets.create",
        },
      ]),
    ).toThrow(/invalid surface rule/);
  });
});

describe("surface resolver", () => {
  it("prefers exact context over wildcard and source-specific over both", () => {
    const rules = createSurfaceRules([
      rule({
        ruleId: "surface.widgets-create.metered.wildcard",
        selectors: [{ provider: null, dialect: "openai", clientShape: "openai_sdk" }],
        source: "both",
      }),
      rule({
        ruleId: "surface.widgets-create.metered.exact",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        source: "both",
      }),
      rule({
        ruleId: "surface.widgets-create.metered.raw",
        selectors: [{ provider: "openai", dialect: "openai", clientShape: "openai_sdk" }],
        source: "raw",
      }),
    ]);

    expect(
      resolveSurfaceRule({ context: GROQ_COMPAT, path: "widgets.create", source: "raw", rules })
        ?.ruleId,
    ).toBe("surface.widgets-create.metered.wildcard");
    expect(
      resolveSurfaceRule({ context: OPENAI, path: "widgets.create", source: "wrapper", rules })
        ?.ruleId,
    ).toBe("surface.widgets-create.metered.exact");
    expect(
      resolveSurfaceRule({ context: OPENAI, path: "widgets.create", source: "raw", rules })?.ruleId,
    ).toBe("surface.widgets-create.metered.raw");
  });

  it("prefers the canonical TTS conditional rule when its condition is active", () => {
    const rules = createSurfaceRules([
      rule({
        ruleId: "surface.audio-speech-create.metered",
        surface: "audio.speech.create",
      }),
      rule({
        ruleId: "surface.audio-speech-create.unmetered_spend.conditional",
        surface: "audio.speech.create",
        kind: "unmetered_spend",
        usageBasis: undefined,
        acknowledgmentToken: "audio.speech.create:gpt-4o-mini-tts",
        capabilityScope: "operation",
        condition: "openai_untracked_tts_model",
      }),
    ]);

    expect(
      resolveSurfaceRule({
        context: OPENAI,
        path: "audio.speech.create",
        source: "raw",
        condition: "openai_untracked_tts_model",
        rules,
      })?.ruleId,
    ).toBe("surface.audio-speech-create.unmetered_spend.conditional");
  });

  it("returns undefined for no authored match", () => {
    expect(resolve(OPENAI, "notReviewedYet")).toBeUndefined();
  });

  it("treats both as raw plus wrapper, never as synthetic policy", () => {
    const rules = createSurfaceRules([
      rule({
        ruleId: "surface.widgets-create.metered",
        source: "both",
      }),
    ]);

    expect(
      resolveSurfaceRule({
        context: OPENAI,
        path: "widgets.create",
        source: "synthetic_policy",
        rules,
      }),
    ).toBeUndefined();
  });

  it("throws a deterministic typed ambiguity naming sorted rule ids with no kind tie-break", () => {
    const rules = createSurfaceRules([
      rule({
        ruleId: "surface.widgets-create.metered.provider",
        selectors: [{ provider: "openai", dialect: null, clientShape: null }],
      }),
      rule({
        ruleId: "surface.widgets-create.metadata.dialect",
        selectors: [{ provider: null, dialect: "openai", clientShape: null }],
        kind: "metadata",
        usageBasis: undefined,
      }),
    ]);

    expect(() =>
      resolveSurfaceRule({ context: OPENAI, path: "widgets.create", source: "raw", rules }),
    ).toThrow(
      "ambiguous surface rules: surface.widgets-create.metadata.dialect, surface.widgets-create.metered.provider",
    );
  });
});

describe("declared contexts and client-shape derivation", () => {
  it.each([
    OPENAI,
    AZURE,
    GROQ_COMPAT,
    TOGETHER_NATIVE,
    ANTHROPIC,
    GOOGLE,
    LEGACY_GOOGLE,
    BEDROCK,
  ])("recognizes declared runtime context $provider/$clientShape", (context) => {
    expect(contextIsDeclared(context)).toBe(true);
  });

  it("rejects undeclared pairings and the local undeclared_sdk shape", () => {
    expect(
      contextIsDeclared({ provider: "openai", dialect: "anthropic", clientShape: "openai_sdk" }),
    ).toBe(false);
    expect(
      contextIsDeclared({
        provider: "openai",
        dialect: "openai",
        clientShape: "undeclared_sdk",
      }),
    ).toBe(false);
  });

  it("derives shapes in load-bearing precedence without importing SDKs or invoking operations", () => {
    const operation = vi.fn(() => {
      throw new Error("must not run");
    });

    class TogetherClient {
      readonly chat = { completions: { create: operation } };
    }
    class OpenAI {
      readonly chat = { completions: { create: operation } };
    }
    class Anthropic {
      readonly messages = { create: operation };
    }
    class GoogleGenAI {
      readonly models = { generateContent: operation };
    }
    class GoogleGenerativeAI {
      readonly getGenerativeModel = operation;
    }
    class BedrockRuntimeClient {
      readonly middlewareStack = {};
      readonly send = operation;
    }

    expect(deriveSurfaceClientShape(new TogetherClient())).toBe("native_together");
    expect(deriveSurfaceClientShape(new OpenAI())).toBe("openai_sdk");
    expect(deriveSurfaceClientShape(new Anthropic())).toBe("anthropic_sdk");
    expect(deriveSurfaceClientShape(new GoogleGenAI())).toBe("google_genai");
    expect(deriveSurfaceClientShape(new GoogleGenerativeAI())).toBe("google_generativeai");
    expect(deriveSurfaceClientShape(new BedrockRuntimeClient())).toBe("bedrock_v3");
    expect(deriveSurfaceClientShape({ arbitrary: true })).toBe("undeclared_sdk");
    expect(operation).not.toHaveBeenCalled();
  });

  it("requires both a Together constructor label and a static chat completion signal", () => {
    class TogetherNameOnly {}
    class TogetherAnthropic {
      readonly messages = { create: vi.fn() };
    }

    expect(deriveSurfaceClientShape(new TogetherNameOnly())).toBe("undeclared_sdk");
    expect(deriveSurfaceClientShape(new TogetherAnthropic())).toBe("anthropic_sdk");
    expect(deriveSurfaceClientShape({ chat: { completions: { create: vi.fn() } } })).toBe(
      "openai_sdk",
    );
  });

  it("reads constructor labels from descriptors without touching a name accessor", () => {
    const nameReads = vi.fn();
    function TogetherClient() {}
    const constructorProxy = new Proxy(TogetherClient, {
      get(target, property, receiver) {
        if (property === "name") {
          nameReads();
          throw new Error("must not read constructor.name");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const client = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(client, "constructor", { value: constructorProxy });
    Object.defineProperty(client, "chat", {
      value: { completions: { create: vi.fn() } },
    });

    expect(deriveSurfaceClientShape(client)).toBe("native_together");
    expect(nameReads).not.toHaveBeenCalled();
  });

  it("uses constructor ancestry ahead of potentially effectful namespace getters", () => {
    let evaluations = 0;
    class OpenAI {
      get chat(): never {
        evaluations += 1;
        throw new Error("must not evaluate");
      }
    }
    expect(deriveSurfaceClientShape(new OpenAI())).toBe("undeclared_sdk");
    expect(evaluations).toBe(0);
  });

  it("rejects provider-named helpers and generic AWS v3 clients without client proof", () => {
    class OpenAIError {}
    class OpenAIResponsesResource {}
    class AnthropicError {}
    class AnthropicHelper {}
    class S3Client {
      readonly middlewareStack = {};
      readonly send = vi.fn();
    }

    for (const value of [
      new OpenAIError(),
      new OpenAIResponsesResource(),
      new AnthropicError(),
      new AnthropicHelper(),
      new S3Client(),
    ]) {
      expect(deriveSurfaceClientShape(value)).toBe("undeclared_sdk");
    }
  });

  it("requires BedrockRuntime ancestry plus a static send operation", () => {
    class BedrockClient {
      readonly send = vi.fn();
    }
    class BedrockRuntimeClient {
      readonly send = vi.fn();
    }
    class BedrockRuntimeNameOnly {}

    expect(deriveSurfaceClientShape(new BedrockClient())).toBe("undeclared_sdk");
    expect(deriveSurfaceClientShape(new BedrockRuntimeNameOnly())).toBe("undeclared_sdk");
    expect(deriveSurfaceClientShape(new BedrockRuntimeClient())).toBe("bedrock_v3");
  });

  it("accepts a response-only OpenAI-compatible client from its static operation shape", () => {
    const create = vi.fn();
    expect(deriveSurfaceClientShape({ responses: { create } })).toBe("openai_sdk");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("curated JS surface rules", () => {
  it("curates native OpenAI transport and client escapes without broadening compat contexts", () => {
    const expectedSelectors = [
      { provider: "openai", dialect: "openai", clientShape: "openai_sdk" },
      { provider: "azure_openai", dialect: "openai", clientShape: "openai_sdk" },
    ];
    const scopes = {
      get: "arbitrary_endpoint",
      post: "arbitrary_endpoint",
      put: "arbitrary_endpoint",
      patch: "arbitrary_endpoint",
      delete: "arbitrary_endpoint",
      request: "arbitrary_endpoint",
      withOptions: "client",
    } as const;

    for (const [path, capabilityScope] of Object.entries(scopes)) {
      const ledgerRows = SURFACE_RULES.filter((rule) => rule.surface === path);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({
        selectors: expectedSelectors,
        kind: "unmetered_spend",
        source: "raw",
        acknowledgmentToken: path,
        capabilityScope,
      });

      for (const context of [OPENAI, AZURE]) {
        const candidate = resolve(context, path, "raw");
        expect(candidate?.ruleId).toBe(ledgerRows[0]?.ruleId);
        expect(
          candidate?.acceptsShape({
            path,
            descriptorCategory: "method",
            returnShape: "function",
          }),
        ).toBe(true);
        expect(
          candidate?.acceptsShape({
            path,
            descriptorCategory: "field",
            returnShape: "function",
          }),
        ).toBe(true);
        expect(
          candidate?.acceptsShape({
            path,
            descriptorCategory: "field",
            returnShape: "scalar",
          }),
        ).toBe(false);
      }

      expect(resolve(GROQ_COMPAT, path, "raw")).toBeUndefined();
      expect(resolve(TOGETHER_NATIVE, path, "raw")).toBeUndefined();
    }
  });

  it.each([
    [OPENAI, "chat.completions.create", "both", "provider"],
    [GROQ_COMPAT, "chat.completions.create", "raw", "provider_or_estimate"],
    [ANTHROPIC, "messages.create", "both", "provider"],
    [GOOGLE, "models.generateContent", "both", "provider"],
    [GOOGLE, "models.generateContentStream", "both", "provider"],
    [LEGACY_GOOGLE, "generateContent", "both", "provider"],
    [BEDROCK, "ConverseCommand", "both", "provider"],
    [BEDROCK, "ConverseStreamCommand", "both", "provider"],
  ] as const)("classifies %s %s as metered", (context, path, source, usageBasis) => {
    const candidate = resolve(context, path, source === "both" ? "raw" : source);
    expect(candidate).toMatchObject({ kind: "metered", usageBasis });
  });

  it.each([
    [OPENAI, "embeddings.create", "provider_or_estimate"],
    [OPENAI, "images.generate", "provider_and_request"],
    [OPENAI, "images.edit", "provider_and_request"],
    [OPENAI, "audio.transcriptions.create", "provider"],
    [OPENAI, "audio.speech.create", "request_derived"],
    [OPENAI, "videos.create", "request_derived"],
    [GOOGLE, "models.embedContent", "provider_or_estimate"],
    [GOOGLE, "models.generateImages", "request_derived"],
    [GOOGLE, "models.generateVideos", "request_derived"],
  ] as const)("classifies media surface %s %s with basis %s", (context, path, usageBasis) => {
    expect(resolve(context, path)).toMatchObject({ kind: "metered", usageBasis });
  });

  it.each([
    AZURE,
    GROQ_COMPAT,
    TOGETHER_NATIVE,
  ])("keeps non-OpenAI videos fail-loud only on the wrapper surface for $provider/$clientShape", (context) => {
    expect(resolve(context, "videos", "wrapper")).toMatchObject({ kind: "namespace" });
    expect(resolve(context, "videos.create", "wrapper")).toMatchObject({
      kind: "unsupported",
      source: "wrapper",
    });
    expect(resolve(context, "videos.create", "raw")).toBeUndefined();
  });

  it("splits native OpenAI/Azure Responses tracking from compatible raw escapes", () => {
    for (const context of [OPENAI, AZURE]) {
      expect(resolve(context, "responses", "raw")).toMatchObject({
        kind: "namespace",
        source: "both",
      });
      expect(resolve(context, "responses", "wrapper")).toMatchObject({
        kind: "namespace",
        source: "both",
      });
      for (const path of ["responses.create", "responses.parse", "responses.stream"]) {
        expect(resolve(context, path)).toMatchObject({
          kind: "metered",
          source: "both",
          usageBasis: "provider",
          acknowledgmentToken: null,
        });
      }
      expect(resolve(context, "responses.retrieve")).toMatchObject({
        kind: "unmetered_spend",
        acknowledgmentToken: "responses.retrieve",
      });
    }

    expect(resolve(GROQ_COMPAT, "responses", "raw")).toMatchObject({
      kind: "namespace",
      source: "raw",
    });
    expect(resolve(GROQ_COMPAT, "responses", "wrapper")).toBeUndefined();

    for (const path of ["responses.create", "responses.parse", "responses.stream"]) {
      expect(resolve(GROQ_COMPAT, path)).toMatchObject({
        kind: "unmetered_spend",
        source: "raw",
        acknowledgmentToken: path,
        capabilityScope: "operation",
      });
      expect(resolve(GROQ_COMPAT, path, "wrapper")).toBeUndefined();
    }
  });

  it("lets the conditional TTS policy outrank ordinary metering", () => {
    expect(resolve(OPENAI, "audio.speech.create")).toMatchObject({ kind: "metered" });
    expect(
      resolve(OPENAI, "audio.speech.create", "synthetic_policy", "openai_untracked_tts_model"),
    ).toMatchObject({
      kind: "unmetered_spend",
      acknowledgmentToken: "audio.speech.create:gpt-4o-mini-tts",
      capabilityScope: "operation",
      condition: "openai_untracked_tts_model",
    });
  });

  it.each([
    [OPENAI, "audio.translations"],
    [TOGETHER_NATIVE, "completions"],
    [TOGETHER_NATIVE, "rerank"],
    [TOGETHER_NATIVE, "codeInterpreter"],
    [TOGETHER_NATIVE, "evals"],
  ] as const)("keeps deliberate spend escape %s %s conspicuous", (context, path) => {
    expect(resolve(context, path)).toMatchObject({
      kind: "unmetered_spend",
      acknowledgmentToken: path,
    });
  });

  it("accepts floor-callable and latest-resource shapes only for Together rerank", () => {
    const rerank = resolve(TOGETHER_NATIVE, "rerank", "raw");
    expect(rerank).toMatchObject({
      kind: "unmetered_spend",
      source: "raw",
      capabilityScope: "resource",
      acknowledgmentToken: "rerank",
    });
    for (const shape of [
      { descriptorCategory: "method", returnShape: "function" },
      { descriptorCategory: "field", returnShape: "function" },
      { descriptorCategory: "field", returnShape: "resource" },
      { descriptorCategory: "getter", returnShape: "resource" },
      { descriptorCategory: "field", returnShape: "mapping" },
    ] as const) {
      expect(rerank?.acceptsShape({ path: "rerank", ...shape })).toBe(true);
    }
    expect(
      rerank?.acceptsShape({
        path: "rerank",
        descriptorCategory: "field",
        returnShape: "scalar",
      }),
    ).toBe(false);

    for (const path of ["completions", "codeInterpreter", "evals"] as const) {
      const resource = resolve(TOGETHER_NATIVE, path, "raw");
      expect(
        resource?.acceptsShape({ path, descriptorCategory: "field", returnShape: "resource" }),
      ).toBe(true);
      expect(
        resource?.acceptsShape({ path, descriptorCategory: "method", returnShape: "function" }),
      ).toBe(false);
    }
  });

  it.each([
    "InvokeModelCommand",
    "InvokeModelWithResponseStreamCommand",
    "StartAsyncInvokeCommand",
  ])("blocks Bedrock command class %s", (path) => {
    expect(resolve(BEDROCK, path)).toMatchObject({
      kind: "blocked",
      reason: expect.any(String),
    });
  });

  it("keeps wrapper-owned media unsupported where no native dispatch is safe", () => {
    expect(resolve(ANTHROPIC, "embeddings.create", "wrapper")).toMatchObject({
      kind: "unsupported",
      reason: expect.any(String),
    });
    expect(resolve(BEDROCK, "audio.speech.create", "wrapper")).toMatchObject({
      kind: "unsupported",
      reason: expect.any(String),
    });
  });

  it.each([
    OPENAI,
    AZURE,
    TOGETHER_NATIVE,
    ANTHROPIC,
  ])("classifies callable client helpers as raw unmetered spend for $provider/$clientShape", (context) => {
    for (const path of ["authHeaders", "defaultHeaders", "defaultQuery"] as const) {
      const candidate = resolve(context, path, "raw");
      expect(candidate).toMatchObject({
        kind: "unmetered_spend",
        source: "raw",
        capabilityScope: "operation",
        acknowledgmentToken: path,
      });
      for (const shape of [
        { descriptorCategory: "method", returnShape: "function" },
        { descriptorCategory: "field", returnShape: "function" },
      ] as const) {
        expect(candidate?.acceptsShape({ path, ...shape })).toBe(true);
      }
      expect(
        candidate?.acceptsShape({
          path,
          descriptorCategory: "field",
          returnShape: "scalar",
        }),
      ).toBe(false);
      expect(resolve(context, path, "wrapper")).toBeUndefined();
    }
  });

  it("classifies lifecycle and inert values deliberately rather than silently inferring safety", () => {
    expect(resolve(OPENAI, "close", "wrapper")).toMatchObject({ kind: "infrastructure" });
    expect(resolve(OPENAI, "close", "raw")).toBeUndefined();
    expect(resolve(OPENAI, "timeout", "raw")).toMatchObject({
      kind: "infrastructure",
      source: "raw",
    });
    expect(resolve(OPENAI, "timeout", "wrapper")).toBeUndefined();

    const metadata = [
      "apiKey",
      "adminApiKey",
      "authToken",
      "baseURL",
      "credentials",
      "maxRetries",
      "modelName",
      "organization",
      "project",
      "projectId",
      "qs",
      "userAgent",
      "vertexai",
      "webhookKey",
      "webhookSecret",
      "websocketBaseURL",
      "workloadIdentity",
      "AI_PROMPT",
      "HUMAN_PROMPT",
    ] as const;
    expect(metadata).toHaveLength(19);
    for (const path of metadata) {
      const candidate = resolve(ANTHROPIC, path, "raw");
      expect(candidate).toMatchObject({ kind: "metadata", source: "raw" });
      expect(
        candidate?.acceptsShape({
          path,
          descriptorCategory: "field",
          returnShape: "scalar",
        }),
      ).toBe(true);
      expect(
        candidate?.acceptsShape({
          path,
          descriptorCategory: "field",
          returnShape: "mapping",
        }),
      ).toBe(true);
      expect(
        candidate?.acceptsShape({
          path,
          descriptorCategory: "field",
          returnShape: "opaque",
        }),
      ).toBe(true);
      expect(
        candidate?.acceptsShape({
          path,
          descriptorCategory: "method",
          returnShape: "function",
        }),
      ).toBe(false);
      expect(resolve(ANTHROPIC, path, "wrapper")).toBeUndefined();
    }
  });

  it("curates only verified direct Anthropic stable and beta terminal paths", () => {
    const directPaths = [
      "files.delete",
      "files.download",
      "files.list",
      "files.retrieveMetadata",
      "files.upload",
      "skills.create",
      "skills.delete",
      "skills.list",
      "skills.retrieve",
      "skills.versions.create",
      "skills.versions.delete",
      "skills.versions.list",
      "skills.versions.retrieve",
      "beta.files.delete",
      "beta.files.download",
      "beta.files.list",
      "beta.files.retrieveMetadata",
      "beta.files.upload",
      "beta.skills.create",
      "beta.skills.delete",
      "beta.skills.list",
      "beta.skills.retrieve",
      "beta.skills.versions.create",
      "beta.skills.versions.delete",
      "beta.skills.versions.list",
      "beta.skills.versions.retrieve",
    ];
    for (const path of directPaths) {
      expect(resolve(ANTHROPIC, path)).toMatchObject({
        kind: "unmetered_spend",
        source: "raw",
        acknowledgmentToken: path,
      });
    }

    for (const path of [
      "files.withRawResponse",
      "files.withRawResponse.upload",
      "files.withStreamingResponse.download",
      "beta.skills.versions.withStreamingResponse.create",
    ]) {
      expect(resolve(ANTHROPIC, path)).toBeUndefined();
    }
  });

  it("resolves the verified direct Anthropic beta skills download operation exactly", () => {
    const path = "beta.skills.versions.download";
    const candidate = resolve(ANTHROPIC, path, "raw");

    expect(candidate).toMatchObject({
      kind: "unmetered_spend",
      source: "raw",
      capabilityScope: "operation",
      acknowledgmentToken: path,
    });
    expect(
      candidate?.acceptsShape({ path, descriptorCategory: "method", returnShape: "function" }),
    ).toBe(true);
  });

  it("keeps namespace parents separate and never acknowledgment-eligible", () => {
    for (const path of [
      "chat",
      "chat.completions",
      "responses",
      "files",
      "skills",
      "skills.versions",
      "beta",
      "beta.skills.versions",
    ]) {
      const context = path.startsWith("chat") || path === "responses" ? OPENAI : ANTHROPIC;
      expect(resolve(context, path)).toMatchObject({
        kind: "namespace",
        acknowledgmentToken: null,
      });
    }
    expect(resolve(ANTHROPIC, "chat", "wrapper")).toMatchObject({ kind: "namespace" });
    expect(resolve(ANTHROPIC, "chat.completions", "wrapper")).toMatchObject({
      kind: "namespace",
    });
    for (const context of [
      OPENAI,
      AZURE,
      GROQ_COMPAT,
      TOGETHER_NATIVE,
      ANTHROPIC,
      GOOGLE,
      LEGACY_GOOGLE,
      BEDROCK,
    ]) {
      expect(resolve(context, "chat", "wrapper")).toMatchObject({
        kind: "namespace",
        source: "wrapper",
      });
      expect(resolve(context, "chat.completions", "wrapper")).toMatchObject({
        kind: "namespace",
        source: "wrapper",
      });
    }
  });
});

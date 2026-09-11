import type {
  CapabilityScope,
  ExpectedSurfaceShape,
  SurfaceCondition,
  SurfaceKind,
  SurfaceRuleInput,
  SurfaceSelector,
  SurfaceSource,
  UsageBasis,
} from "./surfaces";

export const OPENAI_TTS_ACKNOWLEDGMENT_TOKEN = "audio.speech.create:gpt-4o-mini-tts" as const;

const METHOD_SHAPES = [
  { descriptorCategory: "method", returnShape: "function" },
  { descriptorCategory: "field", returnShape: "function" },
] as const satisfies readonly ExpectedSurfaceShape[];

const RESOURCE_SHAPES = [
  { descriptorCategory: "field", returnShape: "resource" },
  { descriptorCategory: "getter", returnShape: "resource" },
  { descriptorCategory: "field", returnShape: "mapping" },
] as const satisfies readonly ExpectedSurfaceShape[];

const RESOURCE_OR_METHOD_SHAPES = [
  ...RESOURCE_SHAPES,
  ...METHOD_SHAPES,
] as const satisfies readonly ExpectedSurfaceShape[];

const COMMAND_SHAPES = [
  { descriptorCategory: "command_class", returnShape: "command_class" },
  { descriptorCategory: "field", returnShape: "class" },
] as const satisfies readonly ExpectedSurfaceShape[];

const SCALAR_SHAPES = [
  { descriptorCategory: "field", returnShape: "scalar" },
  { descriptorCategory: "getter", returnShape: "unevaluated_accessor" },
] as const satisfies readonly ExpectedSurfaceShape[];

const INERT_METADATA_SHAPES = [
  { descriptorCategory: "field", returnShape: "scalar" },
  { descriptorCategory: "field", returnShape: "mapping" },
  { descriptorCategory: "field", returnShape: "opaque" },
  { descriptorCategory: "getter", returnShape: "unevaluated_accessor" },
] as const satisfies readonly ExpectedSurfaceShape[];

const COMPAT: SurfaceSelector = {
  provider: null,
  dialect: "openai",
  clientShape: "openai_sdk",
};
const OPENAI: SurfaceSelector = {
  provider: "openai",
  dialect: "openai",
  clientShape: "openai_sdk",
};
const AZURE: SurfaceSelector = {
  provider: "azure_openai",
  dialect: "openai",
  clientShape: "openai_sdk",
};
const NATIVE_OPENAI = [OPENAI, AZURE] as const;
const TOGETHER_NATIVE: SurfaceSelector = {
  provider: "together",
  dialect: "openai",
  clientShape: "native_together",
};
const OPENAI_MEDIA = [COMPAT, TOGETHER_NATIVE] as const;
const ANTHROPIC: SurfaceSelector = {
  provider: "anthropic",
  dialect: "anthropic",
  clientShape: "anthropic_sdk",
};
const GOOGLE_GENAI: SurfaceSelector = {
  provider: "google",
  dialect: "google",
  clientShape: "google_genai",
};
const GOOGLE_LEGACY: SurfaceSelector = {
  provider: "google",
  dialect: "google",
  clientShape: "google_generativeai",
};
const BEDROCK: SurfaceSelector = {
  provider: "bedrock",
  dialect: "bedrock",
  clientShape: "bedrock_v3",
};

const ALL_CLIENTS = [
  COMPAT,
  TOGETHER_NATIVE,
  ANTHROPIC,
  GOOGLE_GENAI,
  GOOGLE_LEGACY,
  BEDROCK,
] as const;

function kebabSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function rowId(surface: string, kind: SurfaceKind, suffix?: string): string {
  const path = surface.split(".").map(kebabSegment).join("-");
  const base = `surface.${path}.${kind}`;
  return suffix === undefined ? base : `${base}.${suffix}`;
}

function namespaceRow(
  surface: string,
  selectors: readonly SurfaceSelector[],
  suffix?: string,
  source: SurfaceSource = "both",
): SurfaceRuleInput {
  return {
    ruleId: rowId(surface, "namespace", suffix),
    surface,
    selectors,
    kind: "namespace",
    source,
    expectedShapes: RESOURCE_SHAPES,
  };
}

function meteredRow(
  surface: string,
  selectors: readonly SurfaceSelector[],
  usageBasis: UsageBasis,
  suffix?: string,
  source: SurfaceSource = "both",
  expectedShapes: readonly ExpectedSurfaceShape[] = METHOD_SHAPES,
): SurfaceRuleInput {
  return {
    ruleId: rowId(surface, "metered", suffix),
    surface,
    selectors,
    kind: "metered",
    source,
    expectedShapes,
    usageBasis,
  };
}

function unmeteredRow(
  surface: string,
  selectors: readonly SurfaceSelector[],
  capabilityScope: CapabilityScope,
  suffix?: string,
  source: SurfaceSource = "raw",
  expectedShapes: readonly ExpectedSurfaceShape[] = METHOD_SHAPES,
  token: string = surface,
  condition?: SurfaceCondition,
): SurfaceRuleInput {
  return {
    ruleId: rowId(surface, "unmetered_spend", suffix),
    surface,
    selectors,
    kind: "unmetered_spend",
    source,
    expectedShapes,
    acknowledgmentToken: token,
    capabilityScope,
    condition,
  };
}

function curatedRuleInputs(): readonly SurfaceRuleInput[] {
  const rows: SurfaceRuleInput[] = [];

  for (const path of ["chat", "chat.completions"]) {
    rows.push(namespaceRow(path, [COMPAT], "raw", "raw"));
    rows.push(namespaceRow(path, [TOGETHER_NATIVE], "together-native-raw", "raw"));
    rows.push(namespaceRow(path, ALL_CLIENTS, "wrapper", "wrapper"));
  }
  rows.push(meteredRow("chat.completions.create", NATIVE_OPENAI, "provider", "native", "raw"));
  rows.push(
    meteredRow("chat.completions.create", [COMPAT], "provider_or_estimate", "compat", "raw"),
  );
  rows.push(
    meteredRow(
      "chat.completions.create",
      [TOGETHER_NATIVE],
      "provider_or_estimate",
      "together-native",
      "raw",
    ),
  );
  rows.push(meteredRow("chat.completions.create", ALL_CLIENTS, "provider", "wrapper", "wrapper"));

  rows.push(namespaceRow("responses", NATIVE_OPENAI, "native", "both"));
  rows.push(namespaceRow("responses", [COMPAT], "compat", "raw"));
  for (const path of ["responses.create", "responses.parse", "responses.stream"]) {
    rows.push(meteredRow(path, NATIVE_OPENAI, "provider", "native"));
    rows.push(unmeteredRow(path, [COMPAT], "operation", "compat"));
  }
  rows.push(unmeteredRow("responses.retrieve", [COMPAT], "operation", "compat"));

  for (const path of ["embeddings", "images", "audio", "audio.transcriptions", "audio.speech"]) {
    rows.push(namespaceRow(path, OPENAI_MEDIA, "compat"));
  }
  rows.push(namespaceRow("videos", [COMPAT], "compat"));
  rows.push(meteredRow("embeddings.create", OPENAI_MEDIA, "provider_or_estimate"));
  rows.push(meteredRow("images.generate", OPENAI_MEDIA, "provider_and_request"));
  rows.push(meteredRow("images.edit", [COMPAT], "provider_and_request"));
  rows.push(meteredRow("audio.transcriptions.create", OPENAI_MEDIA, "provider"));
  rows.push(meteredRow("audio.speech.create", OPENAI_MEDIA, "request_derived"));
  rows.push(meteredRow("videos.create", [OPENAI], "request_derived"));
  for (const path of ["get", "post", "put", "patch", "delete", "request"]) {
    rows.push(unmeteredRow(path, NATIVE_OPENAI, "arbitrary_endpoint"));
  }
  rows.push(unmeteredRow("withOptions", NATIVE_OPENAI, "client"));
  rows.push(namespaceRow("videos", [TOGETHER_NATIVE], "together-wrapper", "wrapper"));
  rows.push({
    ruleId: rowId("videos.create", "unsupported", "compat-wrapper"),
    surface: "videos.create",
    selectors: [COMPAT, TOGETHER_NATIVE],
    kind: "unsupported",
    source: "wrapper",
    expectedShapes: METHOD_SHAPES,
    reason: "The provider cannot dispatch this wrapper owned media operation safely",
  });
  rows.push(
    unmeteredRow(
      "audio.speech.create",
      NATIVE_OPENAI,
      "operation",
      "tts-model",
      "synthetic_policy",
      METHOD_SHAPES,
      OPENAI_TTS_ACKNOWLEDGMENT_TOKEN,
      "openai_untracked_tts_model",
    ),
  );
  rows.push(
    unmeteredRow("audio.translations", OPENAI_MEDIA, "resource", "compat", "raw", RESOURCE_SHAPES),
  );

  for (const path of ["completions", "rerank", "codeInterpreter", "evals"]) {
    rows.push(
      unmeteredRow(
        path,
        [TOGETHER_NATIVE],
        "resource",
        "together",
        "raw",
        path === "rerank" ? RESOURCE_OR_METHOD_SHAPES : RESOURCE_SHAPES,
      ),
    );
  }

  rows.push(namespaceRow("messages", [ANTHROPIC], "anthropic"));
  rows.push(meteredRow("messages.create", [ANTHROPIC], "provider"));

  rows.push(namespaceRow("models", [GOOGLE_GENAI], "google"));
  for (const path of ["models.generateContent", "models.generateContentStream"]) {
    rows.push(meteredRow(path, [GOOGLE_GENAI], "provider"));
  }
  rows.push(meteredRow("models.embedContent", [GOOGLE_GENAI], "provider_or_estimate"));
  rows.push(meteredRow("models.generateImages", [GOOGLE_GENAI], "request_derived"));
  rows.push(meteredRow("models.generateVideos", [GOOGLE_GENAI], "request_derived"));
  rows.push(meteredRow("generateContent", [GOOGLE_LEGACY], "provider"));

  for (const path of ["ConverseCommand", "ConverseStreamCommand"]) {
    rows.push(meteredRow(path, [BEDROCK], "provider", undefined, "both", COMMAND_SHAPES));
  }
  for (const path of [
    "InvokeModelCommand",
    "InvokeModelWithResponseStreamCommand",
    "StartAsyncInvokeCommand",
  ]) {
    rows.push({
      ruleId: rowId(path, "blocked"),
      surface: path,
      selectors: [BEDROCK],
      kind: "blocked",
      source: "both",
      expectedShapes: COMMAND_SHAPES,
      reason: "Raw Bedrock inference commands cannot be metered safely",
    });
  }

  const unsupportedSelectors = [ANTHROPIC, GOOGLE_GENAI, GOOGLE_LEGACY, BEDROCK] as const;
  for (const namespace of [
    "embeddings",
    "images",
    "audio",
    "audio.transcriptions",
    "audio.speech",
    "videos",
  ]) {
    rows.push(namespaceRow(namespace, unsupportedSelectors, "unsupported-wrapper", "wrapper"));
  }
  for (const path of [
    "embeddings.create",
    "images.generate",
    "images.edit",
    "audio.transcriptions.create",
    "audio.speech.create",
    "videos.create",
  ]) {
    rows.push({
      ruleId: rowId(path, "unsupported", "wrapper"),
      surface: path,
      selectors: unsupportedSelectors,
      kind: "unsupported",
      source: "wrapper",
      expectedShapes: METHOD_SHAPES,
      reason: "The provider cannot dispatch this wrapper owned media operation safely",
    });
  }

  rows.push({
    ruleId: rowId("close", "infrastructure", "wrapper"),
    surface: "close",
    selectors: ALL_CLIENTS,
    kind: "infrastructure",
    source: "wrapper",
    expectedShapes: METHOD_SHAPES,
  });
  rows.push({
    ruleId: rowId("timeout", "infrastructure", "raw"),
    surface: "timeout",
    selectors: ALL_CLIENTS,
    kind: "infrastructure",
    source: "raw",
    expectedShapes: SCALAR_SHAPES,
  });
  rows.push({
    ruleId: rowId("logger", "infrastructure", "raw"),
    surface: "logger",
    selectors: ALL_CLIENTS,
    kind: "infrastructure",
    source: "raw",
    expectedShapes: RESOURCE_SHAPES,
  });
  for (const path of ["authHeaders", "defaultHeaders", "defaultQuery"]) {
    rows.push(unmeteredRow(path, [COMPAT, TOGETHER_NATIVE, ANTHROPIC], "operation"));
  }
  for (const path of [
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
  ]) {
    rows.push({
      ruleId: rowId(path, "metadata"),
      surface: path,
      selectors: ALL_CLIENTS,
      kind: "metadata",
      source: "raw",
      expectedShapes: INERT_METADATA_SHAPES,
    });
  }

  for (const path of [
    "files",
    "skills",
    "skills.versions",
    "beta",
    "beta.files",
    "beta.skills",
    "beta.skills.versions",
  ]) {
    rows.push(namespaceRow(path, [ANTHROPIC], "anthropic-direct", "raw"));
  }
  for (const path of [
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
    "beta.skills.versions.download",
    "beta.skills.versions.list",
    "beta.skills.versions.retrieve",
  ]) {
    rows.push(unmeteredRow(path, [ANTHROPIC], "operation"));
  }

  return rows;
}

/** Curated literals consumed by the contract builder in `surfaces.ts`. */
export const SURFACE_RULE_INPUTS: readonly SurfaceRuleInput[] = curatedRuleInputs();

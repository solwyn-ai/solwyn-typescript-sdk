/**
 * Synchronous, descriptor-only provider identity detection.
 *
 * This module is the small eager half of the provider registry. It contains no concrete
 * adapters and imports no provider SDKs, so callers can derive the attribution provider and
 * wire dialect before the lazy adapter graph is loaded. Concrete adapters delegate their
 * `detectClient` methods back to these predicates, keeping synchronous and asynchronous
 * detection on one set of rules.
 */

import { ConfigurationError } from "../errors";
import { PROVIDER_NAMES, type ProviderName } from "../types";
import type { Dialect } from "./protocol";

export interface ProviderIdentity {
  readonly provider: ProviderName;
  readonly dialect: Dialect;
}

/** Constructor config for a {@link CompatProfile}. All fields default except `name`. */
export interface CompatProfileConfig {
  name: ProviderName;
  hosts?: readonly string[];
  hostSuffixes?: readonly string[];
  localPorts?: readonly number[];
  modelPrefixes?: readonly string[];
  clientClassPrefixes?: readonly string[];
  supportsIncludeUsage?: boolean;
  supportsResponses?: boolean;
  catchAll?: boolean;
}

/** Conventional local-inference hostnames (exact set). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function isOpenAIHost(host: string): boolean {
  return host === "api.openai.com" || host.endsWith(".api.openai.com");
}

/** Immutable per-vendor detection/injection profile. Pure, no I/O. */
export class CompatProfile {
  readonly name: ProviderName;
  readonly hosts: readonly string[];
  readonly hostSuffixes: readonly string[];
  readonly localPorts: readonly number[];
  readonly modelPrefixes: readonly string[];
  readonly clientClassPrefixes: readonly string[];
  readonly supportsIncludeUsage: boolean;
  readonly supportsResponses: boolean;
  readonly catchAll: boolean;

  constructor(config: CompatProfileConfig) {
    this.name = config.name;
    this.hosts = config.hosts ?? [];
    this.hostSuffixes = config.hostSuffixes ?? [];
    this.localPorts = config.localPorts ?? [];
    this.modelPrefixes = config.modelPrefixes ?? [];
    this.clientClassPrefixes = config.clientClassPrefixes ?? [];
    this.supportsIncludeUsage = config.supportsIncludeUsage ?? true;
    this.supportsResponses = config.supportsResponses ?? false;
    this.catchAll = config.catchAll ?? false;
    Object.freeze(this);
  }

  matchesUrl(scheme: string, host: string, port: number | null): boolean {
    if (this.catchAll) {
      return (scheme === "http" || scheme === "https") && !isOpenAIHost(host);
    }
    if (this.hosts.includes(host)) {
      return true;
    }
    if (this.hostSuffixes.some((suffix) => host.endsWith(suffix))) {
      return true;
    }
    return port !== null && LOCAL_HOSTS.has(host) && this.localPorts.includes(port);
  }

  matchedByLocalPort(host: string): boolean {
    return this.localPorts.length > 0 && LOCAL_HOSTS.has(host);
  }
}

/**
 * OpenAI-compatible profiles in registry-detection order. The catch-all must remain last.
 * Adapter construction and synchronous detection both consume this exact table.
 */
export const COMPAT_PROFILES: readonly CompatProfile[] = Object.freeze([
  new CompatProfile({
    name: "xai",
    hosts: ["api.x.ai"],
    modelPrefixes: ["grok-"],
    supportsIncludeUsage: false,
  }),
  new CompatProfile({
    name: "deepseek",
    hosts: ["api.deepseek.com"],
    modelPrefixes: ["deepseek-"],
    supportsIncludeUsage: true,
  }),
  new CompatProfile({
    name: "mistral",
    hosts: ["api.mistral.ai"],
    modelPrefixes: [
      "mistral-",
      "ministral-",
      "codestral-",
      "magistral-",
      "pixtral-",
      "devstral-",
      "open-mistral-",
      "open-mixtral-",
    ],
    supportsIncludeUsage: false,
  }),
  new CompatProfile({
    name: "qwen",
    hosts: ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"],
    modelPrefixes: ["qwen", "qwq-", "qvq-"],
    supportsIncludeUsage: true,
  }),
  new CompatProfile({
    name: "zai",
    hosts: ["api.z.ai"],
    modelPrefixes: ["glm-"],
    supportsIncludeUsage: true,
  }),
  new CompatProfile({
    name: "groq",
    hosts: ["api.groq.com"],
    supportsIncludeUsage: true,
  }),
  new CompatProfile({
    name: "together",
    hosts: ["api.together.xyz", "api.together.ai"],
    supportsIncludeUsage: false,
  }),
  new CompatProfile({
    name: "fireworks",
    hosts: ["api.fireworks.ai"],
    modelPrefixes: ["accounts/fireworks/"],
    supportsIncludeUsage: false,
  }),
  new CompatProfile({
    name: "perplexity",
    hosts: ["api.perplexity.ai"],
    modelPrefixes: ["sonar"],
    supportsIncludeUsage: false,
  }),
  new CompatProfile({
    name: "azure_openai",
    hostSuffixes: [".openai.azure.com", ".cognitiveservices.azure.com"],
    clientClassPrefixes: ["AzureOpenAI", "AsyncAzureOpenAI"],
    supportsIncludeUsage: true,
    supportsResponses: true,
  }),
  new CompatProfile({
    name: "openrouter",
    hosts: ["openrouter.ai"],
    supportsIncludeUsage: false,
  }),
  new CompatProfile({
    name: "ollama",
    localPorts: [11434],
    supportsIncludeUsage: true,
  }),
  new CompatProfile({
    name: "vllm",
    localPorts: [8000],
    supportsIncludeUsage: true,
  }),
  new CompatProfile({
    name: "lmstudio",
    localPorts: [1234],
    supportsIncludeUsage: true,
  }),
  new CompatProfile({
    name: "openai_compatible",
    supportsIncludeUsage: false,
    catchAll: true,
  }),
]);

/**
 * Final provider registration order. Deriving the compatibility portion from
 * {@link COMPAT_PROFILES} prevents eager identity detection and lazy adapter loading from
 * drifting apart.
 */
export const ADAPTER_REGISTRATION_ORDER: readonly ProviderName[] = Object.freeze([
  ...COMPAT_PROFILES.map((profile) => profile.name),
  "openai",
  "anthropic",
  "google",
  "bedrock",
]);

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** Static property lookup that never invokes an accessor. */
function staticProperty(value: unknown, key: string): unknown {
  if (!isObjectLike(value)) {
    return undefined;
  }
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < 24; depth += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(current, key);
    } catch {
      return undefined;
    }
    if (descriptor !== undefined) {
      return "value" in descriptor ? descriptor.value : undefined;
    }
    try {
      current = Reflect.getPrototypeOf(current);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function staticPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    current = staticProperty(current, segment);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/** Content-free constructor labels from the instance's prototype chain. */
function constructorNames(value: unknown): readonly string[] {
  if (!isObjectLike(value)) {
    return [];
  }
  const names: string[] = [];
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < 24; depth += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(current, "constructor");
    } catch {
      return names;
    }
    const ctor = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    const name = typeof ctor === "function" ? staticProperty(ctor, "name") : null;
    if (typeof name === "string" && name.length > 0) {
      names.push(name);
    }
    try {
      current = Reflect.getPrototypeOf(current);
    } catch {
      return names;
    }
  }
  return names;
}

function constructorName(value: unknown): string | null {
  return constructorNames(value)[0] ?? null;
}

function hasCallable(value: unknown, ...path: string[]): boolean {
  return typeof staticPath(value, path) === "function";
}

export function detectOpenAIClient(client: unknown): boolean {
  if (hasCallable(client, "chat", "completions", "create")) {
    return true;
  }
  return constructorName(client)?.toLowerCase().includes("openai") ?? false;
}

export function detectAnthropicClient(client: unknown): boolean {
  if (hasCallable(client, "messages", "create")) {
    return true;
  }
  return constructorName(client)?.toLowerCase().includes("anthropic") ?? false;
}

export function detectGoogleClient(client: unknown): boolean {
  return (
    hasCallable(client, "models", "generateContent") &&
    hasCallable(client, "models", "generateContentStream")
  );
}

export function detectBedrockClient(client: unknown): boolean {
  if (staticPath(client, ["meta", "service_model", "service_name"]) === "bedrock-runtime") {
    return true;
  }
  return constructorNames(client).some((name) => name.toLowerCase().includes("bedrockruntime"));
}

export function detectNativeTogetherClient(client: unknown): boolean {
  return (
    hasCallable(client, "chat", "completions", "create") &&
    constructorNames(client).some((name) => name.includes("Together"))
  );
}

function clientBaseUrl(client: unknown): unknown {
  const camel = staticProperty(client, "baseURL");
  if (camel !== undefined && camel !== null && camel !== "") {
    return camel;
  }
  return staticProperty(client, "base_url");
}

function parseUrlParts(value: unknown): [string, string, number | null] | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const url = new URL(value);
    const scheme = url.protocol.replace(":", "").toLowerCase();
    const rawHost = url.hostname.toLowerCase();
    const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
    const port = url.port === "" ? null : Number(url.port);
    return [scheme, host, port];
  } catch {
    return null;
  }
}

export interface CompatClientMatch {
  readonly matched: boolean;
  readonly matchedByLocalPort: boolean;
}

export function matchOpenAICompatibleClient(
  client: unknown,
  profile: CompatProfile,
): CompatClientMatch {
  if (!detectOpenAIClient(client)) {
    return { matched: false, matchedByLocalPort: false };
  }
  const className = constructorName(client);
  if (
    className !== null &&
    profile.clientClassPrefixes.some((prefix) => className.startsWith(prefix))
  ) {
    return { matched: true, matchedByLocalPort: false };
  }
  const parts = parseUrlParts(clientBaseUrl(client));
  if (parts === null) {
    return { matched: false, matchedByLocalPort: false };
  }
  const [scheme, host, port] = parts;
  const matched = profile.matchesUrl(scheme, host, port);
  return {
    matched,
    matchedByLocalPort: matched && profile.matchedByLocalPort(host),
  };
}

function dialectForProvider(provider: ProviderName): Dialect {
  if (provider === "anthropic" || provider === "google" || provider === "bedrock") {
    return provider;
  }
  return "openai";
}

function profileByName(name: ProviderName): CompatProfile | undefined {
  return COMPAT_PROFILES.find((profile) => profile.name === name);
}

function providerMatchesClient(provider: ProviderName, client: unknown): boolean {
  const profile = profileByName(provider);
  if (profile !== undefined) {
    if (provider === "together" && detectNativeTogetherClient(client)) {
      return true;
    }
    return matchOpenAICompatibleClient(client, profile).matched;
  }
  if (provider === "openai") {
    return detectOpenAIClient(client);
  }
  if (provider === "anthropic") {
    return detectAnthropicClient(client);
  }
  if (provider === "google") {
    return detectGoogleClient(client);
  }
  return detectBedrockClient(client);
}

function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pinned families require object namespaces, not callable namespace substitutes. */
function familyProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? staticProperty(value, key) : undefined;
}

function familyCallable(value: unknown, ...path: string[]): boolean {
  let current = value;
  for (const key of path) {
    current = familyProperty(current, key);
  }
  return typeof current === "function";
}

function isPinnedBedrockRuntimeClient(client: unknown): boolean {
  if (!familyCallable(client, "send")) {
    return false;
  }
  const serviceName = familyProperty(
    familyProperty(familyProperty(client, "meta"), "service_model"),
    "service_name",
  );
  const ctor = familyProperty(client, "constructor");
  const name = typeof ctor === "function" ? staticProperty(ctor, "name") : undefined;
  const className = typeof name === "string" ? name.toLowerCase() : "";
  return (
    serviceName === "bedrock-runtime" ||
    className.includes("bedrockruntime") ||
    (isRecord(familyProperty(client, "config")) &&
      isRecord(familyProperty(client, "middlewareStack")))
  );
}

/** Shared construction/lazy pin gate. Inspect descriptors without evaluating getters. */
export function validatePinnedClientFamily(
  client: unknown,
  provider: string,
  dialect: Dialect,
): void {
  let valid = false;
  let requirement: string;
  if (dialect === "openai") {
    valid =
      familyCallable(client, "chat", "completions", "create") ||
      familyCallable(client, "responses", "create");
    requirement = "an OpenAI-compatible";
  } else if (provider === "anthropic") {
    valid = familyCallable(client, "messages", "create");
    requirement = "an Anthropic";
  } else if (provider === "google") {
    valid = familyCallable(client, "models", "generateContent");
    requirement = "a Google GenAI";
  } else {
    valid = isPinnedBedrockRuntimeClient(client);
    requirement = "a bedrock-runtime";
  }
  if (!valid) {
    throw new ConfigurationError(
      `unsupported provider client pairing: provider '${provider}' requires ${requirement} client`,
      { field: "client" },
    );
  }
}

/** Stable, content-free runtime type label for detection errors. */
export function describeDetectedClientType(client: unknown): string {
  if (client === null) {
    return "null";
  }
  if (!isObjectLike(client)) {
    return typeof client;
  }
  return constructorName(client) ?? "object";
}

/**
 * Resolve attribution provider plus wire dialect synchronously.
 *
 * An explicit provider pin is authoritative and bypasses structural inspection, matching
 * the async registry's override semantics. Client-family validation is a separate gate
 * shared by construction and lazy adapter resolution. Without a pin, first match in
 * {@link ADAPTER_REGISTRATION_ORDER} wins.
 */
export function resolveProviderIdentity(
  client: unknown,
  providerOverride?: string,
): ProviderIdentity {
  if (providerOverride !== undefined) {
    if (!isProviderName(providerOverride)) {
      throw new ConfigurationError(
        `Unknown provider '${providerOverride}'. Known: ${[...PROVIDER_NAMES].sort().join(", ")}`,
        { field: "provider" },
      );
    }
    return Object.freeze({
      provider: providerOverride,
      dialect: dialectForProvider(providerOverride),
    });
  }

  for (const provider of ADAPTER_REGISTRATION_ORDER) {
    if (providerMatchesClient(provider, client)) {
      return Object.freeze({ provider, dialect: dialectForProvider(provider) });
    }
  }
  throw new ConfigurationError(
    `Could not detect a provider adapter for client type '${describeDetectedClientType(client)}': it is not a recognized provider SDK client`,
    { field: "provider" },
  );
}

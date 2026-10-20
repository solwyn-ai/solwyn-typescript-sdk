/**
 * OpenTelemetry privacy firewall for the source tree.
 *
 * Trace correlation reads exactly three content-free values (trace id, span id, sampled
 * flag) from the application's active span. These source scans pin that boundary so a
 * later change cannot widen it silently:
 *
 *  - no module imports, requires, or re-exports any `@opentelemetry/*` package (the
 *    capture reads the API's process-global registry instead), and only
 *    `src/trace-context.ts` names the registry or its context keys;
 *  - no source calls or names an OpenTelemetry API that could read span content, record
 *    exception text, enable content capture, or propagate/inject trace state or baggage;
 *  - `src/trace-context.ts` touches only an allowlisted set of members, and destructures
 *    only `traceId` / `spanId` / `traceFlags` from a span context;
 *  - the trace is captured at exactly two call-start sites, every metadata-event builder
 *    stamps the closed-over snapshot, and aggregated receipt replays never carry one;
 *  - background work launched from a caller's path runs outside the caller's trace.
 *
 * Mirrors the Python SDK's `test_otel_privacy_firewall.py`. This is a source-scanning test;
 * it reads files off disk and never imports them. Self-tests prove each detector fires.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");
const CAPTURE_MODULE = "trace-context.ts";

interface SourceFile {
  readonly rel: string;
  readonly text: string;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const ALL_SOURCES: readonly SourceFile[] = listTsFiles(SRC_ROOT).map((abs) => ({
  rel: relative(SRC_ROOT, abs).split(sep).join("/"),
  text: readFileSync(abs, "utf8"),
}));

function source(rel: string): SourceFile {
  const found = ALL_SOURCES.find((file) => file.rel === rel);
  if (found === undefined) throw new Error(`missing source ${rel}`);
  return found;
}

function parse(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(file.rel, file.text, ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Identifier names and string/template literal texts in a file (comments never included). */
function codeTokens(file: SourceFile): string[] {
  const tokens: string[] = [];
  walk(parse(file), (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) tokens.push(node.text);
    else if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node))
      tokens.push(node.text);
  });
  return tokens;
}

// ---------------------------------------------------------------------------
// Detectors (pure functions over source text, self-tested below).
// ---------------------------------------------------------------------------

/** Module specifiers of every import/export/require/dynamic import in a file. */
function moduleSpecifiers(file: SourceFile): string[] {
  const specifiers: string[] = [];
  walk(parse(file), (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        specifiers.push(argument.literal.text);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      const isLoader =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
      if (isLoader && first !== undefined && ts.isStringLiteralLike(first)) {
        specifiers.push(first.text);
      }
    }
  });
  return specifiers;
}

function importsOpenTelemetry(file: SourceFile): boolean {
  return moduleSpecifiers(file).some((specifier) => specifier.startsWith("@opentelemetry/"));
}

/**
 * OpenTelemetry and provider-telemetry names that would read span content, record
 * exception text, start or annotate spans, enable content capture, or propagate state.
 * Matched as identifiers and as whole words inside string literals, so a computed
 * `obj["recordException"]` or option key is caught too; comments are never scanned.
 */
const BANNED_OTEL_NAMES = [
  "recordException",
  "record_exception",
  "addEvent",
  "addLink",
  "setAttribute",
  "setAttributes",
  "setStatus",
  "updateName",
  "startSpan",
  "startActiveSpan",
  "getTracer",
  "contentMode",
  "content_mode",
  "maxContentBytes",
  "max_content_bytes",
  "traceState",
  "tracestate",
  "traceparent",
  "getBaggage",
  "setBaggage",
  "getActiveBaggage",
  "createBaggage",
  "getAllEntries",
  "getEntry",
  "propagation",
  "inject",
  "getTextMapPropagator",
  "openTelemetry",
  "open_telemetry",
  "conversationId",
  "conversation_id",
] as const;

function bannedNameHits(file: SourceFile): string[] {
  const tokens = codeTokens(file);
  return BANNED_OTEL_NAMES.filter((name) =>
    tokens.some((token) => new RegExp(`\\b${name}\\b`).test(token)),
  ).map((name) => `${file.rel}: ${name}`);
}

/** Registry/context-key descriptions that only the capture module may name. */
const REGISTRY_MARKERS = [
  "opentelemetry.js.api",
  "OpenTelemetry Context Key",
  "OpenTelemetry Baggage Key",
] as const;

function registryMarkerHits(file: SourceFile): string[] {
  const tokens = codeTokens(file);
  return REGISTRY_MARKERS.filter((marker) => tokens.some((token) => token.includes(marker))).map(
    (marker) => `${file.rel}: ${marker}`,
  );
}

/** Every member name the capture module reads, calls, or destructures. */
function accessedMembers(file: SourceFile): Set<string> {
  const names = new Set<string>();
  walk(parse(file), (node) => {
    if (ts.isPropertyAccessExpression(node)) names.add(node.name.text);
    if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      names.add(ts.isStringLiteralLike(argument) ? argument.text : `[${argument.getText()}]`);
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      names.add(ts.isIdentifier(key) ? key.text : key.getText());
    }
  });
  return names;
}

/** `file:enclosingFunction` for every call to `callee` (definitions excluded). */
function callSites(file: SourceFile, callee: string): string[] {
  const sites: string[] = [];
  walk(parse(file), (node) => {
    if (!ts.isCallExpression(node)) return;
    const expression = node.expression;
    if (!ts.isIdentifier(expression) || expression.text !== callee) return;
    sites.push(`${file.rel}:${enclosingFunctionName(node)}`);
  });
  return sites;
}

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name !== undefined
    ) {
      return current.name.getText();
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent)
    ) {
      return current.parent.name.getText();
    }
  }
  return "<module>";
}

/**
 * Functions that build a `MetadataEvent` object literal, mapped to whether their body
 * stamps the closed-over trace (directly, or through the core run-receipt helper).
 */
function eventBuilders(file: SourceFile): Array<{ name: string; stampsTrace: boolean }> {
  const builders: Array<{ name: string; stampsTrace: boolean }> = [];
  walk(parse(file), (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      node.type === undefined ||
      node.type.getText() !== "MetadataEvent" ||
      node.initializer === undefined ||
      !ts.isObjectLiteralExpression(node.initializer)
    ) {
      return;
    }
    let body: ts.Node | undefined = node.parent;
    while (body !== undefined && !ts.isFunctionLike(body)) body = body.parent;
    const text = body?.getText() ?? "";
    builders.push({
      name: `${file.rel}:${body === undefined ? "<module>" : enclosingFunctionName(node)}`,
      stampsTrace:
        /\bapplyTraceFields\(event\b/.test(text) || /#applyRunReceipt\(event\b/.test(text),
    });
  });
  return builders;
}

function synthetic(text: string, rel = "synthetic.ts"): SourceFile {
  return { rel, text };
}

// ---------------------------------------------------------------------------
// Source scans.
// ---------------------------------------------------------------------------

describe("OpenTelemetry privacy firewall", () => {
  it("no source imports, requires, or re-exports an @opentelemetry package", () => {
    expect(ALL_SOURCES.filter(importsOpenTelemetry).map((file) => file.rel)).toEqual([]);
  });

  it("only the capture module names the OpenTelemetry registry or its context keys", () => {
    const hits = ALL_SOURCES.filter((file) => file.rel !== CAPTURE_MODULE).flatMap(
      registryMarkerHits,
    );
    expect(hits).toEqual([]);
    expect(registryMarkerHits(source(CAPTURE_MODULE))).toEqual([
      `${CAPTURE_MODULE}: opentelemetry.js.api`,
      `${CAPTURE_MODULE}: OpenTelemetry Context Key`,
      `${CAPTURE_MODULE}: OpenTelemetry Baggage Key`,
    ]);
  });

  it("no source names an API that reads span content, records errors, or propagates state", () => {
    expect(ALL_SOURCES.flatMap(bannedNameHits)).toEqual([]);
  });

  it("the capture module touches only allowlisted members", () => {
    expect([...accessedMembers(source(CAPTURE_MODULE))].sort()).toEqual(
      [
        // Registry and context-manager protocol.
        "[OTEL_API_REGISTRY_KEY]",
        "for",
        "version",
        "startsWith",
        "context",
        "active",
        "with",
        "getValue",
        "deleteValue",
        // The span: its context accessor only.
        "spanContext",
        // The span context: identifiers and flags only (never traceState).
        "traceId",
        "spanId",
        "traceFlags",
        // The snapshot and primitive helpers.
        "sampled",
        "trace_id",
        "span_id",
        "trace_sampled",
        "toLowerCase",
        "test",
        "isInteger",
        "freeze",
        "repeat",
        "apply",
      ].sort(),
    );
  });

  it("captures the trace at exactly the two call-start sites", () => {
    expect(ALL_SOURCES.flatMap((file) => callSites(file, "captureTrace")).sort()).toEqual([
      "ai-sdk/index.ts:preflight",
      "client.ts:captureCallAttribution",
    ]);
  });

  it("every metadata-event builder stamps the call-start snapshot", () => {
    const builders = ALL_SOURCES.filter(
      (file) => file.rel !== "receipt-fold.ts" && file.rel !== "testing/contract.ts",
    ).flatMap(eventBuilders);
    expect(builders.map((builder) => builder.name).sort()).toEqual([
      "ai-sdk/index.ts:buildEvent",
      "client.ts:#baseEvent",
      "client.ts:#buildMediaEvent",
      "client.ts:#buildRegistryDeniedEvent",
    ]);
    expect(builders.filter((builder) => !builder.stampsTrace)).toEqual([]);
    expect(source("client.ts").text).toMatch(
      /#applyRunReceipt\(event: MetadataEvent[^{]*\{[\s\S]*?applyTraceFields\(event, run\.trace\)/,
    );
  });

  it("aggregate receipt replays and contract probes never carry a trace", () => {
    for (const rel of ["receipt-fold.ts", "testing/contract.ts"]) {
      expect(codeTokens(source(rel)).filter((token) => /trace/i.test(token))).toEqual([]);
    }
  });

  it("background work and memoized lifecycle promises run outside the caller's trace", () => {
    expect(ALL_SOURCES.flatMap((file) => callSites(file, "withoutTraceContext")).sort()).toEqual([
      "budget.ts:launchRenewal",
      "client.ts:#ensureInit",
      "client.ts:close",
      "release-dispatcher.ts:#pump",
      "reporter.ts:close",
      "reporter.ts:close",
      "reporter.ts:start",
      "untracked-reporter.ts:#requestFlush",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Detector self-tests: each synthetic violation must be flagged.
// ---------------------------------------------------------------------------

describe("OpenTelemetry firewall detectors", () => {
  it.each([
    'import { trace } from "@opentelemetry/api";',
    'import type { Span } from "@opentelemetry/api";',
    'export { context } from "@opentelemetry/api";',
    'import "@opentelemetry/api";',
    'const api = await import("@opentelemetry/api");',
    'const api = require("@opentelemetry/api");',
    'type Span = import("@opentelemetry/api").Span;',
  ])("flags an OpenTelemetry module reference: %s", (text) => {
    expect(importsOpenTelemetry(synthetic(text))).toBe(true);
  });

  it("does not flag unrelated imports", () => {
    expect(importsOpenTelemetry(synthetic('import { z } from "zod";'))).toBe(false);
  });

  it.each([
    ["span.recordException(error);", "recordException"],
    ['span["recordException"](error);', "recordException"],
    ['span.setAttribute("solwyn.call_id", id);', "setAttribute"],
    ["span.addEvent(name);", "addEvent"],
    ['const options = { traces: { contentMode: "content" } };', "contentMode"],
    ["const options = { max_content_bytes: 1 };", "max_content_bytes"],
    ["propagationApi.inject(context.active(), headers);", "inject"],
    ["inject(context.active(), headers);", "inject"],
    ["const state = spanContext.traceState;", "traceState"],
    ['headers["traceparent"] = value;', "traceparent"],
    ["const baggage = propagationApi.getBaggage(ctx);", "getBaggage"],
    ["client.openTelemetry;", "openTelemetry"],
    ["const options = { conversationId: runId };", "conversationId"],
  ])("flags a banned OpenTelemetry name: %s", (text, name) => {
    expect(bannedNameHits(synthetic(text))).toEqual([`synthetic.ts: ${name}`]);
  });

  it("ignores banned names that appear only in comments", () => {
    expect(
      bannedNameHits(synthetic("// never call recordException or inject\nconst x = 1;")),
    ).toEqual([]);
  });

  it("flags registry markers outside the capture module", () => {
    expect(
      registryMarkerHits(synthetic('const key = Symbol.for("opentelemetry.js.api.1");')),
    ).toEqual(["synthetic.ts: opentelemetry.js.api"]);
  });

  it("records attributes, trace state, and computed reads as accessed members", () => {
    const members = accessedMembers(
      synthetic("const { traceState } = sc; span.attributes; span[key]; span['name'];"),
    );
    expect([...members].sort()).toEqual(["[key]", "attributes", "name", "traceState"]);
  });

  it("flags a metadata-event builder that does not stamp the trace", () => {
    expect(
      eventBuilders(
        synthetic(
          "function build(): MetadataEvent { const event: MetadataEvent = { model: '' }; return event; }",
        ),
      ),
    ).toEqual([{ name: "synthetic.ts:build", stampsTrace: false }]);
  });

  it("finds capture call sites by enclosing function", () => {
    expect(
      callSites(
        synthetic("function a() { captureTrace(); } const b = () => captureTrace();"),
        "captureTrace",
      ),
    ).toEqual(["synthetic.ts:a", "synthetic.ts:b"]);
  });
});

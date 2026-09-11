/**
 * Path-based privacy firewall for the source tree.
 *
 * Scans every `.ts` file under `src/` EXCEPT the content-privileged allowlist
 * (`src/privacy.ts`, the whole `src/providers/translation/` package, and the
 * `src/ai-sdk/` entry) and asserts that no non-privileged module can leak prompt/
 * response content:
 *
 *  - no logger call receives a content-bearing bareword (content/messages/prompt/
 *    contents/system/text/response) or a content-carrying dict variable (kwargs/
 *    payload/merged/shaped/chunk/…), no logger call references a BARE exception object
 *    (only an approved class-name helper projection, anywhere in the arg), and every
 *    `src/stream.ts` logger call
 *    is restricted to a literal template + error-class-name interpolations only;
 *  - the SDK<->Cloud wire models declare no forbidden content field name;
 *  - no non-privileged file carries the `PRIVACY-CRITICAL` banner, and every
 *    privileged file that exists DOES (banner set == allowlist);
 *  - structural edge-safety guards: no `node:*` import outside `src/node.ts`, and no
 *    value import of a provider SDK anywhere (type-only / dynamic-in-try allowed).
 *
 * This is a source-scanning test — it reads the files off disk, it does not import them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");

/** Content-privileged paths (relative to src/, POSIX-style). Everything else is firewalled. */
const PRIVILEGED_PREFIXES = ["privacy.ts", "providers/translation/", "ai-sdk/"];

/** Provider-SDK packages that must never be VALUE-imported anywhere in core. */
const PROVIDER_SDK_PACKAGES = [
  "openai",
  "@anthropic-ai/sdk",
  "@google/genai",
  "@google/generative-ai",
  "@aws-sdk/client-bedrock-runtime",
];

/** Wire content fields that must never be declared on the SDK<->Cloud wire models. */
const FORBIDDEN_WIRE_FIELDS = [
  "messages",
  "content",
  "system",
  "contents",
  "prompt",
  "text",
  "input",
  "response",
];

/** Content barewords / content-carrying dict vars banned from any logger-call argument. */
const CONTENT_TOKENS = [
  "content",
  "messages",
  "prompt",
  "contents",
  "system",
  "text",
  // The provider response object is commonly held in a variable named `response`, so
  // it is subject to the same content-bearing restriction as the other barewords.
  "response",
];
const CONTENT_DICT_VARS = [
  // Common content-carrying request and payload names.
  "kwargs",
  "fallback_kwargs",
  "translated_kwargs",
  "call_kwargs",
  "payload",
  "request_body",
  // Content-carrying variable names holding request params, responses, or
  // stream objects (client.ts, providers/openai.ts, stream.ts). Their absence let a
  // `JSON.stringify(merged)` / `JSON.stringify(chunk)` leak sail past the firewall.
  "merged",
  "shaped",
  "base",
  "next",
  "rawResponse",
  "chunk",
];
/** Bare exception identifiers that must never appear (bare) in a logger argument. */
const BARE_EXCEPTION_ARGS = ["exc", "exception", "error", "err", "e"];

/**
 * The ONLY exception-derived expression shape a logger argument may reference: an
 * approved class-name helper projection, never direct constructor access or the
 * exception's message/body (which a provider SDK may embed request/response content
 * into). Only explicit class-name projections are allowed.
 */
const ERROR_CLASS_NAME_EXPRS: RegExp[] = [
  // Content-free class-name helpers project only safe type metadata, never the
  // message/body. Direct `.constructor.name` is deliberately not approved.
  /\b(?:safeErrorClassName|errorClassName|errorName|exceptionName)\s*\(\s*\w+\s*\)/g,
  /\b\w+\.name\b/g,
];

/** Whole-expression match for an approved error-class-name shape (stream.ts guard). */
const APPROVED_ERROR_CLASS_EXPR =
  /^(?:safeErrorClassName|errorClassName|errorName|exceptionName)\(\s*\w+\s*\)$|^\w+\.name$/;

/** Remove approved error-class-name sub-expressions so the residual can be scanned for
 * any exception identifier that leaked through in a CONTENT-bearing form
 * (`${error}`, `String(error)`, `error.message`, a bare `error`, …). */
function stripErrorClassNameExprs(text: string): string {
  let out = text;
  for (const re of ERROR_CLASS_NAME_EXPRS) {
    out = out.replace(re, " ");
  }
  return out;
}

interface SourceFile {
  /** Path relative to src/, POSIX-normalized (e.g. "providers/openai.ts"). */
  rel: string;
  abs: string;
  text: string;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function loadSources(): SourceFile[] {
  return listTsFiles(SRC_ROOT).map((abs) => ({
    rel: relative(SRC_ROOT, abs).split(sep).join("/"),
    abs,
    text: readFileSync(abs, "utf8"),
  }));
}

function isPrivileged(rel: string): boolean {
  return PRIVILEGED_PREFIXES.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));
}

const ALL_SOURCES = loadSources();
const FIREWALLED = ALL_SOURCES.filter((f) => !isPrivileged(f.rel));
const TESTING_SOURCES = ALL_SOURCES.filter((f) => f.rel.startsWith("testing/"));

/** Remove line + block comments, KEEPING string/template literals (import paths live there). */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Strip string/template literal TEXT while keeping template `${...}` expression text
 * (which could reference a content variable). Comments are also removed so a banned
 * word in prose never trips the scan.
 */
function stripLiteralsAndComments(code: string): string {
  const noComments = stripComments(code);
  return noComments
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => {
      const exprs = [...m.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1] ?? "").join(" ; ");
      return `\`${exprs}\``;
    });
}

/** Extract the balanced-paren argument string starting at `open` (index of "("). */
function balancedArgs(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

/** Split top-level (comma-separated) arguments, ignoring commas nested in (), [], {}. */
function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function findLoggerViolations(file: SourceFile): string[] {
  const code = stripLiteralsAndComments(file.text);
  const violations: string[] = [];
  const callRe = /\blogger\s*\.\s*(?:debug|info|warn|error|log)\s*\(/g;
  let match: RegExpExecArray | null = callRe.exec(code);
  while (match !== null) {
    const open = match.index + match[0].length - 1;
    const args = balancedArgs(code, open);
    for (const token of [...CONTENT_TOKENS, ...CONTENT_DICT_VARS]) {
      if (new RegExp(`\\b${token}\\b`).test(args)) {
        violations.push(`${file.rel}: logger call references banned token '${token}'`);
      }
    }
    // Bare-exception guard: an exception identifier is allowed ONLY inside an approved
    // error-class-name helper projection (or the retained validated `.name` shape). Strip
    // those first, then scan the residual on WORD BOUNDARIES — so `${error}`,
    // `String(error)`, `error.message`, and a bare `error` positional all trip it,
    // while `errorName(error)` / `${errorClassName(err)}` do not.
    const residual = stripErrorClassNameExprs(args);
    for (const name of BARE_EXCEPTION_ARGS) {
      if (new RegExp(`\\b${name}\\b`).test(residual)) {
        violations.push(
          `${file.rel}: logger call references exception '${name}' outside an error-class-name expression`,
        );
      }
    }
    match = callRe.exec(code);
  }
  return violations;
}

/**
 * Whole-file logger restriction for `src/stream.ts`. This module is the
 * module that touches every streamed content chunk, so its settlement-suppression logs
 * are held to a stricter rule than the shared bareword scan: every logger call may pass
 * ONLY a literal string/template whose `${...}` interpolations are each an approved
 * error-class-name expression (`safeErrorClassName(x)` / `errorClassName(x)` / `x.name`) —
 * no bareword content, no arbitrary interpolation, no non-literal positional argument.
 */
function findStreamLoggerViolations(file: SourceFile): string[] {
  const code = stripLiteralsAndComments(file.text);
  const violations: string[] = [];
  const callRe = /\blogger\s*\.\s*(?:debug|info|warn|error|log)\s*\(/g;
  let match: RegExpExecArray | null = callRe.exec(code);
  while (match !== null) {
    const open = match.index + match[0].length - 1;
    const args = balancedArgs(code, open);
    for (const arg of splitTopLevel(args)) {
      // Stripped string literals ("" / '') are always allowed as the message template.
      if (arg === '""' || arg === "''") continue;
      if (arg.startsWith("`") && arg.endsWith("`")) {
        // A template: each preserved `${...}` interpolation must be error-class-name.
        const interpolations = arg
          .slice(1, -1)
          .split(" ; ")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const expr of interpolations) {
          if (!APPROVED_ERROR_CLASS_EXPR.test(expr)) {
            violations.push(
              `${file.rel}: stream logger interpolates non-error-class-name expression '${expr}'`,
            );
          }
        }
        continue;
      }
      // Any other positional argument must itself be an approved error-class-name shape.
      if (!APPROVED_ERROR_CLASS_EXPR.test(arg)) {
        violations.push(`${file.rel}: stream logger passes disallowed argument '${arg}'`);
      }
    }
    match = callRe.exec(code);
  }
  return violations;
}

/**
 * Persistent StreamWrapper state is fail-closed. The approved fields are lifecycle
 * primitives or opaque capabilities; translated output waiting between pulls belongs only
 * behind `#translationCursor` in the privileged translation package. A new field therefore
 * requires an explicit privacy review before this allowlist can change.
 */
const APPROVED_STREAM_STATE = new Map<string, string>([
  ["#stream", "readonly:AsyncIterable<unknown>"],
  ["#accumulator", "readonly:StreamUsageAccumulator"],
  ["#onComplete", "mutable:OnComplete|undefined"],
  ["#onError", "mutable:OnError|undefined"],
  ["#translationCursor", "mutable:ChunkTranslationCursor|null"],
  ["#abortCheck", "mutable:(()=>Error|undefined)|null"],
  ["#logger", "readonly:Logger"],
  ["#startTime", "readonly:number"],
  ["#abortReleaseState", "mutable:AbortReleaseState|null"],
  ["#abortReleaseToken", "readonly:{}"],
  ["#settled", "mutable:boolean"],
  ["#terminal", "mutable:boolean"],
  ["#abortError", "mutable:Error|undefined"],
  ["#iterator", "mutable:AsyncIterator<unknown>|undefined"],
  ["#iteratorNaturallyFinished", "mutable:boolean"],
  ["#iteratorCleanupComplete", "mutable:boolean"],
  ["#sourceCleanupComplete", "mutable:boolean"],
  ["#abortCleanupWarningIssued", "mutable:boolean"],
  ["#operationTail", "mutable:Promise<void>|null"],
  ["#consumer", 'mutable:"iteration"|"helper"|null'],
]);

function streamStateShape(member: ts.PropertyDeclaration, source: ts.SourceFile): string {
  const mutability = member.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
  )
    ? "readonly"
    : "mutable";
  let type = member.type?.getText(source).replace(/\s+/g, "");
  if (type === undefined) {
    if (
      member.initializer?.kind === ts.SyntaxKind.TrueKeyword ||
      member.initializer?.kind === ts.SyntaxKind.FalseKeyword
    ) {
      type = "boolean";
    } else if (
      member.initializer !== undefined &&
      ts.isObjectLiteralExpression(member.initializer)
    ) {
      type = "{}";
    } else {
      type = `<inferred:${member.initializer?.getText(source).replace(/\s+/g, "") ?? "none"}>`;
    }
  }
  return `${mutability}:${type}`;
}

function isContentFreeCallbackArray(member: ts.PropertyDeclaration): boolean {
  const type = member.type;
  let element: ts.TypeNode | undefined;
  if (type !== undefined && ts.isArrayTypeNode(type)) {
    element = type.elementType;
  } else if (
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    ["Array", "ReadonlyArray"].includes(type.typeName.text)
  ) {
    [element] = type.typeArguments ?? [];
  }
  const emptyInitializer =
    member.initializer !== undefined &&
    ((ts.isArrayLiteralExpression(member.initializer) &&
      member.initializer.elements.length === 0) ||
      (ts.isNewExpression(member.initializer) &&
        ts.isIdentifier(member.initializer.expression) &&
        member.initializer.expression.text === "Array" &&
        (member.initializer.arguments?.length ?? 0) === 0));
  return (
    emptyInitializer &&
    element !== undefined &&
    ts.isFunctionTypeNode(element) &&
    element.parameters.length === 0 &&
    element.type.kind === ts.SyntaxKind.VoidKeyword
  );
}

function findUnexpectedStreamState(file: SourceFile): string[] {
  const source = ts.createSourceFile(
    file.abs,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === "StreamWrapper") {
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member)) continue;
        const field = member.name.getText(source);
        const shape = streamStateShape(member, source);
        const approved = APPROVED_STREAM_STATE.get(field);
        if (approved === undefined) {
          if (field !== "#releaseCallbacks" || !isContentFreeCallbackArray(member)) {
            violations.push(
              `${file.rel}: StreamWrapper field '${field}' is not an approved persistent capability`,
            );
          }
        } else if (shape !== approved) {
          violations.push(
            `${file.rel}: StreamWrapper field '${field}' changed persistent-state shape ` +
              `(expected ${approved}, got ${shape})`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function findTestingBoundaryViolations(
  packageExports: Record<string, unknown>,
  tsupSource: string,
  rootSource: string,
): string[] {
  const violations: string[] = [];
  const expectedTestingExport = {
    import: {
      types: "./dist/testing/index.d.ts",
      default: "./dist/testing/index.js",
    },
    require: {
      types: "./dist/testing/index.d.cts",
      default: "./dist/testing/index.cjs",
    },
  };
  const testingExportKeys = Object.keys(packageExports).filter(
    (key) => key === "./testing" || key.startsWith("./testing/"),
  );
  if (
    testingExportKeys.length !== 1 ||
    testingExportKeys[0] !== "./testing" ||
    !hasExactJsonShape(packageExports["./testing"], expectedTestingExport)
  ) {
    violations.push("package must expose exactly the reviewed ./testing export");
  }

  const tsup = ts.createSourceFile(
    "tsup.config.ts",
    tsupSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const testingEntries: Array<readonly [string, string]> = [];
  const visitEntry = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(tsup).replace(/["']/g, "") === "entry") {
      if (ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) {
            continue;
          }
          const output = property.name.getText(tsup).replace(/["']/g, "");
          const source = property.initializer.text.replace(/\\+/g, "/").replace(/^\.\//, "");
          if (
            output === "testing" ||
            output.startsWith("testing/") ||
            source === "src/testing" ||
            source.startsWith("src/testing/")
          ) {
            testingEntries.push([output, source]);
          }
        }
      }
    }
    ts.forEachChild(node, visitEntry);
  };
  visitEntry(tsup);
  if (
    testingEntries.length !== 1 ||
    testingEntries[0]?.[0] !== "testing/index" ||
    testingEntries[0]?.[1] !== "src/testing/index.ts"
  ) {
    violations.push("tsup must expose exactly testing/index from src/testing/index.ts");
  }
  if (/["']\.\/testing(?:\/[^"']*)?["']/.test(stripComments(rootSource))) {
    violations.push("root references a testing module specifier");
  }
  return violations;
}

function hasExactJsonShape(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "object" || actual === null) return Object.is(actual, expected);
  if (
    typeof expected !== "object" ||
    expected === null ||
    Array.isArray(actual) !== Array.isArray(expected)
  ) {
    return false;
  }
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord).sort();
  const expectedKeys = Object.keys(expectedRecord).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) =>
        key === expectedKeys[index] && hasExactJsonShape(actualRecord[key], expectedRecord[key]),
    )
  );
}

function importSpecifier(node: ts.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0] as ts.Expression)
  ) {
    return (node.arguments[0] as ts.StringLiteralLike).text;
  }
  return undefined;
}

function hasInjectedFetchParameter(node: ts.Node, source: ts.SourceFile): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (
      ts.isFunctionLike(current) &&
      current.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === "fetch" &&
          parameter.type?.getText(source).replace(/\s+/g, "") === "FetchLike",
      )
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isDeclarationOrPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  return (
    ((ts.isParameter(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
  );
}

function isAllowedFetchMemberWriteOrForward(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  const parent = node.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return true;
  }
  return (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    propertyNameText(parent.name) === "fetch"
  );
}

function findTestingNetworkViolations(file: SourceFile): string[] {
  const offenders: string[] = [];
  const source = ts.createSourceFile(
    file.abs,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imported = new Set<string>();
  let referencesGlobalFetch = false;
  let callsMemberFetch = false;
  let readsGlobalFetch = false;
  const visit = (node: ts.Node): void => {
    const specifier = importSpecifier(node);
    if (specifier !== undefined) imported.add(specifier);
    if (
      ts.isIdentifier(node) &&
      node.text === "fetch" &&
      !isDeclarationOrPropertyName(node) &&
      !hasInjectedFetchParameter(node, source)
    ) {
      referencesGlobalFetch = true;
    }
    if (
      ((ts.isPropertyAccessExpression(node) && node.name.text === "fetch") ||
        (ts.isElementAccessExpression(node) &&
          node.argumentExpression !== undefined &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === "fetch")) &&
      !isAllowedFetchMemberWriteOrForward(node)
    ) {
      callsMemberFetch = true;
    }
    if (
      (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["globalThis", "window", "self", "global"].includes(node.expression.text) &&
        node.name.text === "fetch") ||
      (ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["globalThis", "window", "self", "global"].includes(node.expression.text) &&
        node.argumentExpression !== undefined &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "fetch")
    ) {
      readsGlobalFetch = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (referencesGlobalFetch) offenders.push(`${file.rel}: references global fetch`);
  if (callsMemberFetch) offenders.push(`${file.rel}: reads a member fetch fallback`);
  if (readsGlobalFetch) offenders.push(`${file.rel}: reads a global fetch`);
  if (/\bconsole\s*\./.test(stripLiteralsAndComments(file.text))) {
    offenders.push(`${file.rel}: calls console`);
  }
  if (/\b(?:Logger|logger)\b/.test(stripLiteralsAndComments(file.text))) {
    offenders.push(`${file.rel}: names a logger`);
  }
  if ([...imported].some((specifier) => specifier.startsWith("node:"))) {
    offenders.push(`${file.rel}: imports node:*`);
  }
  if (
    [...imported].some((specifier) => specifier === "vitest" || specifier.startsWith("vitest/"))
  ) {
    offenders.push(`${file.rel}: imports Vitest`);
  }
  for (const pkg of PROVIDER_SDK_PACKAGES) {
    if ([...imported].some((specifier) => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
      offenders.push(`${file.rel}: imports provider SDK '${pkg}'`);
    }
  }
  for (const pkg of [
    "axios",
    "cross-fetch",
    "got",
    "http",
    "https",
    "isomorphic-fetch",
    "ky",
    "node-fetch",
    "ofetch",
    "superagent",
    "undici",
  ]) {
    if ([...imported].some((specifier) => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
      offenders.push(`${file.rel}: imports network client '${pkg}'`);
    }
  }
  return offenders;
}

const FORBIDDEN_TESTING_CONTENT_FIELDS = new Set([
  "messages",
  "content",
  "system",
  "contents",
  "prompt",
  "input",
]);

function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function findTestingDataBoundaryViolations(file: SourceFile): string[] {
  const source = ts.createSourceFile(
    file.abs,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const offenders = new Set<string>();
  const inspectName = (name: string): void => {
    if (FORBIDDEN_TESTING_CONTENT_FIELDS.has(name)) {
      offenders.add(`${file.rel}: declares provider content field '${name}'`);
    }
    if (/cost/i.test(name)) {
      offenders.add(`${file.rel}: names forbidden cost field '${name}'`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      const name = propertyNameText(node.name);
      if (name !== undefined) inspectName(name);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      inspectName(node.name.text);
    } else if (ts.isBindingElement(node)) {
      const name =
        propertyNameText(node.propertyName) ??
        (ts.isIdentifier(node.name) ? node.name.text : undefined);
      if (name !== undefined) inspectName(name);
    } else if (ts.isPropertyAccessExpression(node)) {
      inspectName(node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      inspectName(node.argumentExpression.text);
    } else if (ts.isIdentifier(node)) {
      if (/cost/i.test(node.text)) {
        offenders.add(`${file.rel}: names forbidden cost field '${node.text}'`);
      } else if (node.text !== "input" && FORBIDDEN_TESTING_CONTENT_FIELDS.has(node.text)) {
        offenders.add(`${file.rel}: declares provider content field '${node.text}'`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...offenders];
}

// ---------------------------------------------------------------------------
// Content-leak guards.
// ---------------------------------------------------------------------------

describe("privacy firewall — content never reaches a logger", () => {
  it("scans a non-trivial set of firewalled source files", () => {
    // Guard against the scan silently matching nothing (e.g. a broken path).
    expect(FIREWALLED.length).toBeGreaterThan(5);
  });

  it("keeps receipt-fold.ts inside the non-privileged firewall scan", () => {
    const receiptFold = ALL_SOURCES.find((file) => file.rel === "receipt-fold.ts");
    expect(receiptFold).toBeDefined();
    expect(FIREWALLED).toContain(receiptFold);
  });

  it("keeps velocity.ts content-blind, logger-free, and edge-safe", () => {
    const velocity = ALL_SOURCES.find((file) => file.rel === "velocity.ts");
    expect(velocity).toBeDefined();
    expect(FIREWALLED).toContain(velocity);
    expect(findLoggerViolations(velocity as SourceFile)).toEqual([]);
    expect(findTestingNetworkViolations(velocity as SourceFile)).toEqual([]);
  });

  it("keeps run-control.ts content-blind, logger-free, and edge-safe", () => {
    const runControl = ALL_SOURCES.find((file) => file.rel === "run-control.ts");
    expect(runControl).toBeDefined();
    expect(FIREWALLED).toContain(runControl);
    expect(findLoggerViolations(runControl as SourceFile)).toEqual([]);
    expect(findTestingNetworkViolations(runControl as SourceFile)).toEqual([]);
  });

  it("no firewalled file passes content barewords, content dicts, or a bare exception to a logger", () => {
    const violations = FIREWALLED.flatMap(findLoggerViolations);
    expect(violations).toEqual([]);
  });

  it("rejects direct caught-value constructor names while approving the shared projection", () => {
    const source = (expression: string): SourceFile => ({
      rel: "mutated.ts",
      abs: "mutated.ts",
      text: `logger.warn("failed: %s", ${expression})`,
    });

    expect(findLoggerViolations(source("error.constructor.name"))).not.toEqual([]);
    expect(findLoggerViolations(source("safeErrorClassName(error)"))).toEqual([]);
  });

  it("every logger call in src/stream.ts passes only a literal template + error-class-name expressions", () => {
    const stream = ALL_SOURCES.find((f) => f.rel === "stream.ts");
    expect(stream).toBeDefined();
    expect(findStreamLoggerViolations(stream as SourceFile)).toEqual([]);
  });

  it("keeps translated fan-out buffering out of non-privileged StreamWrapper state", () => {
    const stream = ALL_SOURCES.find((file) => file.rel === "stream.ts");
    expect(stream).toBeDefined();
    expect(findUnexpectedStreamState(stream as SourceFile)).toEqual([]);
  });

  it("permits an explicitly content-free callback array", () => {
    const contentFreeArray: SourceFile = {
      rel: "stream.ts",
      abs: "stream.ts",
      text: `
        class StreamWrapper {
          #releaseCallbacks: Array<() => void> = [];
          rememberReleases(callbacksForRelease: () => Array<() => void>) {
            this.#releaseCallbacks.push(...callbacksForRelease());
          }
        }
      `,
    };
    expect(findUnexpectedStreamState(contentFreeArray)).toEqual([]);
  });

  const stateMutation = (field: string, method: string): SourceFile => ({
    rel: "stream.ts",
    abs: "stream.ts",
    text: `class StreamWrapper { ${field} ${method} }`,
  });
  const unexpected = (field: string): string =>
    `stream.ts: StreamWrapper field '${field}' is not an approved persistent capability`;
  const mutations: ReadonlyArray<readonly [string, string, string, string]> = [
    [
      "renamed array spread",
      "#opaqueQueue: unknown[] = [];",
      "pull(translate: (raw: unknown) => unknown[], raw: unknown) { this.#opaqueQueue.push(...translate(raw)); }",
      unexpected("#opaqueQueue"),
    ],
    [
      "new Array plus output alias",
      "#fanout = new Array<unknown>();",
      "pull(translate: (raw: unknown) => unknown[], raw: unknown) { const outputs = translate(raw); this.#fanout.push(...outputs); }",
      unexpected("#fanout"),
    ],
    [
      "direct translator-result assignment",
      "#queue: unknown[] = [];",
      "pull(translate: (raw: unknown) => unknown[], raw: unknown) { this.#queue = translate(raw); }",
      unexpected("#queue"),
    ],
    [
      "aliased translator-result assignment",
      "#queue = new Array<unknown>();",
      "pull(translate: (raw: unknown) => unknown[], raw: unknown) { const outputs = translate(raw); this.#queue = outputs; }",
      unexpected("#queue"),
    ],
    [
      "non-spread push",
      "#queue: unknown[] = [];",
      "pull(translate: (raw: unknown) => unknown[], raw: unknown) { this.#queue.push(translate(raw)[0]); }",
      unexpected("#queue"),
    ],
    [
      "indexed write",
      "#indexed: unknown[] = [];",
      "pull(translate: (raw: unknown) => unknown[], raw: unknown) { this.#indexed[0] = translate(raw)[0]; }",
      unexpected("#indexed"),
    ],
    [
      "scalar slot",
      "#slot: unknown;",
      "pull(translate: (raw: unknown) => unknown[], raw: unknown) { this.#slot = translate(raw)[0]; }",
      unexpected("#slot"),
    ],
    [
      "public field",
      "queue: unknown[] = [];",
      "pull(translate: (raw: unknown) => unknown[], raw: unknown) { this.queue = translate(raw); }",
      unexpected("queue"),
    ],
    [
      "translation cursor result",
      "#pending: unknown;",
      "pull(cursor: { take: () => IteratorResult<unknown> }) { this.#pending = cursor.take().value; }",
      unexpected("#pending"),
    ],
    [
      "repurposed approved field",
      "#terminal: unknown;",
      "pull(translate: (raw: unknown) => unknown[], raw: unknown) { this.#terminal = translate(raw); }",
      "stream.ts: StreamWrapper field '#terminal' changed persistent-state shape (expected mutable:boolean, got mutable:unknown)",
    ],
  ];

  it.each(mutations)("rejects %s in StreamWrapper state", (_label, field, method, message) => {
    const mutation = stateMutation(field, method);
    expect(findUnexpectedStreamState(mutation)).toEqual([message]);
  });

  it("no firewalled file uses console.* directly (only src/logging.ts may)", () => {
    const offenders = FIREWALLED.filter(
      (f) => f.rel !== "logging.ts" && /\bconsole\s*\./.test(stripLiteralsAndComments(f.text)),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("no SDK source contains a stdout print leak (no console.log outside logging.ts)", () => {
    const offenders = ALL_SOURCES.filter(
      (f) =>
        f.rel !== "logging.ts" && /\bconsole\s*\.\s*log\b/.test(stripLiteralsAndComments(f.text)),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wire models stay content-free.
// ---------------------------------------------------------------------------

describe("privacy firewall — wire models declare no content field", () => {
  it("MetadataEvent / BudgetCheck / BudgetConfirm schemas name no forbidden content field", () => {
    const wireFiles = ALL_SOURCES.filter(
      (f) => f.rel === "validation.ts" || f.rel === "types.ts" || f.rel === "token-details.ts",
    );
    const offenders: string[] = [];
    for (const file of wireFiles) {
      const code = stripLiteralsAndComments(file.text);
      for (const field of FORBIDDEN_WIRE_FIELDS) {
        // A property/schema-key declaration: `field:` on its own word boundary.
        if (new RegExp(`(^|[^\\w])${field}\\s*:`, "m").test(code)) {
          offenders.push(`${file.rel}: declares forbidden wire field '${field}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PRIVACY-CRITICAL banner set == allowlist.
// ---------------------------------------------------------------------------

describe("privacy firewall — banner set equals the content-privileged allowlist", () => {
  it("no firewalled (non-privileged) file carries the PRIVACY-CRITICAL banner", () => {
    const offenders = FIREWALLED.filter((f) =>
      f.text.slice(0, 600).includes("PRIVACY-CRITICAL"),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("every existing privileged file opens with the PRIVACY-CRITICAL banner", () => {
    const privileged = ALL_SOURCES.filter((f) => isPrivileged(f.rel));
    // At least src/privacy.ts must exist and be privileged.
    expect(privileged.map((f) => f.rel)).toContain("privacy.ts");
    for (const file of privileged) {
      expect(file.text.slice(0, 600)).toContain("PRIVACY-CRITICAL");
    }
  });
});

// ---------------------------------------------------------------------------
// Structural edge-safety guards.
// ---------------------------------------------------------------------------

describe("privacy firewall — structural edge-safety guards", () => {
  it("keeps every testing module non-privileged and inside the firewalled set", () => {
    expect(TESTING_SOURCES.map((file) => file.rel).sort()).toEqual([
      "testing/contract.ts",
      "testing/fake-control-plane.ts",
      "testing/index.ts",
      "testing/model-guard.ts",
      "testing/wire.ts",
    ]);
    expect(TESTING_SOURCES.every((file) => !isPrivileged(file.rel))).toBe(true);
    expect(TESTING_SOURCES.every((file) => FIREWALLED.includes(file))).toBe(true);
  });

  it("keeps testing modules edge-only with no logger, provider SDK, console, or network fallback", () => {
    const offenders = TESTING_SOURCES.flatMap(findTestingNetworkViolations);
    expect(offenders).toEqual([]);
  });

  it("keeps testing modules free of provider content and cost fields", () => {
    const offenders = TESTING_SOURCES.flatMap(findTestingDataBoundaryViolations);
    expect(offenders).toEqual([]);
  });

  it("recognizes direct network-call and imported HTTP-client mutations", () => {
    const mutated = (text: string): SourceFile => ({
      rel: "testing/mutated.ts",
      abs: "testing/mutated.ts",
      text,
    });
    for (const source of [
      'fetch("https://network.invalid")',
      'client.fetch("https://network.invalid")',
      'client?.fetch?.("https://network.invalid")',
      'client["fetch"]("https://network.invalid")',
      'const fallback = globalThis["fetch"]',
      "const fallback = globalThis?.fetch",
      'import axios from "axios"',
      'import ky from "ky/distribution"',
    ]) {
      expect(findTestingNetworkViolations(mutated(source)), source).not.toEqual([]);
    }
    expect(
      findTestingNetworkViolations(
        mutated(`
          async function post(fetch: FetchLike) {
            await fetch("https://injected.invalid");
            return { provider: "openai" };
          }
        `),
      ),
    ).toEqual([]);
    for (const source of [
      'import OpenAI from "openai"',
      'export { OpenAI } from "openai"',
      'const OpenAI = require("openai")',
      'const load = () => import("openai")',
    ]) {
      expect(findTestingNetworkViolations(mutated(source)), source).not.toEqual([]);
    }
  });

  it.each([
    ["aliased global fetch", 'const send = fetch; await send("https://network.invalid")'],
    ["aliased member fetch", 'const send = client.fetch; await send("https://network.invalid")'],
  ])("recognizes %s", (_label, text) => {
    expect(
      findTestingNetworkViolations({ rel: "testing/mutated.ts", abs: "mutated.ts", text }),
    ).not.toEqual([]);
  });

  it.each([
    ["static Vitest import", 'import { describe } from "vitest"'],
    ["type-only Vitest subpath import", 'import type { TestContext } from "vitest/utils"'],
    ["Vitest subpath require", 'const suite = require("vitest/node")'],
    ["dynamic Vitest subpath import", 'const suite = import("vitest/config")'],
  ])("recognizes %s", (_label, text) => {
    expect(
      findTestingNetworkViolations({ rel: "testing/mutated.ts", abs: "mutated.ts", text }),
    ).not.toEqual([]);
  });

  it("recognizes provider-content and cost-field mutations", () => {
    const mutated = (text: string): SourceFile => ({
      rel: "testing/mutated.ts",
      abs: "testing/mutated.ts",
      text,
    });
    for (const source of [
      'const request = { messages: [{ content: "secret" }] }',
      'const request = { input: "secret" }',
      "const estimatedCostUsd = 1.25",
      'const result = value["prompt"]',
      "const { contents } = request",
    ]) {
      expect(findTestingDataBoundaryViolations(mutated(source)), source).not.toEqual([]);
    }
  });

  it.each([
    ["shorthand input binding", "const { input } = request"],
    ["aliased input binding", "const { input: providerInput } = request"],
  ])("recognizes %s", (_label, text) => {
    expect(
      findTestingDataBoundaryViolations({ rel: "testing/mutated.ts", abs: "mutated.ts", text }),
    ).not.toEqual([]);
  });

  it("no `node:*` import outside src/node.ts", () => {
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      if (file.rel === "node.ts") continue;
      // Keep string literals (import paths live there); drop comment mentions of node:*.
      const code = stripComments(file.text);
      // Static import/export ... from "node:..." OR dynamic import("node:...").
      if (/(?:from|import|require)\s*\(?\s*["']node:/.test(code)) {
        offenders.push(file.rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no value import of a provider SDK anywhere in src (type-only / dynamic-in-try allowed)", () => {
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      // Keep string literals (the package specifier); drop comment mentions of SDK names.
      const code = stripComments(file.text);
      for (const pkg of PROVIDER_SDK_PACKAGES) {
        const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Every static VALUE-import form that pulls the SDK into the module graph
        // (all break invariant 3 with the peer absent); `import type` and
        // `import("pkg")` dynamic-in-try are the only exempt forms:
        //  - `import ... from "pkg"`      (default / named / namespace value import)
        //  - `export ... from "pkg"`      (re-export — a value import + re-export)
        //  - `import "pkg";`              (bare side-effect import)
        const staticImports = [
          new RegExp(`import\\s+(?!type\\b)[^;\\n]*?from\\s*["']${escaped}["']`),
          new RegExp(`export\\s+(?!type\\b)[^;\\n]*?from\\s*["']${escaped}["']`),
          new RegExp(`import\\s*["']${escaped}["']`),
        ];
        if (staticImports.some((re) => re.test(code))) {
          offenders.push(`${file.rel}: value-imports provider SDK '${pkg}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("testing apparatus has one isolated public subpath", () => {
  it("has exactly the reviewed package export and tsup entry, with no root import", () => {
    const root = process.cwd();
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(
      findTestingBoundaryViolations(
        packageJson.exports ?? {},
        readFileSync(join(root, "tsup.config.ts"), "utf8"),
        readFileSync(join(root, "src/index.ts"), "utf8"),
      ),
    ).toEqual([]);
  });

  it("recognizes nested exports, wrong paths, extra entries, and root-specifier mutations", () => {
    const exactExport = {
      "./testing": {
        import: {
          types: "./dist/testing/index.d.ts",
          default: "./dist/testing/index.js",
        },
        require: {
          types: "./dist/testing/index.d.cts",
          default: "./dist/testing/index.cjs",
        },
      },
    };
    const exactEntry = `export default { entry: { "testing/index": "src/testing/index.ts" } };`;
    expect(findTestingBoundaryViolations(exactExport, exactEntry, "")).toEqual([]);
    expect(
      findTestingBoundaryViolations(
        {
          ...exactExport,
          "./testing/private": "./dist/testing/private.js",
        },
        exactEntry,
        "",
      ),
    ).not.toEqual([]);
    expect(
      findTestingBoundaryViolations(
        {
          "./testing": {
            import: {
              types: "./dist/testing/index.d.ts",
              default: "./dist/testing/wrong.js",
            },
            require: {
              types: "./dist/testing/index.d.cts",
              default: "./dist/testing/index.cjs",
            },
          },
        },
        exactEntry,
        "",
      ),
    ).not.toEqual([]);
    expect(
      findTestingBoundaryViolations(
        exactExport,
        `entry: {
          "testing/index": "src/testing/index.ts",
          "testing/private": "src/testing/private.ts",
        }`,
        "",
      ),
    ).not.toEqual([]);
    expect(
      findTestingBoundaryViolations(
        exactExport,
        exactEntry,
        `export { FakeControlPlane } from "./testing";`,
      ),
    ).not.toEqual([]);
  });

  const dist = join(process.cwd(), "dist");
  it.skipIf(!existsSync(dist))(
    "after a build, emits all testing artifacts without markers outside dist/testing",
    () => {
      const builtFiles: string[] = [];
      function visit(dir: string): void {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (/\.(?:js|cjs|d\.ts|d\.cts)(?:\.map)?$/.test(entry.name)) builtFiles.push(path);
        }
      }
      visit(dist);
      const builtRelative = builtFiles.map((file) => relative(dist, file).split(sep).join("/"));
      expect(builtRelative).toEqual(
        expect.arrayContaining([
          "index.js",
          "index.cjs",
          "index.d.ts",
          "index.d.cts",
          "testing/index.js",
          "testing/index.cjs",
          "testing/index.d.ts",
          "testing/index.d.cts",
        ]),
      );
      const outsideTesting = builtFiles.filter(
        (file) => !relative(dist, file).split(sep).join("/").startsWith("testing/"),
      );
      const leaked = outsideTesting.filter((file) => {
        const text = readFileSync(file, "utf8");
        return text.includes("FakeControlPlane") || text.includes("solwyn-test/");
      });
      expect(leaked.map((file) => relative(dist, file))).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Content-privileged modules import no logger.
//
// The stricter no-logger set includes `privacy.ts` and the whole
// `providers/translation/` package. It deliberately excludes `src/ai-sdk/`, whose middleware
// legitimately imports the logger for its reporter. A missing logger handle is the strongest
// guarantee that prompt-adjacent code cannot log content.
// ---------------------------------------------------------------------------

/** Stricter no-logger set: privacy.ts and the translation package, excluding ai-sdk. */
const NO_LOGGER_PREFIXES = ["privacy.ts", "providers/translation/"];
const NO_LOGGER_FILES = ALL_SOURCES.filter((f) =>
  NO_LOGGER_PREFIXES.some((p) => (p.endsWith("/") ? f.rel.startsWith(p) : f.rel === p)),
);
const TRANSLATION_FILES = ALL_SOURCES.filter((f) => f.rel.startsWith("providers/translation/"));

describe("privacy firewall — content-privileged modules import no logger", () => {
  it("the scoped set is non-empty and includes privacy.ts + at least one translation module", () => {
    expect(NO_LOGGER_FILES.map((f) => f.rel)).toContain("privacy.ts");
    expect(NO_LOGGER_FILES.some((f) => f.rel.startsWith("providers/translation/"))).toBe(true);
  });

  it("neither privacy.ts nor any translation module imports the logging module or holds a Logger", () => {
    const offenders: string[] = [];
    for (const file of NO_LOGGER_FILES) {
      // Keep string literals (import specifiers live there); drop comment mentions of `logger`.
      const code = stripComments(file.text);
      // No import (static OR dynamic) of the logger seam (any module path ending in `logging`).
      if (/\b(?:from|import|require)\s*\(?\s*["'][^"']*logging["']/.test(code)) {
        offenders.push(`${file.rel}: imports the logging module`);
      }
      // No `Logger` type/handle in scope at all (the TS analog of "no logging import").
      if (/\bLogger\b/.test(code)) {
        offenders.push(`${file.rel}: references the Logger type`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Translation package does no I/O.
//
// The package must neither import the fetch-based transport module nor call the global
// `fetch(` function (sans-I/O purity: it may never reach a client pointed at config.apiUrl).
// ---------------------------------------------------------------------------

describe("privacy firewall — translation package does no I/O", () => {
  it("finds the translation package on disk", () => {
    expect(TRANSLATION_FILES.length).toBeGreaterThan(0);
  });

  it("no translation module imports the transport module or calls fetch()", () => {
    const offenders: string[] = [];
    for (const file of TRANSLATION_FILES) {
      // Import specifier check keeps string literals; the fetch-call check strips them so a
      // literal like "prefetch(" can never false-trip.
      const withLiterals = stripComments(file.text);
      if (/\b(?:from|import|require)\s*\(?\s*["'][^"']*transport["']/.test(withLiterals)) {
        offenders.push(`${file.rel}: imports the transport module`);
      }
      const noLiterals = stripLiteralsAndComments(file.text);
      if (/\bfetch\s*\(/.test(noLiterals)) {
        offenders.push(`${file.rel}: calls fetch()`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Translation package names no logger token.
//
// Positive absence scan over raw source: the tokens `logger` and `logging` must not appear
// anywhere in the translation package, including comments. A missing logger is the strongest
// guarantee that content cannot be logged there.
// ---------------------------------------------------------------------------

describe("privacy firewall — translation package names no logger", () => {
  it("no translation module names 'logger' or 'logging' anywhere in source", () => {
    const offenders: string[] = [];
    for (const file of TRANSLATION_FILES) {
      if (file.text.includes("logger")) {
        offenders.push(`${file.rel}: names 'logger'`);
      }
      if (file.text.includes("logging")) {
        offenders.push(`${file.rel}: names 'logging'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

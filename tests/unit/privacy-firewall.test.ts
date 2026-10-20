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
 *    value import of a provider/framework SDK anywhere (type-only / dynamic-in-try allowed);
 *  - integrations read only allowlisted structural properties, forward opaque values
 *    directly, and have no transport or content-privileged dependencies.
 *
 * This is a source-scanning test — it reads the files off disk, it does not import them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");

/** Content-privileged paths (relative to src/, POSIX-style). Everything else is firewalled. */
const PRIVILEGED_PREFIXES = ["privacy.ts", "providers/translation/", "ai-sdk/"];

/** Provider/framework SDKs that must never be VALUE-imported anywhere in core. */
const PROVIDER_SDK_PACKAGES = [
  "openai",
  "@anthropic-ai/sdk",
  "@google/genai",
  "@google/generative-ai",
  "@aws-sdk/client-bedrock-runtime",
  "together-ai",
  "ai",
  "@langchain/core",
  "@langchain/openai",
  "@langchain/langgraph",
  "@langchain/anthropic",
  "@openai/agents",
  "@openai/agents-core",
  "@openai/agents-openai",
];

function providerSdkPackage(specifier: string): string | undefined {
  return PROVIDER_SDK_PACKAGES.find((pkg) => {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^["']${escaped}(?:/[^"']*)?["']$`).test(JSON.stringify(specifier));
  });
}

function findProviderValueImportViolations(text: string, path: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    // Whole-declaration type imports/exports erase completely; inline { type X }
    // remains forbidden because verbatimModuleSyntax can emit a side-effect import.
    const typeOnly =
      (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(node) && node.isTypeOnly) ||
      (ts.isImportEqualsDeclaration(node) && node.isTypeOnly);
    const dynamic =
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const specifier = importSpecifier(node);
    if (!typeOnly && !dynamic && specifier !== undefined) {
      const pkg = providerSdkPackage(specifier);
      if (pkg !== undefined)
        violations.push(`${path}: value-imports provider/framework SDK '${pkg}'`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

/** Readable integration properties: structural identity, lifecycle, and admitted dispatch only. */
const INTEGRATION_READABLE_PROPERTIES = new Set([
  // Integration-owned structural state, never fields from opaque framework values.
  "rootRunId",
  "scope",
  "scopes",
  "scopeName",
  "parentScope",
  "nodeScopes",
  "nodeName",
  "handle",
  "closed",
  "bound",
  "bindings",
  "keys", // Structural Map key traversal for cleanup.
  "resolve", // Promise normalization; provider values stay opaque.
  "defineProperty", // Stamp only the LangChain retryability symbol on typed SDK errors.
  "for", // Registered, content-free retryability symbol.
  "isArray", // Validate handler collection shape.
  "test", // Validate/sanitize explicit attribution names only.
  "runId", // Framework run identity.
  "handlers", // Handler membership proves the metered leaf was bound.
  "signal", // Cancellation capability, never request content.
  "aborted", // Cancellation lifecycle flag.
  "reason", // Forward an abort reason unchanged; never log it.
  "langgraph_node", // The single admitted structural metadata key.
  "chat", // Admitted OpenAI client resource container.
  "completions", // Admitted Chat Completions resource container.
  "create", // Admitted wrapped-client dispatch method.
  "then", // Promise lifecycle forwarding.
  "length", // Structural collection size only.
  "activate", // Detached-run attribution activation.
  "tryFinish", // Non-throwing detached-run cleanup.
  "tags", // Explicit non-sensitive attribution options.
  "namePrefix", // Explicit attribution scope-name prefix.
  "addEventListener", // Abort propagation registration.
  "removeEventListener", // Abort propagation cleanup.
  "abort", // Cancellation propagation.
  "get", // Structural Map/WeakMap lookup.
  "set", // Structural Map/WeakMap registration.
  "has", // Structural collection membership.
  "delete", // Structural collection cleanup.
  "add", // Structural Set registration.
  "size", // Structural Map/Set size.
  "includes", // Handler identity membership check.
  "warn", // Logger method; direct calls with literal/run-id messages only.
]);

// Each additional property is required by the shipped Agents module. The necessity test
// removes them individually; none grants access to opaque requests or callback content.
const AGENTS_READABLE_PROPERTIES = new Set([
  "OpenAIProvider", // Explicitly supplied provider constructor; no framework value import.
  "client", // Explicit wrapped-client constructor option.
  "api", // Explicit HTTP dialect option.
  "agentRunId", // Current detached-run identity.
  "parentAgentRunId", // Current detached-run parent identity.
  "asyncIterator", // Well-known iteration capability; never a yielded content field.
  "beginAttempt", // Internal invocation concurrency admission.
  "bind", // Preserve native iterator receivers.
  "cause", // Bounded branded error traversal; never inspect error messages.
  "check", // Internal invocation lifecycle/violation check.
  "clear", // Structural collection cleanup.
  "close", // Internal invocation cleanup.
  "completed", // Native background-work completion capability.
  "config", // Runner structural configuration.
  "done", // Iterator terminal flag; never inspect its value.
  "end", // Internal agent lifecycle transition.
  "error", // Only the retry-advice error projection is readable.
  "fail", // Internal typed violation latch.
  "failure", // Forward latched or original errors unchanged.
  "finally", // Promise cleanup registration.
  "finish", // Internal attempt release.
  "getModel", // Controlled provider model selection.
  "getPrototypeOf", // Only topology of the controlled provider model is inspected.
  "getResponse", // Admitted wrapped-model dispatch.
  "getRetryAdvice", // Retry decision capability.
  "getStreamedResponse", // Admitted wrapped-model stream dispatch.
  "hasOwn", // Only fixed HTTP model dispatch methods on its direct prototype.
  "model", // Structural string/model selection; never model input.
  "modelProvider", // Runner provider identity.
  "name", // Explicit structural agent attribution name.
  "next", // Iterator pull capability.
  "on", // Structural Runner hook registration.
  "prototype", // Object.prototype identity in the model topology check only.
  "return", // Iterator cancellation capability.
  "run", // Native Runner dispatch; never an attribution sink for opaque input.
  "runOptions", // Native invocation options forwarded opaquely.
  "start", // Internal agent lifecycle transition.
  "supportsPromptModelSelection", // Native model capability flag.
  "throw", // Iterator error forwarding.
  "toolEnd", // Internal tool identity lifecycle transition.
  "toolStart", // Internal tool identity lifecycle transition.
  "values", // Structural handle collection traversal.
  "workflow", // Explicit workflow attribution name.
]);
for (const property of AGENTS_READABLE_PROPERTIES) INTEGRATION_READABLE_PROPERTIES.add(property);

const INTEGRATION_CORE_IMPORTS = new Set([
  "run-context",
  "errors",
  "logging",
  "tags",
  "validation",
  "wrapper-brand",
  "integration-support",
]);
const LOGGER_METHODS = new Set(["debug", "info", "warn", "error", "log"]);
const RUN_ID_IDENTIFIER = /^_?(?:runId|[A-Za-z_$][\w$]*RunId)$/;

// Callback arguments are framework-owned. Pin structural names to their runtime positions;
// a content parameter cannot become readable by renaming it to another structural name.
// Unknown handle*/on* callbacks have no structural slots until their contract is reviewed.
const LANGCHAIN_CALLBACK_PARAMETERS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  handleChainStart: { 2: "runId", 3: "parentRunId", 5: "metadata", 7: "runName" },
  handleToolStart: { 2: "runId", 3: "parentRunId" },
  handleRetrieverStart: { 2: "runId", 3: "parentRunId" },
  handleChatModelStart: { 2: "runId", 3: "parentRunId" },
  handleLLMStart: { 2: "runId", 3: "parentRunId" },
  handleChainEnd: { 1: "runId" },
  handleChainError: { 1: "runId" },
  handleToolEnd: { 1: "runId" },
  handleToolError: { 1: "runId" },
  handleRetrieverEnd: { 1: "runId" },
  handleRetrieverError: { 1: "runId" },
  handleLLMEnd: { 1: "runId" },
  handleLLMError: { 1: "runId" },
};

function containsIdentifier(node: ts.Node, name: string): boolean {
  // Conservative by design: even a shadowed identifier counts as a possible reference.
  if (ts.isIdentifier(node) && node.text === name) return true;
  return ts.forEachChild(node, (child) => containsIdentifier(child, name) || undefined) === true;
}

function integrationPath(path: string): string | undefined {
  const rel = path.replace(/\\/g, "/").replace(/^src\//, "");
  return rel === "integration-support.ts" ||
    rel.startsWith("langchain/") ||
    rel.startsWith("openai-agents/")
    ? rel
    : undefined;
}

function isOwnIntegrationMember(node: ts.Node, name: string): boolean {
  let scope: ts.Node | undefined = node.parent;
  while (scope !== undefined) {
    if (ts.isClassDeclaration(scope) || ts.isClassExpression(scope)) {
      return scope.members.some((member) => member.name?.getText().replace(/["']/g, "") === name);
    }
    // Arrow functions inherit this; ordinary functions and object methods do not.
    if (
      ts.isFunctionDeclaration(scope) ||
      ts.isFunctionExpression(scope) ||
      ((ts.isMethodDeclaration(scope) ||
        ts.isGetAccessorDeclaration(scope) ||
        ts.isSetAccessorDeclaration(scope)) &&
        !ts.isClassDeclaration(scope.parent) &&
        !ts.isClassExpression(scope.parent))
    )
      return false;
    scope = scope.parent;
  }
  return false;
}

function integrationMemberName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.argumentExpression) &&
    node.argumentExpression.getText() === "Symbol.asyncIterator"
  )
    return "asyncIterator";
  return undefined;
}

const OPAQUE_ATTRIBUTION_SINKS = new Set([
  "factory",
  "createRun",
  "run",
  "scopeName",
  "namePrefix",
  "copyTags",
  "tags",
  "setTags",
  "withTags",
]);

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let owner = node.parent;
  while (owner) {
    if (ts.isFunctionLike(owner) && "body" in owner) return owner as ts.FunctionLikeDeclaration;
    owner = owner.parent;
  }
  return undefined;
}

function localDeclaration(node: ts.Node, checker: ts.TypeChecker): ts.Declaration | undefined {
  return checker.getSymbolAtLocation(node)?.valueDeclaration;
}

function importedType(
  type: ts.TypeNode | undefined,
  name: string,
  checker: ts.TypeChecker,
): boolean {
  if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return false;
  const declaration = checker.getSymbolAtLocation(type.typeName)?.declarations?.[0];
  return !!(
    declaration &&
    ts.isImportSpecifier(declaration) &&
    (declaration.propertyName ?? declaration.name).text === name &&
    ts.isImportDeclaration(declaration.parent.parent.parent) &&
    declaration.parent.parent.parent.moduleSpecifier.getText() === '"@openai/agents"'
  );
}

/** Only a symbol guarded by requireSolwynClient can supply the provider leaf. */
function isWrappedClient(node: ts.Expression, checker: ts.TypeChecker): boolean {
  const declaration = localDeclaration(node, checker);
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer)
    return false;
  let initializer = declaration.initializer;
  while (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer))
    initializer = initializer.expression;
  if (!ts.isIdentifier(initializer)) return false;
  const symbol = checker.getSymbolAtLocation(initializer);
  const owner = enclosingFunction(declaration);
  if (!symbol || !owner?.body) return false;
  let guarded = false;
  const visit = (child: ts.Node): void => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === "requireSolwynClient" &&
      child.pos < declaration.pos &&
      child.arguments[0] &&
      checker.getSymbolAtLocation(child.arguments[0]) === symbol
    ) {
      const imported = checker.getSymbolAtLocation(child.expression)?.declarations?.[0];
      guarded = !!(
        imported &&
        ts.isImportSpecifier(imported) &&
        ts.isImportDeclaration(imported.parent.parent.parent) &&
        /integration-support["']$/.test(imported.parent.parent.parent.moduleSpecifier.getText())
      );
    }
    if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit);
  };
  ts.forEachChild(owner.body, visit);
  return guarded;
}

function isProviderForward(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const receiver = callee.expression;
  if (
    callee.name.text === "create" &&
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === "completions" &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    receiver.expression.name.text === "chat"
  )
    return isWrappedClient(receiver.expression.expression, checker);
  if (["getResponse", "getStreamedResponse", "getRetryAdvice"].includes(callee.name.text)) {
    const declaration = localDeclaration(
      ts.isPropertyAccessExpression(receiver) ? receiver.name : receiver,
      checker,
    );
    return !!(
      declaration &&
      ts.isPropertyDeclaration(declaration) &&
      importedType(declaration.type, "Model", checker)
    );
  }
  if (callee.name.text === "run") {
    const declaration = localDeclaration(receiver, checker);
    return !!(
      declaration &&
      ts.isParameter(declaration) &&
      importedType(declaration.type, "Runner", checker)
    );
  }
  return false;
}

/** Reflection is limited to provider-model topology, never callback/request objects. */
function isModelTopology(node: ts.Node, checker: ts.TypeChecker): boolean {
  const derived = (expression: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(expression)) return false;
    seen.add(expression);
    if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression))
      return derived(expression.expression, seen);
    if (ts.isIdentifier(expression)) {
      const declaration = localDeclaration(expression, checker);
      return !!(
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        derived(declaration.initializer, seen)
      );
    }
    if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression))
      return false;
    const callee = expression.expression;
    if (callee.getText() === "Object.getPrototypeOf")
      return !!expression.arguments[0] && derived(expression.arguments[0], seen);
    if (callee.name.text !== "getModel") return false;
    const provider = localDeclaration(callee.expression, checker);
    return !!(
      provider &&
      ts.isVariableDeclaration(provider) &&
      provider.initializer &&
      ts.isNewExpression(provider.initializer) &&
      integrationMemberName(provider.initializer.expression) === "OpenAIProvider"
    );
  };
  const access = node.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== node) return false;
  if (access.name.text === "prototype") {
    const comparison = access.parent;
    return (
      ts.isBinaryExpression(comparison) && comparison.right === access && derived(comparison.left)
    );
  }
  const call = access.parent;
  return (
    ["getPrototypeOf", "hasOwn"].includes(access.name.text) &&
    ts.isCallExpression(call) &&
    call.expression === access &&
    !!call.arguments[0] &&
    derived(call.arguments[0])
  );
}

function isRetryError(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "error" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "args" &&
    enclosingFunction(node)?.name?.getText() === "getRetryAdvice"
  );
}

function isOpaqueForward(node: ts.Identifier, checker: ts.TypeChecker): boolean {
  const declaration = node.parent;
  if (
    (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration)) &&
    declaration.name === node
  )
    return true;
  const origin = localDeclaration(node, checker);
  return isOpaqueExpressionForward(node, checker, origin ? enclosingFunction(origin) : undefined);
}

function isOpaqueExpressionForward(
  value: ts.Expression,
  checker: ts.TypeChecker,
  origin?: ts.FunctionLikeDeclaration,
  visiting = new Set<ts.Node>(),
): boolean {
  let expression = value;
  while (
    ts.isParenthesizedExpression(expression.parent) ||
    ts.isAsExpression(expression.parent) ||
    ts.isTypeAssertionExpression(expression.parent) ||
    ts.isNonNullExpression(expression.parent) ||
    ts.isSatisfiesExpression(expression.parent)
  )
    expression = expression.parent;
  const parent = expression.parent;
  // Fresh input shape validation does not read any array item or content field.
  if (ts.isTypeOfExpression(parent)) return true;
  if (ts.isCallExpression(parent) && parent.expression.getText() === "Array.isArray") return true;
  if (ts.isCallExpression(parent) && parent.arguments.some((arg) => arg === expression)) {
    const callee = parent.expression;
    const name = integrationMemberName(callee) ?? (ts.isIdentifier(callee) ? callee.text : "");
    if (isProviderForward(parent, checker)) return true;
    if (LOGGER_METHODS.has(name) || OPAQUE_ATTRIBUTION_SINKS.has(name)) return false;
    const target = checker.getResolvedSignature(parent)?.declaration;
    if (
      !target ||
      target.getSourceFile() !== expression.getSourceFile() ||
      !(
        ts.isFunctionDeclaration(target) ||
        ts.isMethodDeclaration(target) ||
        ts.isFunctionExpression(target) ||
        ts.isArrowFunction(target)
      ) ||
      !target.body
    )
      return false;
    const parameter = target.parameters[parent.arguments.indexOf(expression)];
    return !!(
      parameter &&
      !parameter.dotDotDotToken &&
      ts.isIdentifier(parameter.name) &&
      /^_?opaque/.test(parameter.name.text) &&
      isOpaqueExpressionForward(parent, checker, origin, visiting)
    );
  }
  if (ts.isSpreadAssignment(parent))
    return isOpaqueExpressionForward(
      parent.parent as ts.ObjectLiteralExpression,
      checker,
      origin,
      visiting,
    );
  if (ts.isExpressionStatement(parent) && ts.isCallExpression(expression)) return true;
  if (
    !(
      (ts.isReturnStatement(parent) && parent.expression === expression) ||
      (ts.isArrowFunction(parent) && parent.body === expression)
    )
  )
    return false;
  const owner = enclosingFunction(expression);
  if (!owner) return false;
  // Direct callback/API returns are opaque. Captured returns must have verified callers.
  if (owner === origin) return true;
  if (visiting.has(owner)) return false;
  const next = new Set(visiting).add(owner);
  if (
    (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) &&
    ts.isCallExpression(owner.parent) &&
    owner.parent.expression === owner
  )
    return isOpaqueExpressionForward(owner.parent, checker, origin, next);
  const binding =
    owner.name ?? (ts.isVariableDeclaration(owner.parent) ? owner.parent.name : undefined);
  if (!binding) return false;
  const symbol = checker.getSymbolAtLocation(binding);
  if (!symbol) return false;
  let safe = true;
  let used = false;
  const visit = (node: ts.Node): void => {
    if (node !== binding && ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      used = true;
      if (
        !ts.isCallExpression(node.parent) ||
        node.parent.expression !== node ||
        !isOpaqueExpressionForward(node.parent, checker, origin, next)
      )
        safe = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(value.getSourceFile());
  return used && safe;
}

/** Reusable source-string rule; directory discovery is independent and tolerates absent integrations. */
function findIntegrationViolations(text: string, path: string): string[] {
  const rel = integrationPath(path);
  if (rel === undefined) return [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  // Only bind this source: imports and ambient types cannot grant forwarding privileges.
  const program = ts.createProgram(
    [path],
    { noLib: true, noResolve: true },
    {
      ...ts.createCompilerHost({}),
      getSourceFile: (file) => (file === path ? source : undefined),
    },
  );
  const checker = program.getTypeChecker();
  const violations: string[] = [];
  const report = (message: string): void => {
    violations.push(`${path}: integration ${message}`);
  };
  const readable = (name: string, node: ts.Node, own = false): void => {
    if (
      !INTEGRATION_READABLE_PROPERTIES.has(name) &&
      !(own && isOwnIntegrationMember(node, name))
    ) {
      report(`reads unapproved property '${name}'`);
    }
  };
  const assignmentPattern = (pattern: ts.Expression): void => {
    if (ts.isParenthesizedExpression(pattern)) {
      assignmentPattern(pattern.expression);
      return;
    }
    if (ts.isArrayLiteralExpression(pattern)) {
      report("uses array destructuring");
    } else if (ts.isObjectLiteralExpression(pattern)) {
      for (const property of pattern.properties) {
        if (ts.isSpreadAssignment(property)) report("uses rest destructuring");
        else if (ts.isShorthandPropertyAssignment(property)) {
          readable(property.name.text, property);
          if (LOGGER_METHODS.has(property.name.text))
            report("logger methods must not be destructured");
        } else if (ts.isPropertyAssignment(property)) {
          const name = propertyNameText(property.name);
          if (name === undefined) report("reads a computed property in destructuring");
          else {
            readable(name, property);
            if (LOGGER_METHODS.has(name)) report("logger methods must not be destructured");
          }
          assignmentPattern(property.initializer);
        }
      }
    } else if (
      ts.isBinaryExpression(pattern) &&
      pattern.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      assignmentPattern(pattern.left);
    }
  };
  const callbackParameters = (
    name: string,
    callback:
      | ts.MethodDeclaration
      | ts.ArrowFunction
      | ts.FunctionExpression
      | ts.GetAccessorDeclaration
      | ts.SetAccessorDeclaration,
  ): void => {
    const modelCallback =
      rel.startsWith("openai-agents/") && ["getResponse", "getStreamedResponse"].includes(name);
    if (!modelCallback && !/^(?:handle[A-Z]|on[A-Z_])/.test(name)) return;
    const structural = rel.startsWith("langchain/")
      ? LANGCHAIN_CALLBACK_PARAMETERS[name]
      : undefined;
    for (const [index, parameter] of callback.parameters.entries()) {
      if (!ts.isIdentifier(parameter.name)) {
        report(`callback parameter in '${name}' must not be destructured`);
        continue;
      }
      const identifier = parameter.name.text;
      if (/^_?opaque/.test(identifier) || structural?.[index] === identifier) continue;
      if (
        (callback.body && containsIdentifier(callback.body, identifier)) ||
        callback.parameters.some(
          (other) => other.initializer && containsIdentifier(other.initializer, identifier),
        )
      ) {
        report(`callback parameter '${identifier}' in '${name}' must be opaque or unreferenced`);
      }
    }
    if (callback.body && containsIdentifier(callback.body, "arguments")) {
      report("callback references implicit arguments");
    }
    // The metadata container is not opaque, but only this one structural key is readable.
    // Keep the origin restriction even if another integration admits a property of the same name.
    if (structural?.[5] === "metadata" && callback.body) {
      const visitMetadata = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          node.text === "metadata" &&
          !(
            (ts.isPropertyAccessExpression(node.parent) ||
              ts.isElementAccessExpression(node.parent)) &&
            node.parent.expression === node &&
            integrationMemberName(node.parent) === "langgraph_node"
          )
        )
          report("callback metadata may only read langgraph_node directly");
        ts.forEachChild(node, visitMetadata);
      };
      visitMetadata(callback.body);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      const name = propertyNameText(node.name);
      if (name !== undefined) {
        callbackParameters(name, node);
        if (ts.isGetAccessorDeclaration(node) && /^(?:handle[A-Z]|on[A-Z_])/.test(name)) {
          const returnedCallback = (child: ts.Node): void => {
            if (ts.isReturnStatement(child) && child.expression) {
              if (ts.isArrowFunction(child.expression) || ts.isFunctionExpression(child.expression))
                callbackParameters(name, child.expression);
              else report(`callback getter '${name}' must return a function expression directly`);
            } else if (!ts.isFunctionLike(child)) ts.forEachChild(child, returnedCallback);
          };
          if (node.body) ts.forEachChild(node.body, returnedCallback);
        }
      }
    }
    if (
      (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const name = propertyNameText(node.name);
      if (name !== undefined) callbackParameters(name, node.initializer);
    }
    if (
      ts.isCallExpression(node) &&
      integrationMemberName(node.expression) === "on" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[1] &&
      (ts.isArrowFunction(node.arguments[1]) || ts.isFunctionExpression(node.arguments[1]))
    ) {
      const event = node.arguments[0].text;
      const slots: Record<string, Record<number, string>> = {
        agent_start: { 1: "agent" },
        agent_end: { 1: "agent" },
        agent_handoff: { 1: "fromAgent", 2: "toAgent" },
        agent_tool_start: { 1: "agent", 2: "tool" },
        agent_tool_end: { 1: "agent", 2: "tool" },
      };
      const callback = node.arguments[1];
      for (const [index, parameter] of callback.parameters.entries()) {
        if (!ts.isIdentifier(parameter.name))
          report("Agents hook parameter must not be destructured");
        else if (
          !/^_?opaque/.test(parameter.name.text) &&
          slots[event]?.[index] !== parameter.name.text &&
          containsIdentifier(callback.body, parameter.name.text)
        )
          report(`Agents hook parameter '${parameter.name.text}' must be opaque or unreferenced`);
      }
    }
    let specifier = importSpecifier(node);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifier = node.argument.literal.text;
    }
    if (specifier !== undefined) {
      if (specifier.startsWith(".")) {
        const target = posix
          .normalize(posix.join(posix.dirname(rel), specifier))
          .replace(/\.(?:ts|js)$/, "");
        if (!INTEGRATION_CORE_IMPORTS.has(target) && !integrationPath(target)) {
          report(`imports forbidden core module '${specifier}'`);
        }
      } else if (specifier.startsWith("@solwyn/sdk") || specifier.startsWith("node:")) {
        report(`imports forbidden core/runtime module '${specifier}'`);
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        providerSdkPackage(specifier)
      ) {
        report(`uses dynamic import of provider/framework SDK '${specifier}'`);
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      readable(node.name.text, node, node.expression.kind === ts.SyntaxKind.ThisKeyword);
    }
    if (ts.isElementAccessExpression(node)) {
      const name = integrationMemberName(node);
      if (name === undefined) report("reads a computed property");
      else readable(name, node, node.expression.kind === ts.SyntaxKind.ThisKeyword);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = integrationMemberName(node);
      if (
        name !== undefined &&
        LOGGER_METHODS.has(name) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
        !isRetryError(node)
      ) {
        report("logger methods must be called directly, never aliased");
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      if (node.dotDotDotToken) report("uses rest destructuring");
      else {
        const name = propertyNameText(
          node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined),
        );
        if (name === undefined) report("reads a computed property in destructuring");
        else {
          readable(name, node);
          if (LOGGER_METHODS.has(name)) report("logger methods must not be destructured");
        }
      }
    }
    if (ts.isArrayBindingPattern(node)) report("uses array destructuring");
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      assignmentPattern(node.left);
    if (ts.isIdentifier(node) && /^_?opaque/.test(node.text) && !isOpaqueForward(node, checker)) {
      report(`uses opaque identifier '${node.text}' outside direct forwarding`);
    }
    if (
      ts.isIdentifier(node) &&
      node.text === "args" &&
      enclosingFunction(node)?.name?.getText() === "getRetryAdvice" &&
      !(ts.isParameter(node.parent) && node.parent.name === node) &&
      !(
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.expression === node &&
        isRetryError(node.parent)
      ) &&
      !(
        ts.isCallExpression(node.parent) &&
        isProviderForward(node.parent, checker) &&
        integrationMemberName(node.parent.expression) === "getRetryAdvice"
      )
    )
      report("retry advice may only inspect args.error or forward args to the delegate");
    if (ts.isIdentifier(node) && node.text === "Reflect") report("references Reflect");
    if (
      ts.isIdentifier(node) &&
      node.text === "Object" &&
      !(
        (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node &&
        integrationMemberName(node.parent) === "defineProperty"
      ) &&
      !isModelTopology(node, checker)
    )
      report("references Object outside defineProperty");
    if (ts.isIdentifier(node) && node.text === "fetch") report("references fetch");
    if (ts.isCallExpression(node)) {
      const name =
        integrationMemberName(node.expression) ??
        (ts.isIdentifier(node.expression) ? node.expression.text : undefined);
      if (name !== undefined && LOGGER_METHODS.has(name)) {
        for (const arg of node.arguments) {
          if (ts.isStringLiteralLike(arg)) continue;
          if (
            ts.isTemplateExpression(arg) &&
            arg.templateSpans.every(
              (span) =>
                ts.isIdentifier(span.expression) && RUN_ID_IDENTIFIER.test(span.expression.text),
            )
          )
            continue;
          report(
            "logger arguments must be literal strings or templates with run-id identifiers only",
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

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
    // import() accepts optional attributes; require() ignores extra arguments.
    // Neither form may hide a banned dependency behind a second argument.
    node.arguments.length >= 1 &&
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

function findEdgeNetworkViolations(file: SourceFile): string[] {
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

function findTestingNetworkViolations(file: SourceFile): string[] {
  const offenders = findEdgeNetworkViolations(file);
  if (/\b(?:Logger|logger)\b/.test(stripLiteralsAndComments(file.text))) {
    offenders.push(`${file.rel}: names a logger`);
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

  it("keeps velocity.ts content-blind and edge-safe when logging structural warnings", () => {
    const velocity = ALL_SOURCES.find((file) => file.rel === "velocity.ts");
    expect(velocity).toBeDefined();
    expect(FIREWALLED).toContain(velocity);
    expect(findLoggerViolations(velocity as SourceFile)).toEqual([]);
    expect(findEdgeNetworkViolations(velocity as SourceFile)).toEqual([]);
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

describe("privacy firewall — integration source controls", () => {
  const path = "src/langchain/mutation.ts";

  it("scans integration files that exist without requiring framework directories", () => {
    expect(ALL_SOURCES.flatMap((file) => findIntegrationViolations(file.text, file.rel))).toEqual(
      [],
    );
  });

  it.each([
    [
      "class helper",
      "this.end(this.leak(_opaqueOutput));",
      `leak(value: unknown) { return \`\${value}\`; }`,
      "",
    ],
    [
      "module helper",
      "this.end(leak(_opaqueOutput));",
      "",
      "function leak(value: Iterable<unknown>) { for (const item of value) {} }",
    ],
    ["run name", "this.factory(_opaqueOutput as string);", "", ""],
    [
      "object callback",
      "this.end(runId);",
      "",
      `const handler = { handleChainEnd: (output: unknown) => \`\${output}\` };`,
    ],
    [
      "callback getter",
      "this.end(runId);",
      `get handleText() { return (text: unknown) => \`\${text}\`; }`,
      "",
    ],
  ])("rejects a content-reading %s added to the shipped handler", (_label, call, member, helper) => {
    const shipped = readFileSync(join(SRC_ROOT, "langchain/index.ts"), "utf8");
    const mutated = shipped
      .replace("this.end(runId);", call)
      .replace("private assertNew(", `${member}\n  private assertNew(`);
    expect(
      findIntegrationViolations(`${mutated}\n${helper}`, "src/langchain/index.ts"),
    ).not.toEqual([]);
  });

  const escapeMutations = [
    ["arrow closure", "const leak = () => OPAQUE; this.factory(String(leak()));"],
    ["function closure", "function leak() { return OPAQUE; } this.factory(String(leak()));"],
    ["IIFE", "this.factory(String((() => OPAQUE)()));"],
    ["thunk", "this.relay(() => OPAQUE);"],
    ["interpolated closure", `const leak = () => OPAQUE; refusal(\`\${leak()}\`);`],
    [
      "shadowed provider",
      "const wrapped = { chat: { completions: { create: (v) => this.factory(String(v)) } } }; wrapped.chat.completions.create(OPAQUE);",
    ],
  ];
  it.each([...AGENTS_READABLE_PROPERTIES])("requires the reviewed Agents property %s", (name) => {
    const shipped = readFileSync(join(SRC_ROOT, "openai-agents/index.ts"), "utf8");
    INTEGRATION_READABLE_PROPERTIES.delete(name);
    try {
      expect(findIntegrationViolations(shipped, "src/openai-agents/index.ts")).toContain(
        `src/openai-agents/index.ts: integration reads unapproved property '${name}'`,
      );
    } finally {
      INTEGRATION_READABLE_PROPERTIES.add(name);
    }
  });
  it.each(escapeMutations)("rejects a LangChain opaque escape via %s", (_label, mutation) => {
    const shipped = readFileSync(join(SRC_ROOT, "langchain/index.ts"), "utf8");
    const marker = "this.startEdge(runId, parentRunId);";
    expect(shipped).toContain(marker);
    const mutated = shipped.replace(marker, mutation.replaceAll("OPAQUE", "_opaqueInput"));
    expect(findIntegrationViolations(mutated, "src/langchain/index.ts")).toEqual(
      expect.arrayContaining([expect.stringContaining("opaque")]),
    );
  });
  it.each(escapeMutations)("rejects an Agents opaque escape via %s", (_label, mutation) => {
    const shipped = readFileSync(join(SRC_ROOT, "openai-agents/index.ts"), "utf8");
    const marker = "async getResponse(opaqueRequest: ModelRequest) {";
    expect(shipped).toContain(marker);
    const mutated = shipped.replace(
      marker,
      `${marker}\n${mutation.replaceAll("OPAQUE", "opaqueRequest")}`,
    );
    const baseline = findIntegrationViolations(shipped, "src/openai-agents/index.ts");
    const added = findIntegrationViolations(mutated, "src/openai-agents/index.ts");
    expect(added.filter((line) => line.includes("opaque")).length).toBeGreaterThan(
      baseline.filter((line) => line.includes("opaque")).length,
    );
  });

  it.each([
    "src/langchain/nested/leaf.ts",
    "src/openai-agents/index.ts",
    "src/integration-support.ts",
  ])("applies the stricter rule to %s", (path) => {
    expect(findIntegrationViolations("const value = request.prediction;", path)).toEqual(
      expect.arrayContaining([expect.stringContaining("property 'prediction'")]),
    );
  });

  it("does not extend integration privileges or restrictions to other core files", () => {
    expect(
      findIntegrationViolations("const value = request.prediction;", "src/registry.ts"),
    ).toEqual([]);
    expect(isPrivileged("langchain/index.ts")).toBe(false);
    expect(isPrivileged("openai-agents/index.ts")).toBe(false);
    expect(isPrivileged("integration-support.ts")).toBe(false);
  });

  it.each([
    ["property read", "const result = callOptions.prediction;", "property 'prediction'"],
    ["optional property read", "const result = callOptions?.prediction;", "property 'prediction'"],
    ["literal element read", 'const result = request["tools"];', "property 'tools'"],
    ["computed element read", "const result = request[key];", "computed property"],
    ["binding shorthand", "const { messages } = request;", "property 'messages'"],
    ["aliased binding", "const { input: alias } = request;", "property 'input'"],
    ["nested binding", "const { config: { prompt: alias } } = request;", "property 'prompt'"],
    ["rest binding", "const { runId, ...rest } = request;", "rest destructuring"],
    ["assignment shorthand", "({ response } = request);", "property 'response'"],
    ["assignment alias", "({ content: alias } = request);", "property 'content'"],
    ["array binding", "const [first] = request;", "array destructuring"],
    ["array assignment", "[first] = request;", "array destructuring"],
    [
      "undeclared own member",
      "class Handler { f() { return this.payload; } }",
      "property 'payload'",
    ],
    [
      "foreign class member",
      "class Handler { payload = 1; f(other) { return other.payload; } }",
      "property 'payload'",
    ],
    [
      "nested class receiver",
      "class A { payload = 1; f() { return class B { g() { return this.payload; } }; } }",
      "property 'payload'",
    ],
    [
      "non-arrow receiver",
      "class A { payload = 1; f() { return function() { return this.payload; }; } }",
      "property 'payload'",
    ],
  ])("rejects integration %s", (_label, source, diagnostic) => {
    expect(findIntegrationViolations(source, path)).toEqual(
      expect.arrayContaining([expect.stringContaining(diagnostic)]),
    );
  });

  it.each([
    [
      "renamed callback reflection",
      'class Handler { handleChainStart(_serialized, input) { return String(Reflect.get(input, "question")); } }',
      "callback parameter 'input'",
    ],
    [
      "renamed callback Object iteration",
      "class Handler { handleChainStart(_serialized, input) { return String(Object.values(input)); } }",
      "callback parameter 'input'",
    ],
    [
      "renamed callback interpolation",
      `class Handler { handleChainStart(_serialized, input) { return \`\${input}\`; } }`,
      "callback parameter 'input'",
    ],
    [
      "renamed callback iteration",
      "class Handler { handleChainStart(_serialized, input) { for (const value of input) consume(value); } }",
      "callback parameter 'input'",
    ],
    [
      "widened callback metadata",
      "class Handler { handleChainStart(a, b, runId, parentRunId, tags, metadata?: Record<string, unknown>) { return metadata?.values; } }",
      "metadata",
    ],
    [
      "structural name in a content slot",
      "class Handler { handleChainStart(_serialized, runName) { return runName; } }",
      "callback parameter 'runName'",
    ],
    [
      "destructured callback content",
      "class Handler { handleChainStart(_serialized, { runId }) { return runId; } }",
      "callback parameter",
    ],
    [
      "renamed callback arrow parameter",
      `class Handler { handleChainStart = (_serialized, input) => \`\${input}\`; }`,
      "callback parameter 'input'",
    ],
    [
      "unknown callback parameter",
      `class Handler { handleAgentAction(input) { return \`\${input}\`; } }`,
      "callback parameter 'input'",
    ],
    [
      "implicit callback arguments",
      `class Handler { handleChainStart(_serialized, input) { return \`\${arguments}\`; } }`,
      "arguments",
    ],
    ["Reflect alias", "const reflect = Reflect;", "Reflect"],
    ["Object alias", "const object = Object;", "Object"],
    ["Object lookup", "const result = Object.get(request);", "Object"],
    ["Object iteration", "const result = Object.values(request);", "Object"],
  ])("rejects integration %s", (_label, source, diagnostic) => {
    expect(findIntegrationViolations(source, path)).toEqual(
      expect.arrayContaining([expect.stringContaining(diagnostic)]),
    );
  });

  it.each([
    "class Model { getResponse(input) { return input.name; } }",
    "class Model { getStreamedResponse(input) { return input.signal; } }",
    'runner.on("agent_start", (context, agent, turnInput) => consume(turnInput.name));',
    'runner.on("agent_tool_end", (context, agent, tool, result) => consume(result.name));',
    "class Model { getRetryAdvice(args) { return args.signal; } }",
    "class Model { getResponse(opaqueRequest) { return Object.getPrototypeOf(opaqueRequest); } }",
  ])("rejects renamed Agents content and request inspection: %s", (source) => {
    expect(findIntegrationViolations(source, "src/openai-agents/index.ts")).not.toEqual([]);
  });

  it("permits unused callback parameters and positional structural arguments", () => {
    const source = `
      class Handler {
        handleChainStart(serialized, input, runId, parentRunId, tags, metadata, runType, runName) {
          start(runId, parentRunId, runName, metadata?.langgraph_node);
        }
        handleLLMError(error, runId) { end(runId); }
        handleAgentAction(input) {}
        handleToolStart = (serialized, input, runId, parentRunId) => start(runId, parentRunId);
      }
      Object.defineProperty(failure, Symbol.for("langchain.errors.retryable"), { value: false });
    `;
    expect(findIntegrationViolations(source, path)).toEqual([]);
  });

  it.each([
    ["property access", "function f(opaque) { return opaque.runId; }"],
    ["binding", "function f(_opaque) { const { runId } = _opaque; }"],
    ["iteration", "function f(opaqueItems) { for (const item of opaqueItems) consume(item); }"],
    ["aliasing", "function f(opaque) { const renamed = opaque; }"],
    ["stringification", "function f(opaque) { return String(opaque); }"],
    ["JSON stringification", "function f(opaque) { return JSON.stringify(opaque); }"],
    ["reflection", "function f(opaque) { return Reflect.get(opaque, 'runId'); }"],
    ["Object iteration", "function f(opaque) { return Object.values(opaque); }"],
    ["template interpolation", `function f(opaque) { return \`\${opaque}\`; }`],
    ["logging", "function f(opaque) { logger.warn(opaque); }"],
    ["nested call argument", "function f(opaque) { return forward({ data: opaque }); }"],
    ["argument spread", "function f(opaque) { return forward(...opaque); }"],
    [
      "formatting through a class helper",
      `class Handler { handleChainEnd(_opaqueOutput) { this.end(this.leak(_opaqueOutput)); } end(runId) {} leak(value) { return \`\${value}\`; } }`,
    ],
    [
      "iteration through a module helper",
      "function leak(value) { for (const item of value) {} } class Handler { handleChainEnd(_opaqueOutput) { leak(_opaqueOutput); } }",
    ],
    [
      "a run factory argument",
      "class Handler { factory; handleChainEnd(_opaqueOutput) { this.factory(_opaqueOutput as string); } }",
    ],
    [
      "formatting in an opaque-named helper",
      `function leak(opaqueValue) { return \`\${opaqueValue}\`; } function f(opaque) { return leak(opaque); }`,
    ],
    [
      "a run factory through a passthrough helper",
      "function pass(opaqueValue) { return opaqueValue; } class Handler { factory; handleChainEnd(_opaqueOutput) { this.factory(pass(_opaqueOutput)); } }",
    ],
    [
      "a run factory through object spread",
      "class Handler { factory; handleChainEnd(_opaqueOutput) { this.factory({ ..._opaqueOutput }); } }",
    ],
    [
      "a naming sink with an opaque parameter",
      "function scopeName(opaqueName) { return opaqueName; } function f(opaque) { return scopeName(opaque); }",
    ],
    [
      "a tag sink with an opaque parameter",
      "function copyTags(opaqueTags) { return opaqueTags; } function f(opaque) { return copyTags(opaque); }",
    ],
    ["an unresolved helper", "function f(opaque) { return forward(opaque); }"],
    [
      "a shadowed helper",
      `function forward(opaqueValue) { return opaqueValue; } function f(opaque) { const forward = (value) => \`\${value}\`; return forward(opaque); }`,
    ],
  ])("rejects opaque %s", (_label, source) => {
    expect(findIntegrationViolations(source, path)).toEqual(
      expect.arrayContaining([expect.stringContaining("opaque")]),
    );
  });

  it.each([
    ["object arrow", `const handler = { handleChainEnd: (output) => \`\${output}\` };`],
    ["object method", `const handler = { handleChainEnd(output) { return \`\${output}\`; } };`],
    [
      "object function",
      `const handler = { handleChainEnd: function(output) { return \`\${output}\`; } };`,
    ],
    ["class arrow", `class Handler { handleChainEnd = (output) => \`\${output}\`; }`],
    ["getter arrow", `class Handler { get handleText() { return (text) => \`\${text}\`; } }`],
    ["object getter", `const handler = { get handleText() { return (text) => \`\${text}\`; } };`],
    [
      "getter function",
      `class Handler { get handleText() { return function(text) { return \`\${text}\`; }; } }`,
    ],
    [
      "getter alias",
      `class Handler { get handleText() { const render = (text) => \`\${text}\`; return render; } }`,
    ],
    ["setter", `class Handler { set handleText(text) { const result = \`\${text}\`; } }`],
  ])("rejects content in a callback %s", (_label, source) => {
    expect(findIntegrationViolations(source, path)).toEqual(
      expect.arrayContaining([expect.stringContaining("callback")]),
    );
  });

  it.each([
    "function forward(opaqueRequest, opaqueOptions) { return wrapped.chat.completions.create(opaqueRequest, opaqueOptions); }",
    "const forward = (opaqueRequest, opaqueOptions) => wrapped.chat.completions.create(opaqueRequest, opaqueOptions);",
  ])("permits opaque forwarding through a local helper: %s", (helper) => {
    const source = `import { requireSolwynClient } from "../integration-support";
      function leaf(client) { requireSolwynClient(client, "test"); const wrapped = client;
      ${helper}\nfunction f(opaqueRequest, opaqueOptions) { return forward(opaqueRequest, { ...opaqueOptions }); } }`;
    expect(findIntegrationViolations(source, path)).toEqual([]);
  });

  it("permits opaque forwarding through local methods and callback accessors", () => {
    const source = `class Handler {
      pass(opaqueValue) { return opaqueValue; }
      passArrow = (opaqueValue) => opaqueValue;
      f(opaqueValue) { return this.pass(this.passArrow(opaqueValue)); }
      get handleText() { return (_opaqueText) => {}; }
      set handleText(_opaqueCallback) {}
    }
    const handler = { handleChainEnd: (_opaqueOutput, runId) => end(runId) };`;
    expect(findIntegrationViolations(source, path)).toEqual([]);
  });

  it.each([
    "transport",
    "reporter",
    "budget",
    "lease",
    "client",
    "privacy",
    "providers/openai",
    "ai-sdk/index",
    "registry",
  ])("rejects integration imports of %s", (module) => {
    for (const source of [
      `import { x } from "../${module}";`,
      `import type { X } from "../${module}";`,
      `export { x } from "../${module}";`,
      `const x = require("../${module}");`,
      `const x = import("../${module}");`,
      `const x = import("../${module}", {});`,
      `type X = import("../${module}").X;`,
    ]) {
      expect(findIntegrationViolations(source, path), source).toEqual(
        expect.arrayContaining([expect.stringContaining("import")]),
      );
    }
  });

  it.each([
    "fetch(url)",
    "const send = fetch;",
    'globalThis["fetch"](url)',
    "client.fetch(url)",
  ])("rejects integration network capability %s", (source) => {
    expect(findIntegrationViolations(source, path)).toEqual(
      expect.arrayContaining([expect.stringContaining("fetch")]),
    );
  });

  it.each([
    "logger.warn(message)",
    "this.#logger.warn(error)",
    `logger.warn(\`failed \${reason}\`)`,
    `logger.warn(\`failed \${scope.runId}\`)`,
    "logger.warn('failed', { runId })",
    "logger['warn'](error)",
    "logger?.warn?.(error)",
    "const warn = logger.warn; warn(error)",
    "const { warn: emit } = logger; emit(error)",
    "({ warn: emit } = logger); emit(error)",
  ])("rejects integration logger arguments in %s", (source) => {
    expect(findIntegrationViolations(source, path)).toEqual(
      expect.arrayContaining([expect.stringContaining("logger")]),
    );
  });

  it("permits structural reads, own members, opaque forwarding, and literal/run-id logs", () => {
    const source = `
      import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
      import { requireDetachedRunFactory } from "../integration-support";
      import { requireSolwynClient } from "../integration-support";
      function leaf(client) { requireSolwynClient(client, "test"); const wrapped = client;
      function forward(opaqueRequest, opaqueOptions) {
        return wrapped.chat.completions.create(opaqueRequest, opaqueOptions);
      }
      class Handler {
        #scopes = new Map();
        localCount = 0;
        f(opaqueRequest, opaqueOptions, options, manager) {
          const { runId, handlers } = manager;
          const signal = options["signal"];
          this.localCount++;
          const readOwn = () => this.#scopes;
          logger.warn('closing a scope');
          this.logger.warn(\`closing \${runId} under \${parentRunId}\`);
          return forward(opaqueRequest, { ...opaqueOptions, signal });
        }
        logger;
        passthrough(_opaqueResult) { return _opaqueResult; }
        arrow = (opaqueResult) => opaqueResult;
      } }
    `;
    expect(findIntegrationViolations(source, path)).toEqual([]);
  });

  it.each(PROVIDER_SDK_PACKAGES)("blocks value imports and subpaths of %s", (pkg) => {
    for (const specifier of [pkg, `${pkg}/resources/example`]) {
      for (const source of [
        `import X from "${specifier}";`,
        `import {\n X,\n Y\n} from '${specifier}';`,
        `import * as sdk from "${specifier}";`,
        `import "${specifier}";`,
        `import { type X } from "${specifier}";`,
        `export { X } from "${specifier}";`,
        `const X = require("${specifier}");`,
        `const X = require("${specifier}", {});`,
        `import X = require("${specifier}");`,
      ]) {
        expect(findProviderValueImportViolations(source, path), source).not.toEqual([]);
      }
      expect(
        findProviderValueImportViolations(`import type { X } from "${specifier}";`, path),
      ).toEqual([]);
      expect(
        findProviderValueImportViolations(`export type { X } from "${specifier}";`, path),
      ).toEqual([]);
      expect(findIntegrationViolations(`const X = import("${specifier}");`, path)).toEqual(
        expect.arrayContaining([expect.stringContaining("dynamic import")]),
      );
      expect(findIntegrationViolations(`const X = import("${specifier}", {});`, path)).toEqual(
        expect.arrayContaining([expect.stringContaining("dynamic import")]),
      );
      expect(
        findProviderValueImportViolations(`const X = import("${specifier}");`, "src/registry.ts"),
      ).toEqual([]);
    }
  });
});

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

  it("no value import of a provider/framework SDK anywhere in src (whole-declaration type-only allowed)", () => {
    expect(
      ALL_SOURCES.flatMap((file) => findProviderValueImportViolations(file.text, file.rel)),
    ).toEqual([]);
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

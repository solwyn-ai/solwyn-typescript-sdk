import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("preserves installed native overloads and schema inference without promising missing methods", () => {
  const program = ts.createProgram([resolve("tests/types/native-provider-remediation.ts")], {
    noEmit: true,
    strict: true,
    skipLibCheck: false,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.esnext.disposable.d.ts"],
    types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const location =
      diagnostic.file && diagnostic.start !== undefined
        ? `${diagnostic.file.fileName}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}: `
        : "";
    return `${location}${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  });
  expect(diagnostics).toEqual([]);
}, 30_000);

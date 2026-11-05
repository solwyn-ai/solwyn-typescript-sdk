/**
 * Unit-test default project. Every Solwyn client needs a project (`project` option or
 * `SOLWYN_PROJECT`); tests that do not exercise project configuration inherit this one. Tests of
 * the missing-project path remove it with `vi.stubEnv("SOLWYN_PROJECT", undefined)` or resolve
 * against an explicit environment snapshot.
 */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
if (env !== undefined && env["SOLWYN_PROJECT"] === undefined) {
  env["SOLWYN_PROJECT"] = "test-project";
}

import { installOfflineGuard, OfflineViolationError } from "./offline-guard";

const CLEARED_ENV = [
  "LANGSMITH_TRACING",
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_API_KEY",
  "LANGSMITH_API_KEY",
  "OPENAI_API_KEY",
] as const;
const AGENTS_TRACING_ENV = "OPENAI_AGENTS_DISABLE_TRACING";

export interface IntegrationFetchAttempt {
  readonly url: string;
  readonly method: string;
}

export interface IntegrationEnv {
  readonly fetchAttempts: readonly IntegrationFetchAttempt[];
  socketAttempts(): number;
  restore(): void;
}

/**
 * Install BEFORE dynamically importing framework packages: they may read tracing
 * configuration or cache fetch during import. Give admitted provider calls an explicit
 * fake fetch instead. The tripwire records URL/method only, never bodies or headers.
 *
 * restore() restores environment variables and the exact previous fetch descriptor.
 * The reused socket guard is process-terminal by design; use isolated test workers.
 * Nested environments must restore in reverse installation order.
 */
export function installIntegrationEnv(): IntegrationEnv {
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const previousEnv = new Map(
    [...CLEARED_ENV, AGENTS_TRACING_ENV].map((key) => [key, process.env[key]]),
  );
  const guard = installOfflineGuard();
  const initialSocketAttempts = guard.socketAttempts();
  const fetchAttempts: IntegrationFetchAttempt[] = [];

  for (const key of CLEARED_ENV) delete process.env[key];
  process.env[AGENTS_TRACING_ENV] = "1";
  globalThis.fetch = async (input, init) => {
    fetchAttempts.push({
      url: input instanceof Request ? input.url : String(input),
      method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
    });
    throw new OfflineViolationError();
  };

  let restored = false;
  return {
    fetchAttempts,
    socketAttempts: () => guard.socketAttempts() - initialSocketAttempts,
    restore() {
      if (restored) return;
      restored = true;
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (previousFetch === undefined) Reflect.deleteProperty(globalThis, "fetch");
      else Object.defineProperty(globalThis, "fetch", previousFetch);
    },
  };
}

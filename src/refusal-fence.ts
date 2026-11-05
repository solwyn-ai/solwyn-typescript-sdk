/**
 * Refusal fence for spend that runs outside the budget check: unmetered and unrecognised spend
 * callables, and whatever they return.
 *
 * A stored blocking key refusal must stop such spend at its actual dispatch, not only at the
 * moment the method is invoked. Provider SDKs often dispatch later than the call that starts the
 * work: an OpenAI-style `APIPromise` sends after an async request hook, a stream helper sends a
 * microtask later, and a chat handle sends whenever `sendMessage` is called. The fence covers
 * those paths in three ways:
 *
 * - every call through a fenced callable checks the stored refusal first;
 * - calls on Stainless-style clients (OpenAI, Anthropic, Together) carry the binding's refusal
 *   signal in their request options, so the SDK's own pre-fetch abort check stops a deferred
 *   request once a refusal is stored, and an in-flight request is aborted;
 * - returned values are fenced: thenables re-check the refusal when consumed (`then`, `catch`,
 *   `finally`, `withResponse`, `asResponse`), and returned handles (chat sessions, stream
 *   helpers, derived clients) have every method fenced, invoked on the real object so private
 *   fields keep working.
 *
 * Content-free: only property names, functions and the refusal signal are inspected.
 */

/** What the fence needs from the project binding. */
export interface RefusalSource {
  /** The stored blocking refusal's error, or `null` when calls may run. */
  blockingRefusal(): Error | null;
  /** Aborts as soon as a blocking refusal is stored. */
  refusalSignal(): AbortSignal;
}

const THENABLE_CONSUMERS: ReadonlySet<PropertyKey> = new Set(["then", "catch", "finally"]);
const RESPONSE_CONSUMERS: ReadonlySet<PropertyKey> = new Set(["withResponse", "asResponse"]);

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** A class (constructing one is not a provider dispatch); unreadable sources count as callables. */
export function isClassValue(value: unknown): boolean {
  try {
    return /^class[\s{]/.test(Function.prototype.toString.call(value));
  } catch {
    return false;
  }
}

function isThenable(value: object): boolean {
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return false;
  }
}

/**
 * Whether an object can dispatch anything: a function-valued data property on it or on its
 * prototype chain below `Object.prototype` (methods of a chat session, stream helper or derived
 * client). Plain data records and arrays pass through unfenced.
 */
function hasMethods(value: object): boolean {
  try {
    if (Array.isArray(value)) return false;
    for (
      let current: object | null = value;
      current !== null && current !== Object.prototype && current !== Function.prototype;
      current = Object.getPrototypeOf(current)
    ) {
      for (const key of Reflect.ownKeys(current)) {
        if (key === "constructor") continue;
        const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
        if (descriptor !== undefined && typeof descriptor.value === "function") return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

/** Duck-typed Stainless request pipeline: the owner, or its `_client`, builds requests. */
function isStainlessOwner(owner: object | undefined): boolean {
  if (owner === undefined) return false;
  try {
    if (typeof Reflect.get(owner, "buildRequest") === "function") return true;
    const client: unknown = Reflect.get(owner, "_client");
    return isObjectLike(client) && typeof Reflect.get(client, "buildRequest") === "function";
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function combinedSignal(existing: unknown, refusal: AbortSignal): AbortSignal {
  if (!(existing instanceof AbortSignal)) return refusal;
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") return any.call(AbortSignal, [existing, refusal]);
  const controller = new AbortController();
  const forward = (): void => controller.abort();
  if (existing.aborted || refusal.aborted) controller.abort();
  else {
    existing.addEventListener("abort", forward, { once: true });
    refusal.addEventListener("abort", forward, { once: true });
  }
  return controller.signal;
}

/**
 * A Stainless event-stream helper (stream runners) raises an unhandled rejection when it is
 * aborted with no listener. When it carries the refusal signal, that abort is ours: observe it,
 * so a refusal never surfaces as an unhandled rejection. Consumers still get the refusal from
 * the fenced methods.
 */
function observeRefusalAbort(value: unknown): void {
  if (!isObjectLike(value)) return;
  try {
    const on: unknown = Reflect.get(value, "on");
    const controller: unknown = Reflect.get(value, "controller");
    if (typeof on === "function" && controller instanceof AbortController) {
      Reflect.apply(on, value, ["abort", () => {}]);
    }
  } catch {
    // Best effort: an unexpected helper shape keeps its native behaviour.
  }
}

export class RefusalFence {
  readonly #source: RefusalSource;
  readonly #callables = new WeakMap<object, object>();
  readonly #results = new WeakMap<object, object>();

  constructor(source: RefusalSource) {
    this.#source = source;
  }

  #assertNotRefused(): void {
    const refusal = this.#source.blockingRefusal();
    if (refusal !== null) throw refusal;
  }

  /** A provider error caused by the refusal signal surfaces as the refusal itself. */
  #mapError(error: unknown): unknown {
    return this.#source.blockingRefusal() ?? error;
  }

  /**
   * Fence a governed spend callable read from `owner` (the raw provider object). Classes and
   * non-functions pass through. One fence per callable keeps reads identity-stable.
   */
  callable<T>(value: T, owner?: object): T {
    if (typeof value !== "function" || isClassValue(value)) return value;
    const target = value as unknown as (...args: unknown[]) => unknown;
    const existing = this.#callables.get(target);
    if (existing !== undefined) return existing as T;
    const stainless = isStainlessOwner(owner);
    const fence = this;
    const guarded: object = new Proxy(target, {
      apply(fn, thisArg, args): unknown {
        fence.#assertNotRefused();
        const sent = stainless ? fence.#withRefusalSignal(fn, args) : args;
        const value: unknown = Reflect.apply(fn, thisArg, sent);
        // A method that returns its own receiver or owner (fluent APIs, `this`) hands back the
        // provider object the wrapper already exposes; it stays itself.
        if (value === thisArg || (owner !== undefined && value === owner)) return value;
        if (sent !== args) observeRefusalAbort(value);
        return fence.result(value);
      },
      construct(fn, args, newTarget): object {
        fence.#assertNotRefused();
        return Reflect.construct(fn, args, newTarget);
      },
    });
    this.#callables.set(target, guarded);
    return guarded as T;
  }

  /**
   * Stainless methods take request options last (`create(body, options)`, `retrieve(id,
   * options)`). Add the refusal signal there when the position is unambiguous; otherwise leave
   * the call untouched (the consume-time and call-time checks still apply).
   */
  #withRefusalSignal(fn: (...args: unknown[]) => unknown, args: unknown[]): unknown[] {
    const index = fn.length - 1;
    if (index < 0 || args.length > index + 1) return args;
    const options: unknown = args[index];
    if (options !== undefined && !isPlainRecord(options)) return args;
    const signal = this.#source.refusalSignal();
    const next = [...args];
    while (next.length < index) next.push(undefined);
    next[index] =
      options === undefined
        ? { signal }
        : { ...options, signal: combinedSignal(options["signal"], signal) };
    return next;
  }

  /** Fence a value returned by governed spend. Primitives and classes pass through. */
  result<T>(value: T): T {
    if (!isObjectLike(value)) return value;
    if (typeof value === "function") return this.callable(value);
    const existing = this.#results.get(value);
    if (existing !== undefined) return existing as T;
    if (!isThenable(value) && !hasMethods(value)) return value;
    const fenced = isThenable(value) ? this.#thenable(value) : this.#handle(value);
    this.#results.set(value, fenced);
    return fenced as T;
  }

  /** A promise-like: consuming it re-checks the refusal and maps a refusal abort to the refusal. */
  #thenable(target: object): object {
    const fence = this;
    const settle = (): Promise<unknown> => {
      const refusal = fence.#source.blockingRefusal();
      if (refusal !== null) {
        // The underlying request was aborted by the refusal signal or is never consumed; keep
        // its rejection observed.
        Promise.resolve(target).catch(() => {});
        return Promise.reject(refusal);
      }
      return Promise.resolve(target).catch((error: unknown) => {
        throw fence.#mapError(error);
      });
    };
    return new Proxy(target, {
      get(raw, key): unknown {
        if (THENABLE_CONSUMERS.has(key)) {
          const method = Reflect.get(Promise.prototype, key) as (...args: unknown[]) => unknown;
          return (...args: unknown[]) => Reflect.apply(method, settle(), args);
        }
        const value: unknown = Reflect.get(raw, key, raw);
        if (RESPONSE_CONSUMERS.has(key) && typeof value === "function") {
          return (...args: unknown[]): Promise<unknown> => {
            const refusal = fence.#source.blockingRefusal();
            if (refusal !== null) {
              Promise.resolve(target).catch(() => {});
              return Promise.reject(refusal);
            }
            return Promise.resolve(Reflect.apply(value, raw, args)).catch((error: unknown) => {
              throw fence.#mapError(error);
            });
          };
        }
        return value;
      },
    });
  }

  /** A returned handle: every method is fenced and runs on the real object. */
  #handle(target: object): object {
    const fence = this;
    const methods = new Map<PropertyKey, { raw: unknown; fenced: unknown }>();
    return new Proxy(target, {
      get(raw, key): unknown {
        const value: unknown = Reflect.get(raw, key, raw);
        const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
        if (descriptor?.configurable === false && descriptor.writable === false) return value;
        // Nested objects (a derived client's resources, a chat's model module) are fenced lazily.
        if (typeof value === "object" && value !== null) return fence.result(value);
        if (typeof value !== "function" || isClassValue(value)) return value;
        const cached = methods.get(key);
        if (cached !== undefined && cached.raw === value) return cached.fenced;
        const fenced = new Proxy(value as (...args: unknown[]) => unknown, {
          apply(fn, _thisArg, args): unknown {
            fence.#assertNotRefused();
            return fence.result(Reflect.apply(fn, raw, args));
          },
        });
        methods.set(key, { raw: value, fenced });
        return fenced;
      },
    });
  }
}

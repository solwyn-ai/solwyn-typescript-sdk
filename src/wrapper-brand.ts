/** Shared wrapper identity without importing provider detection or routing. */
const WRAPPERS_KEY = Symbol.for("@solwyn/sdk.wrappers");

interface GlobalWithWrappers {
  [WRAPPERS_KEY]?: WeakSet<object>;
}

const wrapperRegistry = globalThis as GlobalWithWrappers;
wrapperRegistry[WRAPPERS_KEY] ??= new WeakSet<object>();
const solwynWrappers = wrapperRegistry[WRAPPERS_KEY];

/** @internal Brand one successfully-created public wrapper proxy. */
export function brandSolwynWrapper(wrapper: object): void {
  solwynWrappers.add(wrapper);
}

/** @internal Truthful identity check; never inferred from client properties. */
export function isSolwynWrapper(value: unknown): value is object {
  return typeof value === "object" && value !== null && solwynWrappers.has(value);
}

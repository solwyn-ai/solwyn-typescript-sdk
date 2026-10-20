import { ConfigurationError } from "./errors";
import { type DetachedRunFactory, getDetachedRunFactory } from "./run-context";
import { isSolwynWrapper } from "./wrapper-brand";

/** Require Node attribution while leaving enforcement available in edge runtimes. */
export function requireDetachedRunFactory(integration: string): DetachedRunFactory {
  const factory = getDetachedRunFactory();
  if (factory === undefined) {
    throw new ConfigurationError(
      `${integration} attribution requires importing @solwyn/sdk/node; edge runtimes are unsupported for attribution. The wrapped client alone still enforces budgets.`,
      // The missing runtime installation is not a client or constructor-option error.
      // ConfigurationError's null field represents configuration without a named option.
      { field: null },
    );
  }
  return factory;
}

/** Require the actual SDK wrapper identity, without inspecting client properties. */
export function requireSolwynClient(value: unknown, integration: string): asserts value is object {
  if (!isSolwynWrapper(value)) {
    throw new ConfigurationError(`${integration} requires a Solwyn-wrapped client`, {
      field: "client",
    });
  }
}

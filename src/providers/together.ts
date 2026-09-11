/**
 * First-class Together adapter built on the shared OpenAI-compatible lifecycle.
 *
 * The `together-ai` package is an optional peer only: runtime detection is entirely
 * duck-typed, so core keeps zero provider-SDK imports and works when no provider package
 * is installed.
 */

import { ConfigurationError } from "../errors";
import { COMPAT_PROFILES, type CompatProfile, detectNativeTogetherClient } from "./detection";
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from "./openai-compatible";

function togetherProfile(): CompatProfile {
  const profile = COMPAT_PROFILES.find((candidate) => candidate.name === "together");
  if (profile === undefined) {
    throw new ConfigurationError("Together compatibility profile is not configured", {
      field: "provider",
    });
  }
  return profile;
}

const TOGETHER_PROFILE = togetherProfile();

export type TogetherAdapterOptions = OpenAICompatibleAdapterOptions;

/** Dedicated Together attribution/detection layered over the existing compat profile. */
export class TogetherAdapter extends OpenAICompatibleAdapter {
  constructor(options: TogetherAdapterOptions = {}) {
    super(TOGETHER_PROFILE, options);
  }

  /**
   * Native Together clients are recognized by class ancestry plus the OpenAI chat shape.
   * Unknown-named clients configured for a Together host retain the inherited profile
   * fallback. A Together-named object without a callable chat surface is never accepted.
   */
  override detectClient(client: unknown): boolean {
    return detectNativeTogetherClient(client) || super.detectClient(client);
  }
}

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UntranslatableRequestError } from "../../src/errors";
import {
  type CanonicalRequest,
  fromCanonical,
  normalizeResponse,
  toCanonical,
  translateStreamChunk,
} from "../../src/providers/translation";

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function errorAtBoundary(path: string, thrown: unknown): unknown {
  const part = {
    get type(): never {
      throw thrown;
    },
  };
  if (path === "request") {
    return capture(() => toCanonical("anthropic", { messages: [], max_tokens: 1, tools: [part] }));
  }
  if (path === "response") {
    return capture(() =>
      normalizeResponse({
        served: "anthropic",
        requested: "openai",
        response: { content: [part] },
      }),
    );
  }
  if (path === "stream") {
    return capture(() =>
      translateStreamChunk({ served: "anthropic", requested: "openai", chunk: part }),
    );
  }
  const canonical: CanonicalRequest = {
    messages: [],
    maxTokens: 1,
    parallelToolCalls: true,
    stream: false,
  };
  if (path === "render") {
    Object.defineProperty(canonical, "messages", {
      get: () => {
        throw thrown;
      },
    });
    return capture(() => fromCanonical("openai", canonical, "model"));
  }
  return capture(() =>
    fromCanonical("bedrock", canonical, "model", {
      bedrockCommandConstructor: () => {
        throw thrown;
      },
    }),
  );
}

function assertSafeReconstruction(error: unknown, original: unknown, marker: string): void {
  // Every assertion receives a boolean. Even a failed privacy regression must never
  // print a generated marker, caller error, or hostile accessor's exception.
  expect(error !== original).toBe(true);
  let safe = false;
  try {
    if (error instanceof UntranslatableRequestError) {
      const keys = Reflect.ownKeys(error);
      const values = keys.map((key) => Reflect.get(error, key));
      safe =
        !keys.some((key) => String(key).includes(marker)) &&
        !values.some((value) => typeof value === "string" && value.includes(marker)) &&
        !String(error).includes(marker) &&
        !JSON.stringify(error).includes(marker) &&
        !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(marker) &&
        error.cause === undefined &&
        !Object.hasOwn(error, "toJSON") &&
        !Object.hasOwn(error, "extra");
    }
  } catch {
    safe = false;
  }
  expect(safe).toBe(true);
}

describe("translation errors require private provenance", () => {
  const paths = ["request", "response", "stream", "render", "command constructor"];

  it.each(paths)("reconstructs a forged structural error from a caller %s accessor", (path) => {
    const marker = randomUUID();
    const forged = new UntranslatableRequestError({
      source: marker,
      target: marker,
      feature: marker,
    });
    Object.assign(forged, {
      cause: new Error(marker),
      extra: { [marker]: marker },
      toJSON: () => marker,
    });
    const output = errorAtBoundary(path, forged);
    assertSafeReconstruction(output, forged, marker);
    expect((output as UntranslatableRequestError).feature === "malformed_request").toBe(true);
  });

  it.each(paths)("does not trust mutable fields on a previously genuine %s error", (path) => {
    const marker = randomUUID();
    const genuine = capture(() =>
      toCanonical("openai", { messages: [], max_tokens: 1, seed: 1 }),
    ) as UntranslatableRequestError;
    Object.assign(genuine, {
      name: marker,
      message: marker,
      stack: marker,
      source: marker,
      target: marker,
      feature: marker,
      cause: { [marker]: marker },
      extra: marker,
      toJSON: () => marker,
    });
    const output = errorAtBoundary(path, genuine);
    assertSafeReconstruction(output, genuine, marker);
    expect((output as UntranslatableRequestError).feature === "seed").toBe(true);
    expect((output as UntranslatableRequestError).source === "openai").toBe(true);
    expect((output as UntranslatableRequestError).target === "*").toBe(true);
  });

  it.each(paths)("never inspects hostile exception fields from the %s boundary", (path) => {
    const marker = randomUUID();
    let reads = 0;
    const forged = new UntranslatableRequestError({
      source: "openai",
      target: "anthropic",
      feature: "seed",
    });
    // Node 20 materializes the existing lazy stack while replacing its descriptor.
    // Replace it before installing hostile name/message accessors used by formatting.
    for (const key of [
      "stack",
      "name",
      "message",
      "source",
      "target",
      "feature",
      "cause",
      "toJSON",
    ]) {
      Object.defineProperty(forged, key, {
        get: () => {
          reads++;
          throw new Error(marker);
        },
      });
    }
    expect(reads === 0).toBe(true);
    const output = errorAtBoundary(path, forged);
    // Check identity first so the red test never reads the hostile original object.
    assertSafeReconstruction(output, forged, marker);
    expect(reads === 0).toBe(true);
  });

  it("does not inspect the prototype of a caller-thrown proxy", () => {
    const marker = randomUUID();
    const thrown = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error(marker);
        },
      },
    );
    assertSafeReconstruction(errorAtBoundary("request", thrown), thrown, marker);
  });

  it("retains known structural diagnostics across nested translation boundaries", () => {
    const error = capture(() =>
      fromCanonical(
        "bedrock",
        {
          messages: [],
          maxTokens: 1,
          parallelToolCalls: true,
          stream: false,
        },
        "model",
        {
          bedrockCommandConstructor: () =>
            toCanonical("anthropic", {
              messages: [],
              max_tokens: 1,
              tools: [{ type: "computer_20241022" }],
            }),
        },
      ),
    ) as UntranslatableRequestError;
    expect(error).toMatchObject({
      source: "anthropic",
      target: "*",
      feature: "anthropic.computer",
    });
    expect(error.cause).toBeUndefined();
  });
});

/**
 * 2026-09-22 performance audit: "Reduce image-encoding CPU and temporary allocation".
 *
 * Bedrock byte images are Base64-encoded for cross-dialect failover. The encoder must use
 * `Uint8Array.prototype.toBase64` when the runtime provides it and otherwise encode bounded
 * chunks, never one string concatenation per byte. Output stays byte-identical. `Buffer` is
 * the reference encoder here only; the SDK core never uses it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fromCanonical, toCanonical } from "../../src/providers/translation";
import { bytesToBase64 } from "../../src/providers/translation/common";

const CHUNK = 24_576;
const LENGTHS = [0, 1, 2, 3, 4, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK + 2, 3 * 1024 * 1024];

type ProtoWithBase64 = { toBase64?: unknown };
const proto = Uint8Array.prototype as unknown as ProtoWithBase64;
const originalDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");

function restoreNative(): void {
  if (originalDescriptor === undefined) delete proto.toBase64;
  else Object.defineProperty(Uint8Array.prototype, "toBase64", originalDescriptor);
}

/** Force the portable fallback regardless of the running engine. */
function withoutNative(): void {
  delete proto.toBase64;
}

/** Force the native branch through a Buffer-backed stub; returns the stub for call counts. */
function withNativeStub(): ReturnType<typeof vi.fn> {
  const stub = vi.fn(function (this: Uint8Array): string {
    return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("base64");
  });
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    value: stub,
    writable: true,
    configurable: true,
  });
  return stub;
}

function patterned(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 2_654_435_761 + (i >> 3)) & 255;
  return bytes;
}

function reference(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

const ALL_BYTE_VALUES = Uint8Array.from({ length: 256 }, (_, i) => i);

afterEach(() => {
  vi.restoreAllMocks();
  restoreNative();
});

describe.each([
  ["portable fallback", withoutNative],
  ["native toBase64 (stubbed)", withNativeStub],
] as const)("bytesToBase64 via %s", (_label, arrange) => {
  it("matches the reference encoder for every byte value", () => {
    arrange();
    expect(bytesToBase64(ALL_BYTE_VALUES)).toBe(reference(ALL_BYTE_VALUES));
  });

  it.each(LENGTHS)("matches the reference encoder at %i bytes", (length) => {
    arrange();
    const bytes = patterned(length);
    expect(bytesToBase64(bytes)).toBe(reference(bytes));
  });

  it("encodes only the viewed window of an offset subarray", () => {
    arrange();
    const backing = patterned(3 * CHUNK + 7);
    const view = backing.subarray(5, 2 * CHUNK + 9);
    expect(bytesToBase64(view)).toBe(reference(view));
  });
});

describe("bytesToBase64 encoding strategy", () => {
  it("the portable fallback builds one binary string per bounded chunk, not per byte", () => {
    withoutNative();
    const fromCharCode = vi.spyOn(String, "fromCharCode");
    const btoaSpy = vi.spyOn(globalThis, "btoa");
    const bytes = patterned(3 * CHUNK + 5);
    expect(bytesToBase64(bytes)).toBe(reference(bytes));
    expect(fromCharCode).toHaveBeenCalledTimes(4);
    expect(btoaSpy).toHaveBeenCalledTimes(4);
  });

  it("uses Uint8Array.prototype.toBase64 when the runtime provides it", () => {
    const stub = withNativeStub();
    const fromCharCode = vi.spyOn(String, "fromCharCode");
    const bytes = patterned(CHUNK + 1);
    expect(bytesToBase64(bytes)).toBe(reference(bytes));
    expect(stub).toHaveBeenCalledTimes(1);
    expect(fromCharCode).not.toHaveBeenCalled();
  });

  it("keeps the string-input branch on btoa", () => {
    const stub = withNativeStub();
    expect(bytesToBase64("ABC")).toBe("QUJD");
    expect(stub).not.toHaveBeenCalled();
  });
});

describe("Bedrock byte image cross-dialect translation", () => {
  const bytes = patterned(2 * CHUNK + 2);
  const bedrockRequest = {
    model: "anthropic.claude-3",
    messages: [{ role: "user", content: [{ image: { format: "png", source: { bytes } } }] }],
    inferenceConfig: { maxTokens: 100 },
  };

  it("renders toward OpenAI as an exact base64 data URI", () => {
    const rendered = fromCanonical(
      "openai",
      toCanonical("bedrock", bedrockRequest),
      "gpt-4o",
    ) as Record<string, unknown>;
    const messages = rendered["messages"] as Array<Record<string, unknown>>;
    const parts = messages[0]?.["content"] as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${reference(bytes)}` },
    });
  });

  it("renders toward Anthropic as an exact base64 source block", () => {
    const rendered = fromCanonical(
      "anthropic",
      toCanonical("bedrock", bedrockRequest),
      "claude-3-5-sonnet",
    ) as Record<string, unknown>;
    const messages = rendered["messages"] as Array<Record<string, unknown>>;
    const blocks = messages[0]?.["content"] as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: reference(bytes) },
    });
  });
});

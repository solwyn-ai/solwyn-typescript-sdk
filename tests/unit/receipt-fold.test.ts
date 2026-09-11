import { describe, expect, it } from "vitest";
import {
  buildReceiptReplayEvents,
  type ReceiptFold,
  ReceiptFoldState,
  splitReceiptFold,
} from "../../src/receipt-fold";
import type { MediaUsage, MetadataEvent } from "../../src/types";
import { MetadataEventSchema } from "../../src/validation";

function testCallId(index: number): string {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
}

function deniedEvent(overrides: Partial<MetadataEvent> = {}): MetadataEvent {
  return {
    model: "gpt-5.5",
    provider: "openai",
    modality: "text",
    input_tokens: 3,
    output_tokens: 2,
    latency_ms: 11,
    status: "budget_denied",
    is_model_fallback: false,
    is_provider_fallback: false,
    attempt_index: 0,
    call_id: testCallId(1),
    sdk_instance_id: "sdk-receipt",
    timestamp: "2026-08-28T12:00:00.000Z",
    agent_run_id: "run-fold",
    deny_source: "server",
    deny_reason: "monthly",
    denied_by_period: "monthly",
    estimated_output_bound: 7,
    ...overrides,
  };
}

describe("ReceiptFoldState", () => {
  it("accumulates full aggregate cardinality and exact quantities before wire splitting", () => {
    const state = new ReceiptFoldState();
    const first = deniedEvent({
      input_tokens: 60_000_000,
      output_tokens: 20,
      estimated_output_bound: 30,
      media_usage: { audio_seconds: 0.25, is_estimated: true },
      receipt_aggregate_count: 40,
      receipt_pricing_input_tokens: 150_000,
      timestamp: "2026-08-28T12:00:02.000Z",
      velocity_flags: ["repeat_size"],
    });
    const second = deniedEvent({
      input_tokens: 90_000_000,
      output_tokens: 30,
      estimated_output_bound: 40,
      media_usage: { audio_seconds: 0.5, is_estimated: true },
      receipt_aggregate_count: 60,
      receipt_pricing_input_tokens: 150_000,
      timestamp: "2026-08-28T12:00:01.000Z",
      velocity_flags: ["rate_acceleration"],
    });

    expect(state.fold(first)).toBe("folded");
    expect(state.fold(second)).toBe("folded");

    const [entry] = state.snapshot();
    expect(entry?.key.receiptPricingInputTokens).toBe(150_000);
    expect(entry?.fold).toMatchObject({
      count: 100,
      inputTokens: 150_000_000,
      outputTokens: 50,
      estimatedOutputBound: 70,
      audioSeconds: 0.75,
      firstTimestamp: "2026-08-28T12:00:01.000Z",
      lastTimestamp: "2026-08-28T12:00:02.000Z",
    });
    expect(entry?.fold.velocityFlags).toEqual(new Set(["repeat_size", "rate_acceleration"]));
  });

  it("preserves discrete totals exactly past Number.MAX_SAFE_INTEGER", () => {
    const state = new ReceiptFoldState();
    state.fold(
      deniedEvent({
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: Number.MAX_SAFE_INTEGER,
        estimated_output_bound: Number.MAX_SAFE_INTEGER,
        media_usage: {
          image_count: Number.MAX_SAFE_INTEGER,
          generation_count: Number.MAX_SAFE_INTEGER,
          video_seconds: 1.25,
          audio_seconds: 2.5,
          input_characters: Number.MAX_SAFE_INTEGER,
        },
        receipt_aggregate_count: Number.MAX_SAFE_INTEGER,
        receipt_pricing_input_tokens: 1,
      }),
    );
    state.fold(
      deniedEvent({
        input_tokens: 2,
        output_tokens: 2,
        estimated_output_bound: 2,
        media_usage: {
          image_count: 2,
          generation_count: 2,
          video_seconds: 0.5,
          audio_seconds: 1.5,
          input_characters: 2,
        },
        receipt_aggregate_count: 2,
        receipt_pricing_input_tokens: 1,
      }),
    );

    expect(onlyEntry(state).fold).toMatchObject({
      count: 9_007_199_254_740_993n,
      inputTokens: 9_007_199_254_740_993n,
      outputTokens: 9_007_199_254_740_993n,
      estimatedOutputBound: 9_007_199_254_740_993n,
      imageCount: 9_007_199_254_740_993n,
      generationCount: 9_007_199_254_740_993n,
      videoSeconds: 1.75,
      audioSeconds: 4,
      inputCharacters: 9_007_199_254_740_993n,
    });
  });

  it.each([
    [
      "receipt aggregate count",
      (event: MetadataEvent) => (event.receipt_aggregate_count = Infinity),
    ],
    ["input tokens", (event: MetadataEvent) => (event.input_tokens = Number.NaN)],
    ["output tokens", (event: MetadataEvent) => (event.output_tokens = Infinity)],
    [
      "estimated output bound",
      (event: MetadataEvent) => (event.estimated_output_bound = Number.NEGATIVE_INFINITY),
    ],
    [
      "receipt pricing input tokens",
      (event: MetadataEvent) => (event.receipt_pricing_input_tokens = Infinity),
    ],
    [
      "image count",
      (event: MetadataEvent) => {
        event.media_usage = { image_count: Infinity };
      },
    ],
    [
      "video seconds",
      (event: MetadataEvent) => {
        event.media_usage = { video_seconds: Infinity };
      },
    ],
    [
      "audio seconds",
      (event: MetadataEvent) => {
        event.media_usage = { audio_seconds: Number.NaN };
      },
    ],
    [
      "type-invalid discrete quantity",
      (event: MetadataEvent) => (event.input_tokens = "3" as unknown as number),
    ],
    [
      "type-invalid seconds quantity",
      (event: MetadataEvent) => {
        event.media_usage = { video_seconds: "0.5" as unknown as number };
      },
    ],
  ])("rejects a runtime-invalid %s before retaining it", (_field, corrupt) => {
    const state = new ReceiptFoldState();
    const invalid = deniedEvent({
      receipt_aggregate_count: 2,
      receipt_pricing_input_tokens: 3,
    });
    corrupt(invalid);

    expect(() => state.fold(invalid)).toThrow();
    expect(state.snapshot()).toEqual([]);
  });

  it.each([
    ["model", (event: MetadataEvent) => (event.model = "m".repeat(2_049))],
    [
      "provider",
      (event: MetadataEvent) => (event.provider = "future-provider" as MetadataEvent["provider"]),
    ],
    [
      "modality",
      (event: MetadataEvent) => (event.modality = "future-modality" as MetadataEvent["modality"]),
    ],
    ["nonempty run id", (event: MetadataEvent) => (event.agent_run_id = "r".repeat(257))],
    ["provider region", (event: MetadataEvent) => (event.provider_region = "r".repeat(33))],
    ["service tier", (event: MetadataEvent) => (event.service_tier = "s".repeat(33))],
    ["nonempty deny reason", (event: MetadataEvent) => (event.deny_reason = "r".repeat(65))],
    ["nonempty denied period", (event: MetadataEvent) => (event.denied_by_period = "p".repeat(33))],
    [
      "receipt pricing basis",
      (event: MetadataEvent) => (event.receipt_pricing_input_tokens = 100_000_001),
    ],
    [
      "velocity flags",
      (event: MetadataEvent) =>
        (event.velocity_flags = ["future-flag"] as unknown as MetadataEvent["velocity_flags"]),
    ],
    [
      "media resolution",
      (event: MetadataEvent) => {
        event.media_usage = { resolution: "r".repeat(33) };
      },
    ],
    [
      "media quality",
      (event: MetadataEvent) => {
        event.media_usage = { quality: "q".repeat(33) };
      },
    ],
    [
      "media estimation marker",
      (event: MetadataEvent) => {
        event.media_usage = { is_estimated: "yes" as unknown as boolean };
      },
    ],
  ])("rejects an invalid replay-retained %s before retaining it", (_field, corrupt) => {
    const state = new ReceiptFoldState();
    const invalid = deniedEvent({
      receipt_aggregate_count: 2,
      receipt_pricing_input_tokens: 3,
    });
    corrupt(invalid);

    expect(() => state.fold(invalid)).toThrow();
    expect(state.snapshot()).toEqual([]);
  });

  it("validates velocity flags after deduplicating the replayed set", () => {
    const state = new ReceiptFoldState();
    const repeatedFlags = Array.from({ length: 9 }, () => "repeat_size" as const);

    expect(state.fold(deniedEvent({ velocity_flags: repeatedFlags }))).toBe("folded");

    const entry = onlyEntry(state);
    const [replay] = buildReceiptReplayEvents(entry.key, entry.fold, "sdk-repaired");
    expect(entry.fold.velocityFlags).toEqual(new Set(["repeat_size"]));
    expect(replay?.velocity_flags).toEqual(["repeat_size"]);
    expect(MetadataEventSchema.safeParse(replay).success).toBe(true);
  });

  it("repairs invalid original-only fields instead of rejecting their receipt", () => {
    const state = new ReceiptFoldState();
    const repairable = deniedEvent({
      call_id: "invalid-original-call-id",
      sdk_instance_id: "",
      timestamp: "not-a-timestamp",
      agent_run_id: "",
      parent_agent_run_id: "p".repeat(257),
      agent_run_name: "n".repeat(256),
      tags: { "": "invalid-tag" },
      requested_provider: "future-provider" as MetadataEvent["requested_provider"],
      requested_model: "m".repeat(2_049),
      failover_reason: "future-reason" as MetadataEvent["failover_reason"],
      failover_error_class: "!".repeat(65),
      latency_ms: Infinity,
      deny_source: "future-source" as MetadataEvent["deny_source"],
      deny_reason: "",
      denied_by_period: "",
    });

    expect(state.fold(repairable)).toBe("folded");
    const entry = onlyEntry(state);
    const [replay] = buildReceiptReplayEvents(entry.key, entry.fold, "sdk-repaired");

    expect(entry.key.originalSource).toBe("future-source");
    expect(replay?.deny_source).toBe("aggregate_replay");
    expect(replay?.call_id).not.toBe("invalid-original-call-id");
    expect(MetadataEventSchema.safeParse(replay).success).toBe(true);
  });

  it("truncates finite discrete quantities while preserving finite seconds fractions", () => {
    const state = new ReceiptFoldState();

    state.fold(
      deniedEvent({
        input_tokens: 3.9,
        output_tokens: -2.4,
        estimated_output_bound: 4.8,
        receipt_aggregate_count: 2.9,
        receipt_pricing_input_tokens: 1.9,
        media_usage: {
          image_count: 5.7,
          generation_count: -3.2,
          video_seconds: 0.75,
          audio_seconds: -0.25,
          input_characters: 8.9,
        },
      }),
    );

    const entry = onlyEntry(state);
    expect(entry.key.receiptPricingInputTokens).toBe(1);
    expect(entry.fold).toMatchObject({
      count: 2,
      inputTokens: 3,
      outputTokens: 0,
      estimatedOutputBound: 4,
      imageCount: 5,
      generationCount: 0,
      videoSeconds: 0.75,
      audioSeconds: 0,
      inputCharacters: 8,
    });
  });

  it("returns not_denied without retaining an ordinary event", () => {
    const state = new ReceiptFoldState();

    expect(state.fold(deniedEvent({ status: "success" }))).toBe("not_denied");
    expect(state.snapshot()).toEqual([]);
  });

  it("retains 256 keys, refuses a genuinely new key, and keeps existing keys writable", () => {
    const state = new ReceiptFoldState();
    for (let index = 0; index < 256; index += 1) {
      expect(state.fold(deniedEvent({ agent_run_id: `capacity-${index}`, input_tokens: 3 }))).toBe(
        "folded",
      );
    }

    expect(
      state.fold(
        deniedEvent({
          agent_run_id: "capacity-overflow",
          input_tokens: 9,
          receipt_aggregate_count: 7,
          receipt_pricing_input_tokens: 9,
        }),
      ),
    ).toBe("overflow");
    expect(state.fold(deniedEvent({ agent_run_id: "capacity-0", input_tokens: 3 }))).toBe("folded");

    const snapshot = state.snapshot();
    expect(snapshot).toHaveLength(256);
    expect(snapshot.find(({ key }) => key.runId === "capacity-0")?.fold.count).toBe(2);
  });

  it("downgrades a new exact key into an existing coarse key when the table is full", () => {
    const state = new ReceiptFoldState();
    state.fold(
      deniedEvent({
        agent_run_id: "coarse-at-capacity",
        input_tokens: 7,
        receipt_aggregate_count: 2,
      }),
    );
    for (let index = 0; index < 255; index += 1) {
      state.fold(deniedEvent({ agent_run_id: `filler-${index}`, input_tokens: 3 }));
    }

    expect(state.fold(deniedEvent({ agent_run_id: "coarse-at-capacity", input_tokens: 9 }))).toBe(
      "folded",
    );

    expect(state.snapshot()).toHaveLength(256);
    const coarse = state.snapshot().find(({ key }) => key.runId === "coarse-at-capacity");
    expect(coarse?.key.receiptPricingInputTokens).toBeNull();
    expect(coarse?.fold).toMatchObject({ count: 3, inputTokens: 16 });
  });

  it("downgrades only the pricing basis after 32 exact keys for one run", () => {
    const state = new ReceiptFoldState();
    for (let inputTokens = 1; inputTokens <= 300; inputTokens += 1) {
      expect(state.fold(deniedEvent({ input_tokens: inputTokens }))).toBe("folded");
    }
    expect(state.fold(deniedEvent({ agent_run_id: "bystander", input_tokens: 999 }))).toBe(
      "folded",
    );

    const runEntries = state.snapshot().filter(({ key }) => key.runId === "run-fold");
    const exact = runEntries.filter(({ key }) => key.receiptPricingInputTokens !== null);
    const coarse = runEntries.filter(({ key }) => key.receiptPricingInputTokens === null);
    expect(exact).toHaveLength(32);
    expect(coarse).toHaveLength(1);
    expect(coarse[0]?.fold.count).toBe(268);
    expect(runEntries.reduce((total, { fold }) => total + Number(fold.count), 0)).toBe(300);
    expect(
      state.snapshot().find(({ key }) => key.runId === "bystander")?.key.receiptPricingInputTokens,
    ).toBe(999);
  });

  it("uses every field in the 19-field pricing-compatible key", () => {
    const state = new ReceiptFoldState();
    const baseline = deniedEvent({
      input_tokens: 101,
      media_usage: {
        image_count: 0,
        generation_count: 0,
        video_seconds: 0,
        audio_seconds: 0,
        input_characters: 0,
        resolution: "1024x1024",
        quality: "standard",
        is_estimated: false,
      },
      provider_region: "us-east-1",
      service_tier: "standard",
    });
    const variants: MetadataEvent[] = [
      deniedEvent({ ...baseline, agent_run_id: "run-other" }),
      deniedEvent({ ...baseline, deny_source: "sticky_replay" }),
      deniedEvent({ ...baseline, deny_reason: "run_stopped" }),
      deniedEvent({ ...baseline, denied_by_period: "agent_run" }),
      deniedEvent({ ...baseline, model: "gpt-5.6" }),
      deniedEvent({ ...baseline, provider: "anthropic" }),
      deniedEvent({ ...baseline, provider_region: "eu-west-1" }),
      deniedEvent({ ...baseline, service_tier: "priority" }),
      deniedEvent({ ...baseline, modality: "audio" }),
      deniedEvent({ ...baseline, input_tokens: 102 }),
      deniedEvent({ ...baseline, media_usage: null }),
      deniedEvent({
        ...baseline,
        media_usage: { ...baseline.media_usage, image_count: undefined },
      }),
      deniedEvent({
        ...baseline,
        media_usage: { ...baseline.media_usage, generation_count: undefined },
      }),
      deniedEvent({
        ...baseline,
        media_usage: { ...baseline.media_usage, video_seconds: undefined },
      }),
      deniedEvent({
        ...baseline,
        media_usage: { ...baseline.media_usage, audio_seconds: undefined },
      }),
      deniedEvent({
        ...baseline,
        media_usage: { ...baseline.media_usage, input_characters: undefined },
      }),
      deniedEvent({
        ...baseline,
        media_usage: { ...baseline.media_usage, resolution: "512x512" },
      }),
      deniedEvent({
        ...baseline,
        media_usage: { ...baseline.media_usage, quality: "hd" },
      }),
      deniedEvent({
        ...baseline,
        media_usage: { ...baseline.media_usage, is_estimated: true },
      }),
    ];

    expect(state.fold(baseline)).toBe("folded");
    for (const variant of variants) expect(state.fold(variant)).toBe("folded");

    expect(state.snapshot()).toHaveLength(20);
  });

  it("keeps explicit-zero media separate from absent media", () => {
    const state = new ReceiptFoldState();

    state.fold(deniedEvent({ media_usage: {} }));
    state.fold(deniedEvent({ media_usage: { image_count: 0 } }));

    const entries = state.snapshot();
    expect(entries).toHaveLength(2);
    expect(entries.map(({ key }) => key.hasImageCount).sort()).toEqual([false, true]);
    expect(entries.map(({ fold }) => fold.imageCount).sort()).toEqual([0, null]);
  });

  it("does not inspect or retain caller-owned non-fold fields", () => {
    const state = new ReceiptFoldState();
    const base = deniedEvent({
      agent_run_name: "secret-run-name",
      failover_error_class: "SecretException",
      tags: { private_tag: "secret-tag-value" },
    });
    const allowed = new Set([
      "status",
      "agent_run_id",
      "deny_source",
      "deny_reason",
      "denied_by_period",
      "model",
      "provider",
      "provider_region",
      "service_tier",
      "modality",
      "receipt_pricing_input_tokens",
      "receipt_aggregate_count",
      "media_usage",
      "input_tokens",
      "output_tokens",
      "estimated_output_bound",
      "velocity_flags",
      "timestamp",
    ]);
    const hostile = new Proxy(base, {
      get(target, property, receiver) {
        if (typeof property === "string" && !allowed.has(property)) {
          throw new Error(`unexpected field access: ${property}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => state.fold(hostile)).not.toThrow();
    const retained = JSON.stringify(state.snapshot()[0]?.fold);
    expect(retained).not.toContain("secret-run-name");
    expect(retained).not.toContain("SecretException");
    expect(retained).not.toContain("secret-tag-value");
  });

  it("uses clean-cycle proof as a one-shot gate for the following cycle", () => {
    const state = new ReceiptFoldState();
    state.fold(deniedEvent());

    expect(state.takeForCycle({ final: false })).toEqual([]);
    expect(state.snapshot()).toHaveLength(1);

    state.noteCycleSuccess();
    expect(state.snapshot()).toHaveLength(1);
    const taken = state.takeForCycle({ final: false });
    expect(taken).toHaveLength(1);
    expect(state.snapshot()).toEqual([]);

    state.fold(deniedEvent({ input_tokens: 4 }));
    expect(state.takeForCycle({ final: false })).toEqual([]);
    expect(state.snapshot()).toHaveLength(1);
  });

  it("consumes clean-cycle proof even when there is nothing to take", () => {
    const state = new ReceiptFoldState();

    state.noteCycleSuccess();
    expect(state.takeForCycle({ final: false })).toEqual([]);
    state.fold(deniedEvent());

    expect(state.takeForCycle({ final: false })).toEqual([]);
    expect(state.snapshot()).toHaveLength(1);
  });

  it("takes unconditionally for final ownership and permanently seals folding", () => {
    const state = new ReceiptFoldState();
    state.fold(deniedEvent({ receipt_aggregate_count: 4, receipt_pricing_input_tokens: 3 }));

    const taken = state.takeForCycle({ final: true });
    expect(taken[0]?.fold.count).toBe(4);
    expect(state.snapshot()).toEqual([]);
    expect(state.fold(deniedEvent())).toBe("terminal");

    state.noteCycleSuccess();
    expect(state.takeForCycle({ final: false })).toEqual([]);
    expect(state.takeForCycle({ final: true })).toEqual([]);
  });

  it("returns deep snapshots that cannot mutate retained state", () => {
    const state = new ReceiptFoldState();
    state.fold(deniedEvent({ velocity_flags: ["repeat_size"] }));
    const snapshot = state.snapshot();
    const entry = snapshot[0];
    if (entry === undefined) throw new Error("missing fold fixture");

    entry.fold.count = 999;
    entry.fold.velocityFlags.add("monotonic_growth");

    expect(state.snapshot()[0]?.fold.count).toBe(1);
    expect(state.snapshot()[0]?.fold.velocityFlags).toEqual(new Set(["repeat_size"]));
  });
});

function directFold(overrides: Partial<ReceiptFold> = {}): ReceiptFold {
  return {
    count: 1,
    inputTokens: 0,
    outputTokens: 0,
    estimatedOutputBound: 0,
    velocityFlags: new Set(),
    imageCount: null,
    generationCount: null,
    videoSeconds: null,
    audioSeconds: null,
    inputCharacters: null,
    firstTimestamp: "2026-08-28T12:00:00.000Z",
    lastTimestamp: "2026-08-28T12:00:00.000Z",
    model: "gpt-5.5",
    provider: "openai",
    ...overrides,
  };
}

function onlyEntry(state: ReceiptFoldState) {
  const entry = state.snapshot()[0];
  if (entry === undefined) throw new Error("missing fold fixture");
  return entry;
}

describe("receipt replay splitting and building", () => {
  it("builds fresh content-blind replay identities and omits nullish fields", () => {
    const state = new ReceiptFoldState();
    const original = deniedEvent({
      call_id: testCallId(91),
      input_tokens: 150_000,
      output_tokens: 9,
      estimated_output_bound: 11,
      modality: "image",
      media_usage: {
        image_count: 0,
        audio_seconds: 1.25,
        resolution: "1024x1024",
        quality: "hd",
        is_estimated: true,
      },
      provider_region: "us-east-1",
      service_tier: "priority",
      velocity_flags: ["repeat_size", "monotonic_growth", "rate_acceleration"],
    });
    state.fold(original);
    const { key, fold } = onlyEntry(state);

    const [replay] = buildReceiptReplayEvents(key, fold, null);
    if (replay === undefined) throw new Error("missing replay fixture");

    expect(replay).toMatchObject({
      model: "gpt-5.5",
      provider: "openai",
      provider_region: "us-east-1",
      service_tier: "priority",
      modality: "image",
      input_tokens: 150_000,
      output_tokens: 9,
      media_usage: {
        image_count: 0,
        audio_seconds: 1.25,
        resolution: "1024x1024",
        quality: "hd",
        is_estimated: true,
      },
      latency_ms: 0,
      status: "budget_denied",
      is_model_fallback: false,
      is_provider_fallback: false,
      attempt_index: 0,
      sdk_instance_id: "receipt-fold",
      agent_run_id: "run-fold",
      deny_source: "aggregate_replay",
      deny_reason: "monthly",
      denied_by_period: "monthly",
      estimated_output_bound: 11,
      velocity_flags: ["monotonic_growth", "rate_acceleration", "repeat_size"],
      receipt_aggregate_count: 1,
      receipt_pricing_input_tokens: 150_000,
    });
    expect(replay.call_id).not.toBe(original.call_id);
    expect(replay.call_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(replay.timestamp))).toBe(false);
    expect(Object.hasOwn(replay, "token_details")).toBe(false);
    expect(Object.hasOwn(replay, "agent_run_name")).toBe(false);
    expect(Object.hasOwn(replay, "tags")).toBe(false);
    expect(Object.hasOwn(replay, "requested_model")).toBe(false);
    expect(MetadataEventSchema.safeParse(replay).success).toBe(true);

    const [emptySdkIdReplay] = buildReceiptReplayEvents(key, fold, "");
    expect(emptySdkIdReplay?.sdk_instance_id).toBe("");
    expect(emptySdkIdReplay?.call_id).not.toBe(replay.call_id);
  });

  it("splits every wire quantity at 100M with unique replay IDs and refolds exactly", () => {
    const state = new ReceiptFoldState();
    for (let index = 0; index < 3; index += 1) {
      state.fold(
        deniedEvent({
          input_tokens: 90_000_000,
          output_tokens: 100_000_000,
          estimated_output_bound: 100_000_000,
          receipt_aggregate_count: 60_000_000,
          receipt_pricing_input_tokens: 272_000,
        }),
      );
    }
    const original = onlyEntry(state);

    const chunks = buildReceiptReplayEvents(original.key, original.fold, "sdk-chunked");

    expect(chunks).toHaveLength(3);
    expect(chunks.map((event) => event.receipt_aggregate_count)).toEqual([
      100_000_000, 79_999_999, 1,
    ]);
    expect(chunks.map((event) => event.input_tokens)).toEqual([
      100_000_000, 100_000_000, 70_000_000,
    ]);
    expect(chunks.map((event) => event.output_tokens)).toEqual([
      100_000_000, 100_000_000, 100_000_000,
    ]);
    expect(chunks.map((event) => event.estimated_output_bound)).toEqual([
      100_000_000, 100_000_000, 100_000_000,
    ]);
    expect(new Set(chunks.map((event) => event.call_id)).size).toBe(3);
    expect(chunks.every((event) => MetadataEventSchema.safeParse(event).success)).toBe(true);

    const refolded = new ReceiptFoldState();
    for (const chunk of chunks) expect(refolded.fold(chunk)).toBe("folded");
    const replayed = onlyEntry(refolded);
    expect(replayed.key.originalSource).toBe("aggregate_replay");
    expect(replayed.key.receiptPricingInputTokens).toBe(272_000);
    expect(replayed.fold).toMatchObject({
      count: 180_000_000,
      inputTokens: 270_000_000,
      outputTokens: 300_000_000,
      estimatedOutputBound: 300_000_000,
    });
  });

  it("reserves at least one count for every chunk", () => {
    const chunks = splitReceiptFold(
      directFold({ count: 3, inputTokens: 300_000_000, outputTokens: 3, estimatedOutputBound: 3 }),
    );

    expect(chunks.map(({ count }) => count)).toEqual([1, 1, 1]);
    expect(chunks.map(({ outputTokens }) => outputTokens)).toEqual([3, 0, 0]);
    expect(chunks.map(({ estimatedOutputBound }) => estimatedOutputBound)).toEqual([3, 0, 0]);
  });

  it("conservatively overcounts only when the count/chunk invariant is already broken", () => {
    const chunks = splitReceiptFold(directFold({ count: 1, inputTokens: 200_000_000 }));

    expect(chunks.map(({ count }) => count)).toEqual([1, 1]);
    expect(chunks.reduce((total, chunk) => total + Number(chunk.count), 0)).toBeGreaterThanOrEqual(
      1,
    );
    expect(chunks.reduce((total, chunk) => total + Number(chunk.inputTokens), 0)).toBe(200_000_000);
  });

  it("normalizes a zero count in the one-chunk path before schema validation", () => {
    const state = new ReceiptFoldState();
    state.fold(deniedEvent());
    const { key } = onlyEntry(state);

    const [replay] = buildReceiptReplayEvents(key, directFold({ count: 0 }), "sdk-zero-count");

    expect(replay?.receipt_aggregate_count).toBe(1);
    expect(MetadataEventSchema.safeParse(replay).success).toBe(true);
  });

  it.each([
    ["image_count", "imageCount", 75_000_000] as const,
    ["generation_count", "generationCount", 75_000_000] as const,
    ["video_seconds", "videoSeconds", 75_000_000.25] as const,
    ["audio_seconds", "audioSeconds", 75_000_000.25] as const,
    ["input_characters", "inputCharacters", 75_000_000] as const,
  ])("preserves %s presence, fractions, and pricing basis through split/refold", (wireField, foldField, quantity) => {
    const state = new ReceiptFoldState();
    for (let index = 0; index < 3; index += 1) {
      state.fold(
        deniedEvent({
          input_tokens: 150_000,
          media_usage: { [wireField]: quantity } as MediaUsage,
        }),
      );
    }
    const original = onlyEntry(state);

    const chunks = buildReceiptReplayEvents(original.key, original.fold, "sdk-media");

    expect(chunks).toHaveLength(3);
    expect(chunks.map((event) => event.receipt_pricing_input_tokens)).toEqual([
      150_000, 150_000, 150_000,
    ]);
    expect(chunks.map((event) => event.media_usage?.[wireField])).toEqual([
      100_000_000,
      100_000_000,
      quantity * 3 - 200_000_000,
    ]);
    for (const event of chunks) {
      const presentQuantityKeys = Object.keys(event.media_usage ?? {}).filter(
        (field) =>
          field.endsWith("_count") || field.endsWith("_seconds") || field === "input_characters",
      );
      expect(presentQuantityKeys).toEqual([wireField]);
    }

    const refolded = new ReceiptFoldState();
    for (const chunk of chunks) refolded.fold(chunk);
    const replayed = onlyEntry(refolded);
    expect(replayed.key.receiptPricingInputTokens).toBe(150_000);
    expect(replayed.fold[foldField]).toBe(quantity * 3);
  });

  it("keeps a coarse replay coarse and preserves explicit-zero media on the wire", () => {
    const state = new ReceiptFoldState();
    for (let inputTokens = 1; inputTokens <= 33; inputTokens += 1) {
      state.fold(deniedEvent({ input_tokens: inputTokens, media_usage: { image_count: 0 } }));
    }
    const coarse = state.snapshot().find(({ key }) => key.receiptPricingInputTokens === null);
    if (coarse === undefined) throw new Error("missing coarse fold fixture");

    const [replay] = buildReceiptReplayEvents(coarse.key, coarse.fold, "sdk-coarse");
    if (replay === undefined) throw new Error("missing coarse replay fixture");
    expect(Object.hasOwn(replay, "receipt_pricing_input_tokens")).toBe(false);
    expect(replay.media_usage?.image_count).toBe(0);

    const refolded = new ReceiptFoldState();
    refolded.fold(replay);
    expect(onlyEntry(refolded).key.receiptPricingInputTokens).toBeNull();
  });
});

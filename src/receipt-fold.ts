/**
 * Sans-I/O denial-receipt aggregation owned by the metadata reporter.
 *
 * This module is deliberately edge-safe and content-blind. It reads only the
 * structural accounting dimensions present on MetadataEvent.
 */

import { createEventTimestampAllocator } from "./event-timestamp";
import type { MediaUsage, MetadataEvent, Modality, ProviderName, VelocityFlag } from "./types";
import { MediaUsageSchema, MetadataEventSchema } from "./validation";

export const RECEIPT_FOLD_LIMIT = 256;
export const RECEIPT_FOLD_RUN_EXACT_LIMIT = 32;
export const ORDINARY_TOKEN_COUNT_MAX = 100_000_000;
export const SIGNED_BIGINT_MAX = (1n << 63n) - 1n;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const ORDINARY_TOKEN_COUNT_MAX_BIGINT = BigInt(ORDINARY_TOKEN_COUNT_MAX);
const nextStandaloneReplayTimestamp = createEventTimestampAllocator();

export type ReceiptFoldOutcome = "not_denied" | "folded" | "overflow" | "terminal";

/** A discrete total stays a number while safe and promotes to bigint before precision can round. */
export type ExactInteger = number | bigint;

/** The exact 19-field pricing-compatible identity of one aggregate. */
export interface ReceiptFoldKey {
  readonly runId: string;
  readonly originalSource: string;
  readonly denyReason: string;
  readonly deniedByPeriod: string;
  readonly model: string;
  readonly provider: ProviderName;
  readonly providerRegion: string | null;
  readonly serviceTier: string | null;
  readonly modality: Modality;
  readonly receiptPricingInputTokens: number | null;
  readonly hasMediaUsage: boolean;
  readonly hasImageCount: boolean;
  readonly hasGenerationCount: boolean;
  readonly hasVideoSeconds: boolean;
  readonly hasAudioSeconds: boolean;
  readonly hasInputCharacters: boolean;
  readonly mediaResolution: string | null;
  readonly mediaQuality: string | null;
  readonly mediaIsEstimated: boolean;
}

/** Exact in-memory quantities and content-blind diagnostics retained for a key. */
export interface ReceiptFold {
  count: ExactInteger;
  inputTokens: ExactInteger;
  outputTokens: ExactInteger;
  estimatedOutputBound: ExactInteger;
  velocityFlags: Set<VelocityFlag>;
  imageCount: ExactInteger | null;
  generationCount: ExactInteger | null;
  videoSeconds: number | null;
  audioSeconds: number | null;
  inputCharacters: ExactInteger | null;
  firstTimestamp: string;
  lastTimestamp: string;
  model: string;
  provider: ProviderName;
}

export interface ReceiptFoldEntry {
  readonly key: ReceiptFoldKey;
  readonly fold: ReceiptFold;
}

interface StoredFold {
  key: ReceiptFoldKey;
  fold: ReceiptFold;
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("receipt fold quantities must be finite numbers");
  }
  return value;
}

function nonnegativeInteger(value: unknown): number {
  return Math.max(0, Math.trunc(finiteNumber(value)));
}

function nonnegativeQuantity(value: unknown): number {
  return Math.max(0, finiteNumber(value));
}

function optionalQuantity(value: unknown): number | null {
  return isPresent(value) ? nonnegativeQuantity(value) : null;
}

function optionalInteger(value: unknown): ExactInteger | null {
  return isPresent(value) ? nonnegativeInteger(value) : null;
}

function exactIntegerBigInt(value: ExactInteger): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function compactExactInteger(value: bigint): ExactInteger {
  return value <= MAX_SAFE_INTEGER_BIGINT ? Number(value) : value;
}

function addExactIntegers(left: ExactInteger, right: ExactInteger): ExactInteger {
  return compactExactInteger(exactIntegerBigInt(left) + exactIntegerBigInt(right));
}

function normalizeTimestamp(timestamp: string): string {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp);
  const parsed = new Date(hasZone ? timestamp : `${timestamp}Z`);
  return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toISOString();
}

function foldKeyId(key: ReceiptFoldKey): string {
  return JSON.stringify([
    key.runId,
    key.originalSource,
    key.denyReason,
    key.deniedByPeriod,
    key.model,
    key.provider,
    key.providerRegion,
    key.serviceTier,
    key.modality,
    key.receiptPricingInputTokens,
    key.hasMediaUsage,
    key.hasImageCount,
    key.hasGenerationCount,
    key.hasVideoSeconds,
    key.hasAudioSeconds,
    key.hasInputCharacters,
    key.mediaResolution,
    key.mediaQuality,
    key.mediaIsEstimated,
  ]);
}

function exactKey(event: MetadataEvent): ReceiptFoldKey {
  const media = event.media_usage;
  const hasMediaUsage = isPresent(media);
  const aggregate = isPresent(event.receipt_aggregate_count);
  const receiptPricingInputTokens = aggregate
    ? isPresent(event.receipt_pricing_input_tokens)
      ? nonnegativeInteger(event.receipt_pricing_input_tokens)
      : null
    : nonnegativeInteger(event.input_tokens);
  if (receiptPricingInputTokens !== null) {
    MetadataEventSchema.shape.receipt_pricing_input_tokens.parse(receiptPricingInputTokens);
  }
  return {
    runId: MetadataEventSchema.shape.agent_run_id.parse(event.agent_run_id) ?? "",
    originalSource: event.deny_source ?? "",
    denyReason: MetadataEventSchema.shape.deny_reason.parse(event.deny_reason) ?? "",
    deniedByPeriod: MetadataEventSchema.shape.denied_by_period.parse(event.denied_by_period) ?? "",
    model: MetadataEventSchema.shape.model.parse(event.model),
    provider: MetadataEventSchema.shape.provider.parse(event.provider),
    providerRegion: MetadataEventSchema.shape.provider_region.parse(event.provider_region) ?? null,
    serviceTier: MetadataEventSchema.shape.service_tier.parse(event.service_tier) ?? null,
    modality: MetadataEventSchema.shape.modality.parse(event.modality),
    receiptPricingInputTokens,
    hasMediaUsage,
    hasImageCount: hasMediaUsage && isPresent(media?.image_count),
    hasGenerationCount: hasMediaUsage && isPresent(media?.generation_count),
    hasVideoSeconds: hasMediaUsage && isPresent(media?.video_seconds),
    hasAudioSeconds: hasMediaUsage && isPresent(media?.audio_seconds),
    hasInputCharacters: hasMediaUsage && isPresent(media?.input_characters),
    mediaResolution: hasMediaUsage
      ? (MediaUsageSchema.shape.resolution.parse(media?.resolution) ?? null)
      : null,
    mediaQuality: hasMediaUsage
      ? (MediaUsageSchema.shape.quality.parse(media?.quality) ?? null)
      : null,
    mediaIsEstimated: hasMediaUsage
      ? MediaUsageSchema.shape.is_estimated.parse(media?.is_estimated)
      : false,
  };
}

function contribution(event: MetadataEvent, key: ReceiptFoldKey): ReceiptFold {
  const media = event.media_usage;
  const timestamp = normalizeTimestamp(event.timestamp);
  const uniqueVelocityFlags = Array.isArray(event.velocity_flags)
    ? [...new Set(event.velocity_flags)]
    : event.velocity_flags;
  const velocityFlags = MetadataEventSchema.shape.velocity_flags.parse(uniqueVelocityFlags) ?? [];
  return {
    count: isPresent(event.receipt_aggregate_count)
      ? Math.max(1, nonnegativeInteger(event.receipt_aggregate_count))
      : 1,
    inputTokens: nonnegativeInteger(event.input_tokens),
    outputTokens: nonnegativeInteger(event.output_tokens),
    estimatedOutputBound: nonnegativeInteger(event.estimated_output_bound ?? 0),
    velocityFlags: new Set(velocityFlags),
    imageCount: optionalInteger(media?.image_count),
    generationCount: optionalInteger(media?.generation_count),
    videoSeconds: optionalQuantity(media?.video_seconds),
    audioSeconds: optionalQuantity(media?.audio_seconds),
    inputCharacters: optionalInteger(media?.input_characters),
    firstTimestamp: timestamp,
    lastTimestamp: timestamp,
    model: key.model,
    provider: key.provider,
  };
}

function cloneFold(fold: ReceiptFold): ReceiptFold {
  return { ...fold, velocityFlags: new Set(fold.velocityFlags) };
}

function cloneKey(key: ReceiptFoldKey): ReceiptFoldKey {
  return { ...key };
}

function coarseKey(key: ReceiptFoldKey): ReceiptFoldKey {
  return { ...key, receiptPricingInputTokens: null };
}

function addOptionalQuantity(existing: number | null, incoming: number | null): number | null {
  return incoming === null ? existing : (existing ?? 0) + incoming;
}

function addOptionalInteger(
  existing: ExactInteger | null,
  incoming: ExactInteger | null,
): ExactInteger | null {
  return incoming === null ? existing : addExactIntegers(existing ?? 0, incoming);
}

function accumulate(fold: ReceiptFold, incoming: ReceiptFold): void {
  fold.count = addExactIntegers(fold.count, incoming.count);
  fold.inputTokens = addExactIntegers(fold.inputTokens, incoming.inputTokens);
  fold.outputTokens = addExactIntegers(fold.outputTokens, incoming.outputTokens);
  fold.estimatedOutputBound = addExactIntegers(
    fold.estimatedOutputBound,
    incoming.estimatedOutputBound,
  );
  for (const flag of incoming.velocityFlags) fold.velocityFlags.add(flag);
  fold.imageCount = addOptionalInteger(fold.imageCount, incoming.imageCount);
  fold.generationCount = addOptionalInteger(fold.generationCount, incoming.generationCount);
  fold.videoSeconds = addOptionalQuantity(fold.videoSeconds, incoming.videoSeconds);
  fold.audioSeconds = addOptionalQuantity(fold.audioSeconds, incoming.audioSeconds);
  fold.inputCharacters = addOptionalInteger(fold.inputCharacters, incoming.inputCharacters);
  if (incoming.firstTimestamp < fold.firstTimestamp) fold.firstTimestamp = incoming.firstTimestamp;
  if (incoming.lastTimestamp > fold.lastTimestamp) fold.lastTimestamp = incoming.lastTimestamp;
}

export class ReceiptFoldState {
  readonly #folds = new Map<string, StoredFold>();
  readonly #runExactKeys = new Map<string, number>();
  #previousCycleSucceeded = false;
  #terminal = false;

  fold(event: MetadataEvent): ReceiptFoldOutcome {
    if (event.status !== "budget_denied") return "not_denied";
    if (this.#terminal) return "terminal";

    let key = exactKey(event);
    let id = foldKeyId(key);
    const incoming = contribution(event, key);
    let existing = this.#folds.get(id);
    if (existing !== undefined) {
      accumulate(existing.fold, incoming);
      return "folded";
    }

    if (
      key.receiptPricingInputTokens !== null &&
      ((this.#runExactKeys.get(key.runId) ?? 0) >= RECEIPT_FOLD_RUN_EXACT_LIMIT ||
        this.#folds.size >= RECEIPT_FOLD_LIMIT)
    ) {
      key = coarseKey(key);
      id = foldKeyId(key);
      existing = this.#folds.get(id);
      if (existing !== undefined) {
        accumulate(existing.fold, incoming);
        return "folded";
      }
    }

    if (this.#folds.size >= RECEIPT_FOLD_LIMIT) return "overflow";

    this.#folds.set(id, { key, fold: incoming });
    if (key.receiptPricingInputTokens !== null) {
      this.#runExactKeys.set(key.runId, (this.#runExactKeys.get(key.runId) ?? 0) + 1);
    }
    return "folded";
  }

  snapshot(): ReceiptFoldEntry[] {
    return [...this.#folds.values()].map(({ key, fold }) => ({
      key: cloneKey(key),
      fold: cloneFold(fold),
    }));
  }

  /** Open a one-shot recovery gate after a fully clean ingest cycle. */
  noteCycleSuccess(): void {
    if (!this.#terminal) this.#previousCycleSucceeded = true;
  }

  /**
   * Transfer ownership of every retained aggregate.
   *
   * A normal take requires proof from the preceding cycle. A final take is
   * unconditional and permanently seals the state before ownership moves.
   */
  takeForCycle(options: { readonly final: boolean }): ReceiptFoldEntry[] {
    if (options.final) this.#terminal = true;
    const shouldTake = options.final || this.#previousCycleSucceeded;
    this.#previousCycleSucceeded = false;
    if (!shouldTake || this.#folds.size === 0) return [];

    const taken = this.snapshot();
    this.#folds.clear();
    this.#runExactKeys.clear();
    return taken;
  }
}

function splitChunkCount(fold: ReceiptFold): number {
  const discreteQuantities = [
    fold.count,
    fold.inputTokens,
    fold.outputTokens,
    fold.estimatedOutputBound,
    fold.imageCount,
    fold.generationCount,
    fold.inputCharacters,
  ];
  let chunkCount = 1;
  for (const quantity of discreteQuantities) {
    if (quantity !== null) {
      const exact = exactIntegerBigInt(quantity);
      const chunks =
        exact <= 0n
          ? 1n
          : (exact + ORDINARY_TOKEN_COUNT_MAX_BIGINT - 1n) / ORDINARY_TOKEN_COUNT_MAX_BIGINT;
      chunkCount = Math.max(chunkCount, Number(chunks));
    }
  }
  for (const quantity of [fold.videoSeconds, fold.audioSeconds]) {
    if (quantity !== null) {
      chunkCount = Math.max(chunkCount, Math.ceil(quantity / ORDINARY_TOKEN_COUNT_MAX));
    }
  }
  return chunkCount;
}

function takeWireInteger(remaining: bigint | null): readonly [number | null, bigint | null] {
  if (remaining === null) return [null, null];
  const chunk =
    remaining <= 0n
      ? 0n
      : remaining < ORDINARY_TOKEN_COUNT_MAX_BIGINT
        ? remaining
        : ORDINARY_TOKEN_COUNT_MAX_BIGINT;
  return [Number(chunk), remaining - chunk];
}

function takeWireQuantity(remaining: number | null): readonly [number | null, number | null] {
  if (remaining === null) return [null, null];
  const chunk = Math.min(ORDINARY_TOKEN_COUNT_MAX, Math.max(0, remaining));
  return [chunk, Math.max(0, remaining - chunk)];
}

/** Split one exact in-memory aggregate into individually wire-safe chunks. */
export function splitReceiptFold(fold: ReceiptFold): ReceiptFold[] {
  const chunkCount = splitChunkCount(fold);
  if (chunkCount === 1) {
    const chunk = cloneFold(fold);
    if (exactIntegerBigInt(chunk.count) < 1n) chunk.count = 1;
    return [chunk];
  }

  let remainingCount = exactIntegerBigInt(fold.count);
  let remainingInputTokens = exactIntegerBigInt(fold.inputTokens);
  let remainingOutputTokens = exactIntegerBigInt(fold.outputTokens);
  let remainingEstimatedOutputBound = exactIntegerBigInt(fold.estimatedOutputBound);
  let remainingImageCount = fold.imageCount === null ? null : exactIntegerBigInt(fold.imageCount);
  let remainingGenerationCount =
    fold.generationCount === null ? null : exactIntegerBigInt(fold.generationCount);
  let remainingVideoSeconds = fold.videoSeconds;
  let remainingAudioSeconds = fold.audioSeconds;
  let remainingInputCharacters =
    fold.inputCharacters === null ? null : exactIntegerBigInt(fold.inputCharacters);
  const chunks: ReceiptFold[] = [];

  for (let index = 0; index < chunkCount; index += 1) {
    const chunksLeft = chunkCount - index;
    const reservedCount = remainingCount - BigInt(chunksLeft - 1);
    const countBigInt =
      reservedCount <= 1n
        ? 1n
        : reservedCount < ORDINARY_TOKEN_COUNT_MAX_BIGINT
          ? reservedCount
          : ORDINARY_TOKEN_COUNT_MAX_BIGINT;
    const count = Number(countBigInt);
    remainingCount -= countBigInt;

    const [inputTokens, nextInputTokens] = takeWireInteger(remainingInputTokens);
    const [outputTokens, nextOutputTokens] = takeWireInteger(remainingOutputTokens);
    const [estimatedOutputBound, nextEstimatedOutputBound] = takeWireInteger(
      remainingEstimatedOutputBound,
    );
    const [imageCount, nextImageCount] = takeWireInteger(remainingImageCount);
    const [generationCount, nextGenerationCount] = takeWireInteger(remainingGenerationCount);
    const [videoSeconds, nextVideoSeconds] = takeWireQuantity(remainingVideoSeconds);
    const [audioSeconds, nextAudioSeconds] = takeWireQuantity(remainingAudioSeconds);
    const [inputCharacters, nextInputCharacters] = takeWireInteger(remainingInputCharacters);

    chunks.push({
      ...fold,
      count,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      estimatedOutputBound: estimatedOutputBound ?? 0,
      velocityFlags: new Set(fold.velocityFlags),
      imageCount,
      generationCount,
      videoSeconds,
      audioSeconds,
      inputCharacters,
    });

    remainingInputTokens = nextInputTokens ?? 0n;
    remainingOutputTokens = nextOutputTokens ?? 0n;
    remainingEstimatedOutputBound = nextEstimatedOutputBound ?? 0n;
    remainingImageCount = nextImageCount;
    remainingGenerationCount = nextGenerationCount;
    remainingVideoSeconds = nextVideoSeconds;
    remainingAudioSeconds = nextAudioSeconds;
    remainingInputCharacters = nextInputCharacters;
  }

  return chunks;
}

function receiptReplayMedia(key: ReceiptFoldKey, fold: ReceiptFold): MediaUsage | undefined {
  if (!key.hasMediaUsage) return undefined;

  const media: MediaUsage = { is_estimated: key.mediaIsEstimated };
  if (key.hasImageCount) media.image_count = Number(fold.imageCount ?? 0);
  if (key.hasGenerationCount) media.generation_count = Number(fold.generationCount ?? 0);
  if (key.hasVideoSeconds) media.video_seconds = fold.videoSeconds ?? 0;
  if (key.hasAudioSeconds) media.audio_seconds = fold.audioSeconds ?? 0;
  if (key.hasInputCharacters) media.input_characters = Number(fold.inputCharacters ?? 0);
  if (key.mediaResolution !== null) media.resolution = key.mediaResolution;
  if (key.mediaQuality !== null) media.quality = key.mediaQuality;
  return media;
}

/** Build one fresh aggregate replay event from one already wire-safe chunk. */
export function buildReceiptReplayEvent(
  key: ReceiptFoldKey,
  fold: ReceiptFold,
  sdkInstanceId?: string | null,
  nextTimestamp: () => string = nextStandaloneReplayTimestamp,
): MetadataEvent {
  const event: MetadataEvent = {
    model: key.model,
    provider: key.provider,
    modality: key.modality,
    input_tokens: Number(fold.inputTokens),
    output_tokens: Number(fold.outputTokens),
    latency_ms: 0,
    status: "budget_denied",
    is_model_fallback: false,
    is_provider_fallback: false,
    attempt_index: 0,
    call_id: crypto.randomUUID(),
    sdk_instance_id: sdkInstanceId ?? "receipt-fold",
    timestamp: nextTimestamp(),
    deny_source: "aggregate_replay",
    estimated_output_bound: Number(fold.estimatedOutputBound),
    receipt_aggregate_count: Number(fold.count),
  };

  const media = receiptReplayMedia(key, fold);
  if (media !== undefined) event.media_usage = media;
  if (key.providerRegion !== null) event.provider_region = key.providerRegion;
  if (key.serviceTier !== null) event.service_tier = key.serviceTier;
  if (key.runId !== "") event.agent_run_id = key.runId;
  if (key.denyReason !== "") event.deny_reason = key.denyReason;
  if (key.deniedByPeriod !== "") event.denied_by_period = key.deniedByPeriod;
  if (fold.velocityFlags.size > 0) event.velocity_flags = [...fold.velocityFlags].sort();
  if (key.receiptPricingInputTokens !== null) {
    event.receipt_pricing_input_tokens = key.receiptPricingInputTokens;
  }
  return event;
}

/** Split an aggregate and mint one fresh replay event for every chunk. */
export function buildReceiptReplayEvents(
  key: ReceiptFoldKey,
  fold: ReceiptFold,
  sdkInstanceId?: string | null,
  nextTimestamp?: () => string,
): MetadataEvent[] {
  return splitReceiptFold(fold).map((chunk) =>
    buildReceiptReplayEvent(key, chunk, sdkInstanceId, nextTimestamp),
  );
}

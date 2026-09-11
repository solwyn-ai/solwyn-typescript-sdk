import { safeExceptionType } from "../error-diagnostics";
import { createTokenDetails } from "../token-details";
import type { FetchLike } from "../transport";
import type {
  BudgetCheckRequest,
  BudgetConfirmRequest,
  LeaseGrantRequest,
  LeaseGrantResponse,
  LeaseRenewRequest,
  LeaseSurrenderRequest,
  MetadataEvent,
} from "../types";
import {
  BudgetCheckRequestSchema,
  BudgetCheckResponseSchema,
  BudgetConfirmRequestSchema,
  IngestResponseSchema,
  LeaseGrantRequestSchema,
  LeaseGrantResponseSchema,
  LeaseRenewRequestSchema,
  LeaseSurrenderRequestSchema,
  LeaseSurrenderResponseSchema,
  MetadataEventSchema,
  serializeBudgetConfirmRequest,
  serializeLeaseGrantRequest,
  serializeLeaseRenewRequest,
  serializeLeaseSurrenderRequest,
  serializeMetadataEvent,
} from "../validation";

const CHECK_PATH = "/api/v1/budgets/check";
const CONFIRM_PATH = "/api/v1/budgets/confirm";
const LEASE_PATH = "/api/v1/budgets/lease";
const LEASE_RENEW_PATH = "/api/v1/budgets/lease/renew";
const LEASE_SURRENDER_PATH = "/api/v1/budgets/lease/surrender";
const INGEST_PATH = "/api/v1/metadata/ingest";
const LEASE_AUTHORITY_KEYS = [
  "lease_id",
  "generation",
  "granted_tokens",
  "refresh_interval_s",
  "lease_length_s",
  "headroom_share_tokens",
  "posture",
  "final_grant",
] as const;

export interface ContractOptions {
  apiUrl: string;
  apiKey: string;
}

export interface RunControlContractOptions extends ContractOptions {
  stoppedRunId: string;
}

interface Exchange {
  readonly response: Response;
  readonly text: string;
}

type JsonRecord = Record<string, unknown>;

function bodyPreview(text: string): string {
  const bytes = new TextEncoder().encode(text).slice(0, 200);
  return JSON.stringify(new TextDecoder().decode(bytes));
}

function fail(phase: string, message: string, text: string): never {
  throw new Error(`[${phase}] ${message}; body preview=${bodyPreview(text)}`);
}

async function postJson(
  fetch: FetchLike,
  options: ContractOptions,
  path: string,
  body: unknown,
  phase: string,
): Promise<Exchange> {
  let response: Response;
  try {
    response = await fetch(new URL(path, options.apiUrl).toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`[${phase}] request failed (${safeExceptionType(error)})`);
  }
  try {
    return { response, text: await response.text() };
  } catch (error) {
    throw new Error(`[${phase}] response body read failed (${safeExceptionType(error)})`);
  }
}

function requireStatus(exchange: Exchange, expected: number, phase: string): void {
  if (exchange.response.status !== expected) {
    fail(phase, `expected HTTP ${expected}, received ${exchange.response.status}`, exchange.text);
  }
}

function requireEmpty(exchange: Exchange, phase: string): void {
  if (exchange.text !== "") fail(phase, "expected an empty response body", exchange.text);
}

function parseJson(exchange: Exchange, phase: string): unknown {
  try {
    return JSON.parse(exchange.text) as unknown;
  } catch {
    fail(phase, "response body is not valid JSON", exchange.text);
  }
}

function requireRecord(
  value: unknown,
  phase: string,
  text: string,
  label = "response",
): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(phase, `${label} must be a JSON object`, text);
  }
  return value as JsonRecord;
}

function requireExactKeys(
  value: JsonRecord,
  keys: readonly string[],
  phase: string,
  text: string,
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(phase, `${label} must have exactly keys ${expected.join(", ")}`, text);
  }
}

function requireBoolean(value: unknown, phase: string, text: string, label: string): boolean {
  if (typeof value !== "boolean") fail(phase, `${label} must be a boolean`, text);
  return value;
}

function requireString(value: unknown, phase: string, text: string, label: string): string {
  if (typeof value !== "string") fail(phase, `${label} must be a string`, text);
  return value;
}

function requireFiniteNumber(value: unknown, phase: string, text: string, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(phase, `${label} must be a finite JSON number`, text);
  }
  return value;
}

function requirePositiveInteger(
  value: unknown,
  phase: string,
  text: string,
  label: string,
): number {
  const number = requireFiniteNumber(value, phase, text, label);
  if (!Number.isInteger(number) || number <= 0) {
    fail(phase, `${label} must be a positive integer`, text);
  }
  return number;
}

function requireSchema(
  schema: { safeParse(value: unknown): { success: boolean } },
  value: unknown,
  phase: string,
  text: string,
): void {
  if (!schema.safeParse(value).success) fail(phase, "response schema mismatch", text);
}

function checkPayload(overrides: Partial<BudgetCheckRequest> = {}): Record<string, unknown> {
  return BudgetCheckRequestSchema.parse({
    estimated_input_tokens: 1000,
    model: "gpt-5.5",
    provider: "openai",
    failover_directive_version: "1",
    price_hints_version: "1",
    ...overrides,
  });
}

function requireDisplay(body: JsonRecord, phase: string, text: string): void {
  requireString(body["project_id"], phase, text, "project_id");
  if (body["mode"] !== "alert_only" && body["mode"] !== "hard_deny") {
    fail(phase, "mode must be alert_only or hard_deny", text);
  }
  for (const key of ["budget_limit", "current_usage", "remaining_budget"] as const) {
    requireFiniteNumber(body[key], phase, text, key);
  }
}

function requireFailoverDirective(body: JsonRecord, phase: string, text: string): void {
  const directive = requireRecord(body["failover_directive"], phase, text, "failover_directive");
  requireExactKeys(
    directive,
    ["version", "failover_tuning_allowed"],
    phase,
    text,
    "failover_directive",
  );
  if (directive["version"] !== "1") fail(phase, "failover directive version must be 1", text);
  requireBoolean(
    directive["failover_tuning_allowed"],
    phase,
    text,
    "failover_directive.failover_tuning_allowed",
  );
}

function requirePriceHints(body: JsonRecord, phase: string, text: string): void {
  const hints = body["price_hints"];
  if (hints === undefined || hints === null) return;
  const record = requireRecord(hints, phase, text, "price_hints");
  for (const value of Object.values(record)) {
    requireFiniteNumber(value, phase, text, "price_hints value");
  }
}

function requireCheckResponse(
  exchange: Exchange,
  phase: string,
  expected: { readonly allowed: boolean; readonly deniedByPeriod?: string },
): JsonRecord {
  requireStatus(exchange, 200, phase);
  const body = requireRecord(parseJson(exchange, phase), phase, exchange.text);
  if (body["allowed"] !== expected.allowed) {
    fail(phase, `allowed must be ${expected.allowed}`, exchange.text);
  }
  requireDisplay(body, phase, exchange.text);
  requireFailoverDirective(body, phase, exchange.text);
  requirePriceHints(body, phase, exchange.text);

  if (expected.allowed) {
    const reservationId = requireString(
      body["reservation_id"],
      phase,
      exchange.text,
      "reservation_id",
    );
    if (reservationId.length === 0) fail(phase, "reservation_id must not be empty", exchange.text);
    if (Object.hasOwn(body, "denied_by_period")) {
      fail(phase, "denied_by_period must be omitted for an allow", exchange.text);
    }
  } else {
    if (body["denied_by_period"] !== expected.deniedByPeriod) {
      fail(phase, `denied_by_period must be ${expected.deniedByPeriod}`, exchange.text);
    }
    if (body["mode"] !== "hard_deny") fail(phase, "denial mode must be hard_deny", exchange.text);
    if (Object.hasOwn(body, "reservation_id")) {
      fail(phase, "reservation_id must be omitted for a denial", exchange.text);
    }
  }
  requireSchema(BudgetCheckResponseSchema, body, phase, exchange.text);
  return body;
}

async function check(
  fetch: FetchLike,
  options: ContractOptions,
  phase: string,
  payload: Record<string, unknown>,
  expected: { readonly allowed: boolean; readonly deniedByPeriod?: string },
): Promise<JsonRecord> {
  const exchange = await postJson(fetch, options, CHECK_PATH, payload, phase);
  return requireCheckResponse(exchange, phase, expected);
}

export async function assertCheckContract(
  fetch: FetchLike,
  options: ContractOptions,
): Promise<void> {
  await check(
    fetch,
    options,
    "check.monthly",
    checkPayload({ tags: { contract_case: "monthly" } }),
    { allowed: false, deniedByPeriod: "monthly" },
  );
  await check(
    fetch,
    options,
    "check.run-stopped",
    checkPayload({ agent_run_id: "contract-stopped-run" }),
    { allowed: false, deniedByPeriod: "run_stopped" },
  );
  await check(fetch, options, "check.tag", checkPayload({ tags: { customer: "acme" } }), {
    allowed: false,
    deniedByPeriod: "tag",
  });
  await check(
    fetch,
    options,
    "check.agent-run",
    checkPayload({ agent_run_id: "contract-agent-run" }),
    { allowed: false, deniedByPeriod: "agent_run" },
  );
  await check(fetch, options, "check.allow", checkPayload(), { allowed: true });
}

function confirmPayload(
  settlement: { readonly reservation_id: string } | { readonly lease_id: string },
  callId: string,
): Record<string, unknown> {
  const parsed: BudgetConfirmRequest = BudgetConfirmRequestSchema.parse({
    ...settlement,
    model: "gpt-5.5",
    provider: "openai",
    is_provider_fallback: false,
    call_id: callId,
    token_details: createTokenDetails({ input_tokens: 1000, output_tokens: 500 }),
  });
  return serializeBudgetConfirmRequest(parsed);
}

async function requireEmptyStatus(
  fetch: FetchLike,
  options: ContractOptions,
  body: unknown,
  phase: string,
  expectedStatus: number,
): Promise<void> {
  const exchange = await postJson(fetch, options, CONFIRM_PATH, body, phase);
  requireStatus(exchange, expectedStatus, phase);
  if (expectedStatus === 204) requireEmpty(exchange, phase);
}

export async function assertConfirmContract(
  fetch: FetchLike,
  options: ContractOptions,
): Promise<void> {
  const setupPhase = "confirm.setup";
  const setup = await postJson(fetch, options, CHECK_PATH, checkPayload(), setupPhase);
  requireStatus(setup, 200, setupPhase);
  const setupBody = requireRecord(parseJson(setup, setupPhase), setupPhase, setup.text);
  requireSchema(BudgetCheckResponseSchema, setupBody, setupPhase, setup.text);
  if (setupBody["allowed"] !== true) fail(setupPhase, "setup check must allow", setup.text);
  const reservationId = requireString(
    setupBody["reservation_id"],
    setupPhase,
    setup.text,
    "reservation_id",
  );
  if (reservationId.length === 0) fail(setupPhase, "reservation_id must not be empty", setup.text);

  const valid = confirmPayload({ reservation_id: reservationId }, crypto.randomUUID());
  if (Object.hasOwn(valid, "lease_id")) {
    fail("confirm.valid", "reservation serializer must omit lease_id", "");
  }
  await requireEmptyStatus(fetch, options, valid, "confirm.valid", 204);
  await requireEmptyStatus(fetch, options, valid, "confirm.replay", 204);
  await requireEmptyStatus(
    fetch,
    options,
    { ...valid, call_id: crypto.randomUUID() },
    "confirm.settled-replay",
    204,
  );

  await requireEmptyStatus(
    fetch,
    options,
    { ...valid, lease_id: "lse_contract" },
    "confirm.both-keys",
    422,
  );
  const { reservation_id: _reservationId, ...neither } = valid;
  await requireEmptyStatus(
    fetch,
    options,
    { ...neither, call_id: crypto.randomUUID() },
    "confirm.neither-key",
    422,
  );

  const unknownPhase = "confirm.unknown-reservation";
  const unknown = await postJson(
    fetch,
    options,
    CONFIRM_PATH,
    confirmPayload({ reservation_id: "res_contract_unknown" }, crypto.randomUUID()),
    unknownPhase,
  );
  requireStatus(unknown, 404, unknownPhase);
  const unknownBody = requireRecord(parseJson(unknown, unknownPhase), unknownPhase, unknown.text);
  if (unknownBody["detail"] !== "Reservation not found or expired") {
    fail(unknownPhase, "unexpected reservation-not-found detail", unknown.text);
  }
}

function leaseGrantPayload(
  agentRunId: string,
  holderId: string,
  model = "gpt-5.5",
): Record<string, unknown> {
  const parsed: LeaseGrantRequest = LeaseGrantRequestSchema.parse({
    agent_run_id: agentRunId,
    holder_id: holderId,
    model,
    provider: "openai",
    fail_open: true,
    estimated_input_tokens: 1000,
  });
  return serializeLeaseGrantRequest(parsed);
}

function leaseRenewPayload(
  leaseId: string,
  holderId: string,
  generation: number,
): Record<string, unknown> {
  const parsed: LeaseRenewRequest = LeaseRenewRequestSchema.parse({
    lease_id: leaseId,
    holder_id: holderId,
    generation,
    spent_tokens: 0,
    reserved_tokens: 0,
    uncounted_calls: 0,
    uncounted_tokens: 0,
  });
  return serializeLeaseRenewRequest(parsed);
}

function renewalPayloadForAcceptedAuthority(
  leaseId: string,
  holderId: string,
): Record<string, unknown> {
  const parsed = LeaseRenewRequestSchema.safeParse({
    lease_id: leaseId,
    holder_id: holderId,
    generation: 1,
    spent_tokens: 0,
    reserved_tokens: 0,
    uncounted_calls: 0,
    uncounted_tokens: 0,
  });
  if (!parsed.success) {
    fail(
      "lease.renew-request",
      "accepted response lease_id cannot be represented by the renewal request schema",
      "",
    );
  }
  return serializeLeaseRenewRequest(parsed.data);
}

function leaseSurrenderPayload(
  leaseId: string,
  holderId: string,
  generation: number,
): Record<string, unknown> {
  const parsed: LeaseSurrenderRequest = LeaseSurrenderRequestSchema.parse({
    lease_id: leaseId,
    holder_id: holderId,
    generation,
    spent_tokens: 0,
  });
  return serializeLeaseSurrenderRequest(parsed);
}

async function postLease(
  fetch: FetchLike,
  options: ContractOptions,
  path: string,
  body: unknown,
  phase: string,
  status = 200,
): Promise<{ readonly exchange: Exchange; readonly body: JsonRecord }> {
  const exchange = await postJson(fetch, options, path, body, phase);
  requireStatus(exchange, status, phase);
  return {
    exchange,
    body: requireRecord(parseJson(exchange, phase), phase, exchange.text),
  };
}

function requireLeaseError(
  body: JsonRecord,
  code: string,
  message: string,
  phase: string,
  text: string,
): void {
  const detail = requireRecord(body["detail"], phase, text, "detail");
  requireExactKeys(detail, ["code", "message"], phase, text, "detail");
  if (detail["code"] !== code) fail(phase, `detail.code must be ${code}`, text);
  if (detail["message"] !== message) fail(phase, "unexpected lease error message", text);
}

function requireLeaseDisplay(body: JsonRecord, phase: string, text: string): void {
  requireDisplay(body, phase, text);
  requireSchema(LeaseGrantResponseSchema, body, phase, text);
}

function requireNoLeaseAuthority(body: JsonRecord, phase: string, text: string): void {
  for (const key of LEASE_AUTHORITY_KEYS) {
    if (Object.hasOwn(body, key)) fail(phase, `${key} must be omitted`, text);
  }
}

function requireLeaseAuthority(
  body: JsonRecord,
  phase: string,
  text: string,
  generation: number,
  expectedLeaseId?: string,
): LeaseGrantResponse {
  requireLeaseDisplay(body, phase, text);
  if (body["eligible"] !== true || body["allowed"] !== true) {
    fail(phase, "lease authority must be eligible and allowed", text);
  }
  if (Object.hasOwn(body, "ineligible_reason") || Object.hasOwn(body, "denied_by_period")) {
    fail(phase, "positive lease authority must omit terminal verdict fields", text);
  }
  for (const key of LEASE_AUTHORITY_KEYS) {
    if (!Object.hasOwn(body, key)) fail(phase, `${key} must be present`, text);
  }
  const leaseId = requireString(body["lease_id"], phase, text, "lease_id");
  if (expectedLeaseId !== undefined && leaseId !== expectedLeaseId) {
    fail(phase, "renewal must preserve lease_id", text);
  }
  if (body["generation"] !== generation) fail(phase, `generation must be ${generation}`, text);
  requirePositiveInteger(body["granted_tokens"], phase, text, "granted_tokens");
  requirePositiveInteger(body["headroom_share_tokens"], phase, text, "headroom_share_tokens");
  const refresh = requireFiniteNumber(
    body["refresh_interval_s"],
    phase,
    text,
    "refresh_interval_s",
  );
  const length = requireFiniteNumber(body["lease_length_s"], phase, text, "lease_length_s");
  if (!(refresh > 0)) fail(phase, "refresh_interval_s must be positive", text);
  if (!(length > refresh)) fail(phase, "lease_length_s must exceed refresh_interval_s", text);
  const posture = requireRecord(body["posture"], phase, text, "posture");
  requireExactKeys(posture, ["mode", "on_unreachable"], phase, text, "posture");
  if (posture["mode"] !== body["mode"]) fail(phase, "posture.mode must match mode", text);
  if (posture["on_unreachable"] !== "fail_open") {
    fail(phase, "posture.on_unreachable must be fail_open", text);
  }
  if (body["final_grant"] !== false) fail(phase, "final_grant must be false", text);
  return body as unknown as LeaseGrantResponse;
}

export async function assertLeaseContract(
  fetch: FetchLike,
  options: ContractOptions,
): Promise<void> {
  const holderCap = await postLease(
    fetch,
    options,
    LEASE_PATH,
    leaseGrantPayload("contract-holder-cap", "contract-holder-cap-overflow"),
    "lease.holder-cap",
    409,
  );
  requireLeaseError(
    holderCap.body,
    "lease_holder_cap_exceeded",
    "Active lease holder limit exceeded",
    "lease.holder-cap",
    holderCap.exchange.text,
  );

  const denied = await postLease(
    fetch,
    options,
    LEASE_PATH,
    leaseGrantPayload("contract-lease-denied", "contract-denied-holder"),
    "lease.denied",
  );
  requireLeaseDisplay(denied.body, "lease.denied", denied.exchange.text);
  if (
    denied.body["eligible"] !== true ||
    denied.body["allowed"] !== false ||
    denied.body["mode"] !== "hard_deny" ||
    denied.body["denied_by_period"] !== "monthly"
  ) {
    fail("lease.denied", "unexpected hard-deny verdict", denied.exchange.text);
  }
  if (Object.hasOwn(denied.body, "ineligible_reason")) {
    fail("lease.denied", "ineligible_reason must be omitted", denied.exchange.text);
  }
  requireNoLeaseAuthority(denied.body, "lease.denied", denied.exchange.text);

  const ineligible = await postLease(
    fetch,
    options,
    LEASE_PATH,
    leaseGrantPayload(
      "contract-lease-ineligible",
      "contract-ineligible-holder",
      "no-such-model-for-leases",
    ),
    "lease.ineligible",
  );
  requireLeaseDisplay(ineligible.body, "lease.ineligible", ineligible.exchange.text);
  if (
    ineligible.body["eligible"] !== false ||
    ineligible.body["allowed"] !== true ||
    ineligible.body["ineligible_reason"] !== "zero_rate_model"
  ) {
    fail("lease.ineligible", "unexpected ineligible verdict", ineligible.exchange.text);
  }
  if (Object.hasOwn(ineligible.body, "denied_by_period")) {
    fail("lease.ineligible", "denied_by_period must be omitted", ineligible.exchange.text);
  }
  requireNoLeaseAuthority(ineligible.body, "lease.ineligible", ineligible.exchange.text);

  const holderId = "contract-eligible-holder";
  const grant = await postLease(
    fetch,
    options,
    LEASE_PATH,
    leaseGrantPayload("contract-lease-eligible", holderId),
    "lease.grant",
  );
  if (grant.body["eligible"] !== true || grant.body["allowed"] !== true) {
    fail("lease.grant", "eligible grant must allow", grant.exchange.text);
  }
  const authority = requireLeaseAuthority(grant.body, "lease.grant", grant.exchange.text, 1);
  const leaseId = authority.lease_id as string;
  const renewalPayload = renewalPayloadForAcceptedAuthority(leaseId, holderId);

  const unknown = await postLease(
    fetch,
    options,
    LEASE_RENEW_PATH,
    leaseRenewPayload("lse_not-a-real-lease", holderId, 1),
    "lease.renew-unknown",
    404,
  );
  requireLeaseError(
    unknown.body,
    "lease_not_found",
    "Budget lease not found",
    "lease.renew-unknown",
    unknown.exchange.text,
  );

  const wrong = await postLease(
    fetch,
    options,
    LEASE_RENEW_PATH,
    { ...renewalPayload, generation: 99 },
    "lease.renew-wrong-generation",
    409,
  );
  requireLeaseError(
    wrong.body,
    "lease_generation_conflict",
    "Budget lease generation conflict",
    "lease.renew-wrong-generation",
    wrong.exchange.text,
  );

  const renewed = await postLease(fetch, options, LEASE_RENEW_PATH, renewalPayload, "lease.renew");
  requireLeaseAuthority(renewed.body, "lease.renew", renewed.exchange.text, 2, leaseId);

  const leaseConfirm = confirmPayload({ lease_id: leaseId }, crypto.randomUUID());
  if (Object.hasOwn(leaseConfirm, "reservation_id")) {
    fail("lease.confirm", "lease serializer must omit reservation_id", "");
  }
  await requireEmptyStatus(fetch, options, leaseConfirm, "lease.confirm", 204);
  await requireEmptyStatus(fetch, options, leaseConfirm, "lease.confirm-replay", 204);

  const surrenderPayload = leaseSurrenderPayload(leaseId, holderId, 2);
  const surrendered = await postLease(
    fetch,
    options,
    LEASE_SURRENDER_PATH,
    surrenderPayload,
    "lease.surrender",
  );
  requireExactKeys(
    surrendered.body,
    ["released_tokens"],
    "lease.surrender",
    surrendered.exchange.text,
    "surrender response",
  );
  requirePositiveInteger(
    surrendered.body["released_tokens"],
    "lease.surrender",
    surrendered.exchange.text,
    "released_tokens",
  );
  requireSchema(
    LeaseSurrenderResponseSchema,
    surrendered.body,
    "lease.surrender",
    surrendered.exchange.text,
  );

  const replay = await postLease(
    fetch,
    options,
    LEASE_SURRENDER_PATH,
    surrenderPayload,
    "lease.surrender-replay",
  );
  requireExactKeys(
    replay.body,
    ["released_tokens"],
    "lease.surrender-replay",
    replay.exchange.text,
    "surrender response",
  );
  if (replay.body["released_tokens"] !== 0) {
    fail("lease.surrender-replay", "released_tokens must be zero", replay.exchange.text);
  }
  requireSchema(
    LeaseSurrenderResponseSchema,
    replay.body,
    "lease.surrender-replay",
    replay.exchange.text,
  );
}

function requireRunControl(
  body: JsonRecord,
  stoppedRunId: string,
  phase: string,
  text: string,
): void {
  const directive = requireRecord(body["run_control"], phase, text, "run_control");
  requireExactKeys(
    directive,
    ["version", "action", "agent_run_id", "reason"],
    phase,
    text,
    "run_control",
  );
  if (directive["version"] !== "1") fail(phase, "run_control.version must be 1", text);
  if (directive["action"] !== "terminate") {
    fail(phase, "run_control.action must be terminate", text);
  }
  if (directive["agent_run_id"] !== stoppedRunId) {
    fail(phase, "run_control.agent_run_id must match stoppedRunId", text);
  }
  const reason = requireString(directive["reason"], phase, text, "run_control.reason");
  if (reason.length < 1 || reason.length > 64) {
    fail(phase, "run_control.reason length must be 1..64", text);
  }
}

export async function assertRunControlContract(
  fetch: FetchLike,
  options: RunControlContractOptions,
): Promise<void> {
  const optedPhase = "run-control.opted-in";
  const opted = await check(
    fetch,
    options,
    optedPhase,
    checkPayload({ agent_run_id: options.stoppedRunId, run_directive_version: "1" }),
    { allowed: false, deniedByPeriod: "run_stopped" },
  );
  requireRunControl(opted, options.stoppedRunId, optedPhase, JSON.stringify(opted));

  const legacyPhase = "run-control.legacy";
  const legacy = await check(
    fetch,
    options,
    legacyPhase,
    checkPayload({ agent_run_id: options.stoppedRunId }),
    { allowed: false, deniedByPeriod: "run_stopped" },
  );
  if (Object.hasOwn(legacy, "run_control")) {
    fail(legacyPhase, "run_control must be omitted without opt-in", JSON.stringify(legacy));
  }

  const unstoppedPhase = "run-control.unstopped";
  const unstopped = await check(
    fetch,
    options,
    unstoppedPhase,
    checkPayload({
      agent_run_id: `contract-unstopped-${crypto.randomUUID().replaceAll("-", "")}`,
      run_directive_version: "1",
    }),
    { allowed: true },
  );
  if (Object.hasOwn(unstopped, "run_control")) {
    fail(
      unstoppedPhase,
      "run_control must be omitted for an unstopped run",
      JSON.stringify(unstopped),
    );
  }
}

function receiptEvent(source: "server" | "aggregate_replay", inputTokens: number): JsonRecord {
  const event: MetadataEvent = MetadataEventSchema.parse({
    model: "gpt-5.5",
    provider: "openai",
    input_tokens: inputTokens,
    output_tokens: 0,
    latency_ms: 0,
    status: "budget_denied",
    is_model_fallback: false,
    is_provider_fallback: false,
    call_id: crypto.randomUUID(),
    sdk_instance_id: `contract-${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    agent_run_id: `contract-${crypto.randomUUID()}`,
    deny_source: source,
    deny_reason: "monthly",
    denied_by_period: "monthly",
    estimated_output_bound: 512,
    ...(source === "server"
      ? { velocity_flags: ["monotonic_growth", "repeat_size"] }
      : { receipt_aggregate_count: 3 }),
  });
  return serializeMetadataEvent(event);
}

async function requireReceiptAccepted(
  fetch: FetchLike,
  options: ContractOptions,
  event: JsonRecord,
  phase: string,
): Promise<void> {
  const exchange = await postJson(fetch, options, INGEST_PATH, [event], phase);
  requireStatus(exchange, 202, phase);
  const body = requireRecord(parseJson(exchange, phase), phase, exchange.text);
  requireExactKeys(body, ["ingested", "rejected"], phase, exchange.text, "ingest response");
  if (body["ingested"] !== 1 || !Array.isArray(body["rejected"]) || body["rejected"].length !== 0) {
    fail(phase, "expected exactly {ingested: 1, rejected: []}", exchange.text);
  }
  requireSchema(IngestResponseSchema, body, phase, exchange.text);
}

export async function assertReceiptIngestContract(
  fetch: FetchLike,
  options: ContractOptions,
): Promise<void> {
  await requireReceiptAccepted(
    fetch,
    options,
    receiptEvent("server", 1000),
    "receipt.server-denial",
  );
  await requireReceiptAccepted(
    fetch,
    options,
    receiptEvent("aggregate_replay", 3000),
    "receipt.aggregate-replay",
  );
}

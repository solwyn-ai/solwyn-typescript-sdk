import { createEventTimestampAllocator } from "../../src/event-timestamp";
import { serializeMetadataEvent } from "../../src/validation";

const actualDate = Date;
const actualNow = Date.now;
const fixed = actualDate.parse("2026-09-07T12:00:00.000Z");
Date.now = () => fixed;
try {
  const next = createEventTimestampAllocator();
  const events = Array.from({ length: 2001 }, () =>
    serializeMetadataEvent({
      model: "gpt-4o",
      provider: "openai",
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: 0,
      status: "success",
      is_model_fallback: false,
      is_provider_fallback: false,
      attempt_index: 0,
      call_id: crypto.randomUUID(),
      sdk_instance_id: "timestamp-normalization",
      timestamp: next(),
    }),
  );
  process.stdout.write(JSON.stringify(events));
} finally {
  Date.now = actualNow;
}

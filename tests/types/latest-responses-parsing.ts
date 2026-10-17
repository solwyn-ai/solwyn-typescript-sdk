import type OpenAI from "openai";
import type { ResponseCreateParamsWithTools } from "openai/lib/ResponsesParser";
import type { ResponseStreamParams } from "openai/lib/responses/ResponseStream";
import { Solwyn } from "../../src/index";

export function genericLatestParseForwarding<Params extends ResponseCreateParamsWithTools>(
  raw: OpenAI,
  params: Params,
) {
  const client = new Solwyn(raw, {});
  const native = raw.responses.parse(params);
  const wrapped = client.responses.parse(params);
  const nativeResult: Promise<Awaited<typeof native>> = wrapped;
  const wrappedResult: Promise<Awaited<typeof wrapped>> = native;
  return { nativeResult, wrappedResult };
}

export async function rawJsonSchemaParsing(raw: OpenAI) {
  const client = new Solwyn(raw, {});
  const parsed = await client.responses.parse({
    model: "gpt-test",
    text: { format: { type: "json_schema", name: "counter", schema: { type: "object" } } },
  });
  const result: unknown = parsed.output_parsed;
  // @ts-expect-error Unbranded JSON schemas can produce a value, so null is too narrow.
  const absent: null = parsed.output_parsed;
  void [result, absent];
}

export function genericLatestStreamForwarding<Params extends ResponseStreamParams>(
  raw: OpenAI,
  params: Params,
) {
  const client = new Solwyn(raw, {});
  const native = raw.responses.stream(params).finalResponse();
  const wrapped = client.responses.stream(params).finalResponse();
  const nativeResult: typeof native = wrapped;
  const wrappedResult: typeof wrapped = native;
  return { nativeResult, wrappedResult };
}

import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseCreateParamsWithTools } from "openai/lib/ResponsesParser";
import { z } from "zod";
import { Solwyn } from "../../src/index";

const countSchema = z.object({ count: z.number() });
type CountFormat = ReturnType<typeof zodTextFormat<typeof countSchema>>;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export async function nativeProviderTypes(oa: OpenAI, anth: Anthropic) {
  const wrapped = new Solwyn(oa, {});
  const chatParams = { model: "gpt-review", messages: [], stream: false } as const;
  const chat = await wrapped.chat.completions.create({ ...chatParams, messages: [] });
  const rawChat = await oa.chat.completions.create({ ...chatParams, messages: [] });
  type Chat = Assert<Equal<typeof chat, typeof rawChat>>;
  void (null as unknown as Chat);
  void chat.usage;
  const stream = await wrapped.chat.completions.create({
    model: "gpt-review",
    messages: [],
    stream: true,
  });
  for await (const chunk of stream) void chunk.usage;
  const response = await wrapped.responses.create({
    model: "gpt-review",
    input: [],
    stream: false,
  });
  void response.usage;
  const responses = await wrapped.responses.create({
    model: "gpt-review",
    input: [],
    stream: true,
  });
  for await (const chunk of responses) void chunk.type;
  const params = {
    model: "gpt-review",
    input: [],
    text: {
      format: zodTextFormat(
        z.object({ count: z.number(), nested: z.object({ enabled: z.boolean() }) }),
        "review",
      ),
    },
  };
  const parsed = await wrapped.responses.parse(params);
  const rawParsed = await oa.responses.parse(params);
  const count: number | undefined = parsed.output_parsed?.count;
  const enabled: boolean | undefined = parsed.output_parsed?.nested.enabled;
  const parsedMatchesNative: typeof rawParsed = parsed;
  const nativeMatchesParsed: typeof parsed = rawParsed;
  void [count, enabled, parsedMatchesNative, nativeMatchesParsed];
  // @ts-expect-error schema inference must reject unrelated fields
  void parsed.output_parsed?.missing;
  for (const item of parsed.output)
    if (item.type === "message") {
      for (const part of item.content)
        if (part.type === "output_text") {
          const nestedCount: number | undefined = part.parsed?.count;
          void nestedCount;
          // @ts-expect-error nested parsed output must preserve the same schema
          void part.parsed?.missing;
        }
    }
  const explicit = await wrapped.responses.parse<typeof params, { explicit: string }>(params);
  const explicitValue: string | undefined = explicit.output_parsed?.explicit;
  void explicitValue;
  const noSchema = await wrapped.responses.parse({ model: "gpt-review", input: [] });
  const noParsed: null = noSchema.output_parsed;
  void noParsed;
  const images = await wrapped.images.generate({ model: "gpt-image-1", prompt: "", stream: false });
  void images.data;
  for await (const image of await wrapped.images.generate({
    model: "gpt-image-1",
    prompt: "",
    stream: true,
  }))
    void image.type;
  const file = new File([], "empty");
  const json = await wrapped.audio.transcriptions.create({
    model: "whisper-1",
    file,
    response_format: "verbose_json",
  });
  void json.duration;
  const text = await wrapped.audio.transcriptions.create({
    model: "whisper-1",
    file,
    response_format: "text",
  });
  const nativeText: string = text;
  void nativeText;
  // @ts-expect-error intercepted promises do not expose native response envelopes
  wrapped.chat.completions.create({ model: "gpt-review", messages: [] }).withResponse();
  // @ts-expect-error intercepted generic promises also omit response envelopes
  wrapped.responses.parse(params).asResponse();
  const wrappedAnthropic = new Solwyn(anth, {});
  const message = await wrappedAnthropic.messages.create({
    model: "claude-review",
    messages: [],
    max_tokens: 1,
    stream: false,
  });
  void message.usage;
  for await (const event of await wrappedAnthropic.messages.create({
    model: "claude-review",
    messages: [],
    max_tokens: 1,
    stream: true,
  }))
    void event.type;
  const anthropicPromise = wrappedAnthropic.messages.create({
    model: "claude-review",
    messages: [],
    max_tokens: 1,
  });
  // @ts-expect-error Anthropic interception returns an ordinary promise
  anthropicPromise.withResponse();
  // @ts-expect-error Anthropic interception does not expose the raw HTTP response
  anthropicPromise.asResponse();
  void anth.messages.create({ model: "claude-review", messages: [], max_tokens: 1 }).withResponse();
  void wrapped.models.list().withResponse();
  void wrappedAnthropic.messages
    .countTokens({ model: "claude-review", messages: [] })
    .withResponse();
}

export async function nativeOptionalParseTypes(
  oa: OpenAI,
  optional: { model: string; text?: { format?: CountFormat } },
  union: { model: string; text: { format: CountFormat | { type: "text" } } },
) {
  const wrapped = new Solwyn(oa, {});
  const noFormat = await wrapped.responses.parse({ model: "gpt-review", text: {} });
  const rawNoFormat = await oa.responses.parse({ model: "gpt-review", text: {} });
  const noFormatMatches: typeof rawNoFormat = noFormat;
  const optionalResult = await wrapped.responses.parse(optional);
  const nativeOptional = await oa.responses.parse(optional);
  const optionalMatches: typeof nativeOptional = optionalResult;
  const unionResult = await wrapped.responses.parse(union);
  const nativeUnion = await oa.responses.parse(union);
  const unionMatches: typeof nativeUnion = unionResult;
  const absent: null = noFormat.output_parsed;
  const optionalAbsent: null = optionalResult.output_parsed;
  const unionAbsent: null = unionResult.output_parsed;
  // @ts-expect-error native Responses does not accept a null format
  void oa.responses.parse({ model: "gpt-review", text: { format: null } });
  // @ts-expect-error the wrapper must preserve that native parameter rejection
  void wrapped.responses.parse({ model: "gpt-review", text: { format: null } });
  void [noFormatMatches, optionalMatches, unionMatches, absent, optionalAbsent, unionAbsent];
}

export async function ordinaryPromiseGenerics() {
  const raw = {
    chat: {
      completions: {
        async create<T>(value: T): Promise<T> {
          return value;
        },
      },
    },
  };
  const wrapped = new Solwyn(raw, {});
  const value = await wrapped.chat.completions.create({ count: 3 });
  const count: number = value.count;
  const explicit: string = await wrapped.chat.completions.create<string>("");
  // @ts-expect-error plain generic promises must retain their inferred shape
  void value.missing;
  void [count, explicit];
}

export function genericNativeParseForwarding<Params extends ResponseCreateParamsWithTools>(
  oa: OpenAI,
  params: Params,
) {
  const wrapped = new Solwyn(oa, {});
  const raw = oa.responses.parse(params);
  const actual = wrapped.responses.parse(params);
  const nativeResult: Promise<Awaited<typeof raw>> = actual;
  const wrappedResult: Promise<Awaited<typeof actual>> = raw;
  return { nativeResult, wrappedResult };
}

export async function optionalNativeSurfaces(oa: OpenAI, anth: Anthropic) {
  const optionalMessages: {
    readonly messages?: { readonly create?: Anthropic["messages"]["create"] };
  } = anth;
  const messagesClient = new Solwyn(optionalMessages, {});
  const messagePromise = messagesClient.messages?.create?.({
    model: "claude-review",
    messages: [],
    max_tokens: 1,
    stream: false,
  });
  void (await messagePromise)?.usage;
  // @ts-expect-error optional intercepted method results must not advertise native helpers
  messagePromise?.withResponse();
  // @ts-expect-error readonly namespace modifiers are preserved
  messagesClient.messages = undefined;
  if (messagesClient.messages) {
    // @ts-expect-error readonly method modifiers are preserved
    messagesClient.messages.create = undefined;
  }
  const optionalChat: {
    chat?: { completions?: { create?: OpenAI["chat"]["completions"]["create"] } };
  } = oa;
  const chatClient = new Solwyn(optionalChat, {});
  const chatPromise = chatClient.chat?.completions?.create?.({
    model: "gpt-review",
    messages: [],
    stream: false,
  });
  void (await chatPromise)?.usage;
  // @ts-expect-error optional chat methods retain honest promise envelopes
  chatPromise?.asResponse();
  const optionalImages: {
    images?: { generate?: OpenAI["images"]["generate"]; edit?: OpenAI["images"]["edit"] };
  } = oa;
  const imagesClient = new Solwyn(optionalImages, {});
  const imagesPromise = imagesClient.images?.generate?.({
    model: "gpt-image-1",
    prompt: "",
    stream: false,
  });
  void (await imagesPromise)?.data;
  // @ts-expect-error optional image generation retains honest promise envelopes
  imagesPromise?.withResponse();
  const editedPromise = imagesClient.images?.edit?.({
    model: "gpt-image-1",
    image: new File([], "empty"),
    prompt: "",
    stream: false,
  });
  void (await editedPromise)?.data;
  // @ts-expect-error optional image editing retains honest promise envelopes
  editedPromise?.asResponse();
  const optionalResponses: {
    responses?: { create?: OpenAI["responses"]["create"]; parse?: OpenAI["responses"]["parse"] };
  } = oa;
  const responseClient = new Solwyn(optionalResponses, {});
  const responsePromise = responseClient.responses?.create?.({
    model: "gpt-review",
    stream: false,
  });
  void (await responsePromise)?.usage;
  const parsedPromise = responseClient.responses?.parse?.({
    model: "gpt-review",
    text: { format: zodTextFormat(countSchema, "count") },
  });
  const parsedCount: number | undefined = (await parsedPromise)?.output_parsed?.count;
  void parsedCount;
  // @ts-expect-error optional parse preserves generic field restrictions
  void (await parsedPromise)?.output_parsed?.missing;
  // @ts-expect-error optional parsed methods retain honest promise envelopes
  parsedPromise?.asResponse();
  const optionalAudio: {
    audio?: {
      transcriptions?: { create?: OpenAI["audio"]["transcriptions"]["create"] };
      speech?: { create?: OpenAI["audio"]["speech"]["create"] };
    };
  } = oa;
  const audioClient = new Solwyn(optionalAudio, {});
  const transcription = audioClient.audio?.transcriptions?.create?.({
    model: "whisper-1",
    file: new File([], "empty"),
    response_format: "text",
  });
  const transcriptionText: string | undefined = await transcription;
  void transcriptionText;
  // @ts-expect-error optional transcription does not advertise native helpers
  transcription?.withResponse();
  const speech = audioClient.audio?.speech?.create?.({ model: "tts-1", input: "", voice: "alloy" });
  void (await speech)?.status;
  // @ts-expect-error optional speech does not advertise native helpers
  speech?.withResponse();
  const optionalEmbedding: { embeddings?: { create?: OpenAI["embeddings"]["create"] } } = oa;
  const embeddings = new Solwyn(optionalEmbedding, {}).embeddings?.create?.({
    model: "text-embedding-3-small",
    input: [],
  });
  void (await embeddings)?.usage;
  // @ts-expect-error optional embeddings do not advertise native helpers
  embeddings?.withResponse();
  const optionalVideos: { videos?: { create?: OpenAI["videos"]["create"] } } = oa;
  const video = new Solwyn(optionalVideos, {}).videos?.create?.({ model: "sora-2", prompt: "" });
  void (await video)?.id;
  // @ts-expect-error optional videos do not advertise native helpers
  video?.asResponse();
  const absent = new Solwyn({}, {});
  // @ts-expect-error missing namespaces must not be fabricated
  void absent.messages;
  const absentMethod = new Solwyn({ images: {} }, {});
  // @ts-expect-error missing methods must not be fabricated
  void absentMethod.images.generate;
}

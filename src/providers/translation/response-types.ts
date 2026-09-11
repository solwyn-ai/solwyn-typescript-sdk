/**
 * PRIVACY-CRITICAL: erased, structural response typing only. These types connect a
 * native parseable format to its parsed fields without a provider SDK dependency.
 */

type TextConfigParams = { text?: { format?: unknown } };

type NativeTextFormat<Body extends TextConfigParams> = Extract<
  NonNullable<NonNullable<Body["text"]>["format"]>,
  { type: "json_schema" }
>;

type ParseableTextFormat<Parsed, NativeFormat> = NativeFormat & {
  __output: Parsed;
  $brand: "auto-parseable-response-format";
  $parseRaw(content: string): Parsed;
};

// Keep the native indexed conditional (including symbolic Params) exactly intact.
// Derive its JSON-schema format base from the supplied provider method itself.
type ParsedFromParams<Params extends TextConfigParams, NativeFormat> =
  NonNullable<Params["text"]>["format"] extends ParseableTextFormat<infer Parsed, NativeFormat>
    ? Parsed
    : null;

type ParsedPart<Part, Parsed> = Part extends { type: "output_text"; parsed: unknown }
  ? { [Key in keyof Part]: Key extends "parsed" ? Parsed | null : Part[Key] }
  : Part;

type ParsedItem<Item, Parsed> = Item extends { type: "message"; content: infer Parts }
  ? {
      [Key in keyof Item]: Key extends "content"
        ? Parts extends readonly unknown[]
          ? { [Index in keyof Parts]: ParsedPart<Parts[Index], Parsed> }
          : Parts
        : Item[Key];
    }
  : Item;

type ParsedResponse<Result, Parsed> = {
  [Key in keyof Result]: Key extends "output_parsed"
    ? Parsed | null
    : Key extends "output"
      ? ParsedItems<Result[Key], Parsed>
      : Result[Key];
};

type ParsedItems<Items, Parsed> = Items extends readonly unknown[]
  ? { [Index in keyof Items]: ParsedItem<Items[Index], Parsed> }
  : Items;

/** Preserve native parameter constraints/options while restoring its schema relationship. */
export type PlainResponsesParse<F> = F extends (
  body: infer Body,
  ...options: infer Options
) => infer Return
  ? Return extends Promise<unknown>
    ? Exclude<keyof Return, keyof Promise<unknown>> extends never
      ? F
      : PlainParseEnvelope<Body, Options, Return>
    : PlainParseEnvelope<Body, Options, Return>
  : F;

type PlainParseEnvelope<Body, Options extends unknown[], Return> =
  Awaited<Return> extends {
    output_parsed: unknown;
    output: readonly unknown[];
  }
    ? Body extends TextConfigParams
      ? <Params extends Body, Parsed = ParsedFromParams<Params, NativeTextFormat<Body>>>(
          body: Params,
          ...options: Options
        ) => Promise<ParsedResponse<Awaited<Return>, Parsed>>
      : (...args: [Body, ...Options]) => Promise<Awaited<Return>>
    : (...args: [Body, ...Options]) => Promise<Awaited<Return>>;

type NativeStreamOn<Helper> = Helper extends {
  on: infer On extends (...args: never[]) => unknown;
}
  ? On
  : never;

type NativeStreamEvent<Helper> = Helper extends AsyncIterable<infer Event> ? Event : never;
type NativeStreamIterator<Helper> = Helper extends {
  [Symbol.asyncIterator]: infer Iterator;
}
  ? OmitThisParameter<Iterator>
  : never;
type NativeStreamEventName<Helper> = Parameters<NativeStreamOn<Helper>>[0];

// The native on() constraint retains the union of exact callback signatures.
// Remove its catch-all "event" callback before projecting discriminated typed
// events, otherwise that union would erase native delta snapshot/parsed fields.
type NativeSpecificCallback<Helper> = Exclude<
  Parameters<NativeStreamOn<Helper>>[1],
  (event: NativeStreamEvent<Helper>) => void
>;
type NativeCallbackArgument<Callback> = Callback extends (argument: infer Argument) => void
  ? Argument
  : never;
type NativeStreamPayload<Helper> = NativeCallbackArgument<NativeSpecificCallback<Helper>>;
type NativeStreamErrors<Helper> = Exclude<NativeStreamPayload<Helper>, { type: string }>;
// openai-node's "error" callback is an intersection of its base Error listener
// and wire error-event listener. Preserve that exact overload, including which
// argument its emitted() conditional selects.
type NativeStreamErrorCallback<Helper> = Extract<
  NativeSpecificCallback<Helper>,
  (error: Error) => void
>;

type NativeStreamArguments<Helper, Event> = Event extends "event"
  ? [NativeStreamEvent<Helper>]
  : Event extends "connect" | "end"
    ? []
    : Event extends "error"
      ? Parameters<NativeStreamErrorCallback<Helper>>
      : Event extends "abort"
        ? [Extract<NativeStreamErrors<Helper>, { status: unknown }>]
        : [Extract<NativeStreamPayload<Helper>, { type: Event }>];

type NativeStreamCallbacks<Helper> = {
  [Event in NativeStreamEventName<Helper> & PropertyKey]: Event extends "error"
    ? NativeStreamErrorCallback<Helper>
    : (...args: NativeStreamArguments<Helper, Event>) => void;
};

interface DeferredStreamListeners<Helper> {
  on<Event extends keyof NativeStreamCallbacks<Helper>>(
    event: Event,
    listener: NativeStreamCallbacks<Helper>[Event],
  ): this;
  off<Event extends keyof NativeStreamCallbacks<Helper>>(
    event: Event,
    listener: NativeStreamCallbacks<Helper>[Event],
  ): this;
  once<Event extends keyof NativeStreamCallbacks<Helper>>(
    event: Event,
    listener: NativeStreamCallbacks<Helper>[Event],
  ): this;
}

type DeferredStreamHelper<Helper, Result, Parsed> = Omit<
  Helper,
  "_emit" | "on" | "off" | "once" | "finalResponse" | typeof Symbol.asyncIterator
> &
  DeferredStreamListeners<Helper> & {
    [Symbol.asyncIterator]: NativeStreamIterator<Helper>;
    finalResponse(): Promise<ParsedResponse<Result, Parsed>>;
  };

/** Native schema/event relationships with the deferred bridge's actual public surface. */
export type DeferredResponsesStreamMethod<F> = F extends (
  body: infer Body,
  ...options: infer Options
) => infer Helper
  ? Helper extends { _emit: unknown; finalResponse(): Promise<infer Result> }
    ? [Body] extends [TextConfigParams]
      ? <Params extends Body, Parsed = ParsedFromParams<Params, NativeTextFormat<Body>>>(
          body: Params,
          ...options: Options
        ) => DeferredStreamHelper<Helper, Result, Parsed>
      : F
    : F
  : F;

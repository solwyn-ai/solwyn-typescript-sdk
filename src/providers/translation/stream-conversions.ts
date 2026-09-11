/**
 * PRIVACY-CRITICAL: native stream conversion owns caller-visible chunk encoding and
 * tee buffers. Values stay local and are released as each branch consumes/cancels.
 * No provider method is rebound to a foreign receiver or imported into core.
 */
import { SolwynError } from "../../errors";

const finished = (): IteratorResult<unknown> => ({ done: true, value: undefined });

/** Native-compatible consuming helpers over an already metered iterator. */
export class StreamConversion implements AsyncIterableIterator<unknown> {
  readonly controller: unknown;
  readonly #iterator: AsyncIterator<unknown>;
  #consumer: "iteration" | "helper" | null = null;

  constructor(iterator: AsyncIterator<unknown>, controller: unknown) {
    this.#iterator = iterator;
    this.controller = controller;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    return this;
  }

  next(): Promise<IteratorResult<unknown>> {
    if (this.#consumer === "helper") return Promise.reject(this.#consumedError());
    this.#consumer = "iteration";
    return Promise.resolve(this.#iterator.next());
  }

  async return(): Promise<IteratorResult<unknown>> {
    return (await this.#iterator.return?.()) ?? finished();
  }

  async throw(error?: unknown): Promise<IteratorResult<unknown>> {
    if (this.#iterator.throw !== undefined) return this.#iterator.throw(error);
    await this.return();
    throw error;
  }

  #take(): AsyncIterator<unknown> {
    if (this.#consumer !== null) throw this.#consumedError();
    this.#consumer = "helper";
    return this.#iterator;
  }

  #consumedError(): SolwynError {
    return new SolwynError("stream already has a consumer; use tee() before consuming it");
  }

  /** Keep native UTF-8 newline-delimited JSON output and one-item backpressure. */
  toReadableStream(): ReadableStream<Uint8Array> {
    const iterator = this.#take();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await iterator.next();
          if (item.done) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(item.value)}\n`));
        } catch (error) {
          try {
            await iterator.return?.();
          } catch {
            // Preserve the original iteration/encoding failure.
          }
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
  }

  /**
   * Either branch can drive the source, like native SDK tee(). A slower branch
   * retains only its unread remainder. Cancelling both branches closes the source;
   * cancelling one frees its buffer without preventing the other from completing.
   */
  tee(): [StreamConversion, StreamConversion] {
    const iterator = this.#take();
    const queues: [
      Array<Promise<IteratorResult<unknown>>>,
      Array<Promise<IteratorResult<unknown>>>,
    ] = [[], []];
    const active = [true, true];
    let terminal = false;
    const branch = (index: 0 | 1): StreamConversion =>
      new StreamConversion(
        {
          next() {
            if (!active[index]) return Promise.resolve(finished());
            const queue = queues[index];
            if (queue.length === 0) {
              // The lifecycle source owns terminal behavior: ordinary failures end,
              // but a latched cooperative stop stays authoritative on every read.
              // Never retain arbitrary provider exceptions after both queues drain.
              if (terminal) return Promise.resolve(iterator.next());
              const pulled = Promise.resolve(iterator.next()).then(
                (item) => {
                  if (item.done) terminal = true;
                  return item;
                },
                (error: unknown) => {
                  terminal = true;
                  throw error;
                },
              );
              for (const side of [0, 1] as const) {
                if (active[side]) queues[side].push(pulled);
              }
            }
            return queue.shift() ?? Promise.resolve(finished());
          },
          async return() {
            active[index] = false;
            queues[index].length = 0;
            if (!active[0] && !active[1]) await iterator.return?.();
            return finished();
          },
        },
        this.controller,
      );
    return [branch(0), branch(1)];
  }
}

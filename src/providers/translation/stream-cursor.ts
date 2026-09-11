/**
 * PRIVACY-CRITICAL — translation package (content-privileged).
 *
 * Stateful fan-out cursor for translated stream chunks. This is the only owner of
 * translated output that must survive between caller pulls; consumers receive an
 * opaque capability and cannot inspect its retained queue. Pure; no I/O capability.
 */

/** Maps one raw served chunk to zero-or-more caller-dialect chunks. */
export type ChunkTranslator = (rawChunk: unknown) => unknown[];

/** Opaque capability used by the content-blind stream lifecycle wrapper. */
export interface ChunkTranslationCursor {
  /** Translate and enqueue one raw served chunk. */
  push(rawChunk: unknown): void;
  /** Remove the next translated output, or report that the cursor is empty. */
  take(): IteratorResult<unknown>;
  /** Forget every translated output that has not yet been delivered. */
  clear(): void;
}

export function createChunkTranslationCursor(translate: ChunkTranslator): ChunkTranslationCursor {
  let queued: unknown[] = [];
  let offset = 0;

  const clear = (): void => {
    queued = [];
    offset = 0;
  };

  return Object.freeze({
    push(rawChunk: unknown): void {
      if (offset === queued.length) clear();
      queued.push(...translate(rawChunk));
    },
    take(): IteratorResult<unknown> {
      if (offset === queued.length) {
        clear();
        return { done: true, value: undefined };
      }
      const value = queued[offset];
      offset += 1;
      if (offset === queued.length) clear();
      return { done: false, value };
    },
    clear,
  });
}

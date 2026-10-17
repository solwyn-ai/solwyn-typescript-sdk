export declare function alive(refs: readonly WeakRef<object>[]): number;
export declare function settle(cycles: number): Promise<void>;
export declare function collectUntil(
  predicate: () => boolean,
  describe: () => string,
  maxCycles?: number,
): Promise<number>;

/**
 * Allocate completion timestamps at the API's datetime/PostgreSQL microsecond precision.
 * One allocator belongs to one SDK instance's reporter, including aggregate replays.
 * Allocation happens only for new events: queued retries keep the original timestamp.
 */
export function createEventTimestampAllocator(): () => string {
  let lastMicrosecond = 0n;
  return () => {
    const wallMicrosecond = BigInt(Date.now()) * 1000n;
    lastMicrosecond = wallMicrosecond > lastMicrosecond ? wallMicrosecond : lastMicrosecond + 1n;
    const milliseconds = lastMicrosecond / 1000n;
    const fraction = (lastMicrosecond % 1000000n).toString().padStart(6, "0");
    return `${new Date(Number(milliseconds)).toISOString().slice(0, -4)}${fraction}Z`;
  };
}

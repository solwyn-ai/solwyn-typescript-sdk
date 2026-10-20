import {
  type DetachedRun,
  getDetachedRunFactory,
  setDetachedRunFactory,
} from "../../src/run-context";

/** Observe real detached-run cleanup through the factory seam, without exposing class state. */
export function trackIntegrationRuns() {
  const factory = getDetachedRunFactory();
  if (factory === undefined) throw new Error("Node test seam missing");
  const handles: DetachedRun[] = [];
  const active = new Set<string>();
  const deferred: string[] = [];
  setDetachedRunFactory((name, options) => {
    const handle = factory(name, options);
    handles.push(handle);
    active.add(handle.runId);
    return {
      runId: handle.runId,
      activate: (fn) => handle.activate(fn),
      tryFinish: () => {
        const finished = handle.tryFinish();
        if (finished) active.delete(handle.runId);
        else deferred.push(handle.runId);
        return finished;
      },
    };
  });
  return { handles, active, deferred, restore: () => setDetachedRunFactory(factory) };
}

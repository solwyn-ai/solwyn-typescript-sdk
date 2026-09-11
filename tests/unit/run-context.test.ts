/**
 * Exercises run scoping: `newRunId` format/uniqueness, `run(name, fn)` callback
 * scoping, nesting, exception cleanup, async propagation, concurrent-task isolation,
 * eager name validation, and the run <-> metadata-event integration seam
 * (`agent_run_id`/`agent_run_name` present under a scope, absent outside).
 *
 * Fully offline; the reporter's `fetch` is mocked. Everything here exercises the
 * Node entry (`src/node.ts`), which installs the ALS-backed reader into the core seam.
 */

import { describe, expect, it, vi } from "vitest";
import { SolwynError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { currentRun, currentRunContext, newRunId, run } from "../../src/node";
import { getCurrentRun } from "../../src/run-context";
import type { FetchLike } from "../../src/transport";

const API_KEY = `sk_proj_${"a".repeat(64)}`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// newRunId.
// ---------------------------------------------------------------------------

describe("newRunId", () => {
  it("starts with the literal 'run_' prefix", () => {
    expect(newRunId().startsWith("run_")).toBe(true);
  });

  it("has the exact shape of 'run_' + a canonical UUID (40 chars, '-' at index 12)", () => {
    const id = newRunId();
    expect(id).toHaveLength(40);
    expect(id[12]).toBe("-");
    expect(id.length).toBeLessThanOrEqual(255);
  });

  it("produces 100 distinct values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newRunId()));
    expect(ids.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// run(name, fn) scoping.
// ---------------------------------------------------------------------------

describe("run — callback scoping (D4)", () => {
  it("currentRun() is undefined outside any scope", () => {
    expect(currentRun()).toBeUndefined();
    expect(getCurrentRun()).toBeUndefined();
  });

  it("binds a stable, correctly-prefixed run id + name for the scope body", () => {
    const observed = run("my-run", () => currentRun());
    expect(observed?.agentRunName).toBe("my-run");
    expect(observed?.agentRunId.startsWith("run_")).toBe(true);
  });

  it("returns the callback's return value", () => {
    expect(run("x", () => 42)).toBe(42);
  });

  it.each([
    ["null", null],
    ["number", 1],
    ["string", "not-a-callback"],
  ])("rejects a non-function %s callback without replacing or leaking scope", (_label, callback) => {
    run("outer", () => {
      const outer = currentRunContext();
      let caught: unknown;
      try {
        run("invalid-callback", {}, callback as unknown as () => never);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(SolwynError);
      expect(currentRunContext()).toEqual(outer);
    });
    expect(currentRunContext()).toEqual({
      agentRunId: null,
      agentRunName: null,
      tags: null,
      parentAgentRunId: null,
    });
  });

  it("the core getCurrentRun() reflects the active scope (same reader)", () => {
    const [nodeView, coreView] = run("shared", () => [currentRun(), getCurrentRun()]);
    expect(coreView).toMatchObject(nodeView ?? {});
    expect(coreView?.agentRunName).toBe("shared");
    expect(coreView?.tags).toBeNull();
    expect(coreView?.parentAgentRunId).toBeNull();
  });

  it("clears the active run after the scope exits", () => {
    run("temp", () => currentRun());
    expect(currentRun()).toBeUndefined();
  });

  it("two sequential scopes with the SAME name get different ids", () => {
    const a = run("same", () => currentRun()?.agentRunId);
    const b = run("same", () => currentRun()?.agentRunId);
    expect(a).not.toBe(b);
  });

  it("nesting: inner replaces outer, and the exact outer run is restored on inner exit", () => {
    run("outer", () => {
      const outer = currentRun();
      run("inner", () => {
        expect(currentRun()?.agentRunName).toBe("inner");
        expect(currentRun()?.agentRunId).not.toBe(outer?.agentRunId);
      });
      // Outer restored exactly (same id, same name).
      expect(currentRun()).toEqual(outer);
    });
  });

  it("propagates the exception AND resets state on the exceptional path", () => {
    expect(() =>
      run("boom", () => {
        throw new Error("body-failed");
      }),
    ).toThrow("body-failed");
    expect(currentRun()).toBeUndefined();
  });

  it("propagates the scope across an async callback's await points", async () => {
    const seen = await run("async-run", async () => {
      await delay(5);
      return currentRun()?.agentRunName;
    });
    expect(seen).toBe("async-run");
    expect(currentRun()).toBeUndefined();
  });

  it("isolates two concurrent async tasks — neither observes the other's run", async () => {
    const results: string[] = [];
    await Promise.all([
      run("task-a", async () => {
        await delay(6);
        results.push(`a:${currentRun()?.agentRunName}`);
        await delay(2);
        results.push(`a2:${currentRun()?.agentRunName}`);
      }),
      run("task-b", async () => {
        await delay(2);
        results.push(`b:${currentRun()?.agentRunName}`);
        await delay(6);
        results.push(`b2:${currentRun()?.agentRunName}`);
      }),
    ]);
    // Every observation matches the task's own run — no cross-task bleed.
    expect(results).toContain("a:task-a");
    expect(results).toContain("a2:task-a");
    expect(results).toContain("b:task-b");
    expect(results).toContain("b2:task-b");
  });
});

describe("run — tags and hierarchy", () => {
  it("returns an all-null context outside a scope and keeps currentRun identity-only", () => {
    expect(currentRunContext()).toEqual({
      agentRunId: null,
      agentRunName: null,
      tags: null,
      parentAgentRunId: null,
    });

    run("identity", { tags: { team: "platform" } }, () => {
      expect(Object.keys(currentRun() ?? {})).toEqual(["agentRunId", "agentRunName"]);
      expect(currentRun()).not.toHaveProperty("tags");
      expect(currentRun()).not.toHaveProperty("parentAgentRunId");
      expect(currentRun()).not.toHaveProperty("parent");
    });
  });

  it("supports both overloads and copies tags when entering", () => {
    expect(run("legacy", () => currentRunContext().tags)).toBeNull();
    const caller = { team: "platform" };
    run("tagged", { tags: caller }, () => {
      caller.team = "mutated";
      expect(currentRunContext().tags).toEqual({ team: "platform" });
    });
  });

  it.each([
    [
      "throwing",
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("secret-tag=value\nforged");
            },
          },
        ),
    ],
    [
      "revoked",
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
  ])("rejects a %s tag proxy with a typed, data-free error before opening scope", (_label, makeTags) => {
    let caught: unknown;
    try {
      run("hostile-tags", { tags: makeTags() as Record<string, string> }, () => undefined);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SolwynError);
    expect((caught as Error).message).toBe(
      "solwyn.run(tags) requires a plain record of string keys to string values",
    );
    expect((caught as Error).message).not.toContain("secret-tag");
    expect((caught as Error).message).not.toContain("\n");
    expect(currentRunContext()).toEqual({
      agentRunId: null,
      agentRunName: null,
      tags: null,
      parentAgentRunId: null,
    });
  });

  it("inherits additively with child precedence and can opt out without breaking hierarchy", () => {
    run("parent", { tags: { shared: "parent", parent: "kept" } }, () => {
      const parentId = currentRunContext().agentRunId;
      run("inherited", { tags: { shared: "child", child: "kept" } }, () => {
        expect(currentRunContext()).toMatchObject({
          tags: { shared: "child", child: "kept", parent: "kept" },
          parentAgentRunId: parentId,
        });
      });
      run("fresh", { tags: { child: "only" }, inheritTags: false }, () => {
        expect(currentRunContext()).toMatchObject({
          tags: { child: "only" },
          parentAgentRunId: parentId,
        });
      });
    });
  });

  it("returns defensive context tag snapshots", () => {
    run("defensive", { tags: { team: "platform" } }, () => {
      const first = currentRunContext();
      expect(first.tags).not.toBeNull();
      if (first.tags !== null) first.tags["team"] = "mutated";
      expect(currentRunContext().tags).toEqual({ team: "platform" });
      expect(currentRunContext().tags).not.toBe(first.tags);
    });
  });

  it("stores immediate parent ids for top-level, siblings, and grandchildren", () => {
    run("root", () => {
      const root = currentRunContext();
      expect(root.parentAgentRunId).toBeNull();
      const siblings: Array<string | null> = [];

      run("child-a", () => {
        const child = currentRunContext();
        siblings.push(child.parentAgentRunId);
        expect(child.parentAgentRunId).toBe(root.agentRunId);
        run("grandchild", () => {
          expect(currentRunContext().parentAgentRunId).toBe(child.agentRunId);
        });
      });
      run("child-b", () => siblings.push(currentRunContext().parentAgentRunId));
      expect(siblings).toEqual([root.agentRunId, root.agentRunId]);
    });
  });

  it("restores the exact outer frame after normal return, throw, and rejection", async () => {
    await run("outer", { tags: { outer: "value" } }, async () => {
      const outer = currentRunContext();
      run("normal", { tags: { normal: "value" } }, () => undefined);
      expect(currentRunContext()).toEqual(outer);

      expect(() =>
        run("throwing", { tags: { throwing: "value" } }, () => {
          throw new Error("sync failure");
        }),
      ).toThrow("sync failure");
      expect(currentRunContext()).toEqual(outer);

      await expect(
        run("rejecting", { tags: { rejecting: "value" } }, async () => {
          await delay(1);
          throw new Error("async failure");
        }),
      ).rejects.toThrow("async failure");
      expect(currentRunContext()).toEqual(outer);
    });
    expect(currentRunContext().agentRunId).toBeNull();
  });

  it("isolates concurrent tagged scopes", async () => {
    const observations: Array<{ name: string | null; tags: Record<string, string> | null }> = [];
    await Promise.all([
      run("scope-a", { tags: { task: "a" } }, async () => {
        await delay(5);
        observations.push({
          name: currentRunContext().agentRunName,
          tags: currentRunContext().tags,
        });
      }),
      run("scope-b", { tags: { task: "b" } }, async () => {
        await delay(1);
        observations.push({
          name: currentRunContext().agentRunName,
          tags: currentRunContext().tags,
        });
      }),
    ]);
    expect(observations).toEqual([
      { name: "scope-b", tags: { task: "b" } },
      { name: "scope-a", tags: { task: "a" } },
    ]);
  });

  it("retains a full inherited scope above the capture cap", () => {
    const parentTags = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`parent-${index}`, "value"]),
    );
    const childTags = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`child-${index}`, "value"]),
    );
    run("parent", { tags: parentTags }, () => {
      run("child", { tags: childTags }, () => {
        expect(Object.keys(currentRunContext().tags ?? {})).toHaveLength(20);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Eager name validation.
// ---------------------------------------------------------------------------

describe("run — name validation (eager, at scope open)", () => {
  it("rejects an empty name", () => {
    expect(() => run("", () => 0)).toThrow(SolwynError);
    expect(() => run("", () => 0)).toThrow(/non-empty/);
  });

  it("rejects a whitespace-only name", () => {
    expect(() => run("   ", () => 0)).toThrow(/non-empty/);
  });

  it("accepts exactly 255 chars but rejects 256", () => {
    expect(run("x".repeat(255), () => currentRun()?.agentRunName)).toHaveLength(255);
    expect(() => run("x".repeat(256), () => 0)).toThrow(/max length/);
  });

  it("rejects ASCII control characters (newline, NUL, DEL)", () => {
    for (const bad of ["a\nb", "a\x00b", "a\x7fb"]) {
      expect(() => run(bad, () => 0)).toThrow(/control characters/);
    }
  });

  it("rejects Unicode control/format/separator chars (Cc/Cf/Zl/Zp)", () => {
    // NEL (Cc), LINE SEP (Zl), PARA SEP (Zp), ZERO WIDTH SPACE (Cf), RTL OVERRIDE (Cf).
    for (const bad of ["a\u0085b", "a\u2028b", "a\u2029b", "a\u200Bb", "a\u202Eb"]) {
      expect(() => run(bad, () => 0)).toThrow(/control characters/);
    }
  });

  it("rejects a non-string name (strict type check, not duck-typing)", () => {
    expect(() => run(123 as unknown as string, () => 0)).toThrow(/requires a string/);
    expect(() => run({ strip: () => "x" } as unknown as string, () => 0)).toThrow(SolwynError);
  });

  it("leaves the outer scope uncontaminated when an inner run() is rejected", () => {
    run("outer", () => {
      const outer = currentRun();
      expect(() => run("", () => 0)).toThrow();
      expect(currentRun()).toEqual(outer);
    });
  });
});

// ---------------------------------------------------------------------------
// run <-> metadata-event integration seam.
// ---------------------------------------------------------------------------

interface CapturedEvent {
  agent_run_id?: string;
  agent_run_name?: string;
  status: string;
}

function makeClient() {
  const captured: CapturedEvent[] = [];
  const impl: FetchLike = async (_url, init) => {
    if (init?.body !== undefined && typeof init.body === "string") {
      const parsed: unknown = JSON.parse(init.body);
      if (Array.isArray(parsed)) {
        captured.push(...(parsed as CapturedEvent[]));
      }
    }
    // The valid ingest response keeps the console-backed default logger quiet.
    return new Response(JSON.stringify({ ingested: 0, rejected: [] }), { status: 202 });
  };
  const fetchMock = vi.fn(impl);
  const create = vi.fn(async (_kwargs: Record<string, unknown>) => ({
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  }));
  const fake = { chat: { completions: { create } } };
  const client = new Solwyn(fake, { apiKey: API_KEY, fetch: fetchMock });
  return { client, events: () => captured };
}

describe("run — event tagging integration", () => {
  it("tags a metadata event with the active run's id/name when issued inside run()", async () => {
    const { client, events } = makeClient();
    await run("job-42", async () => {
      await client.chat.completions.create({ model: "gpt-4o", messages: [] });
    });
    await client.close();

    const [event] = events();
    expect(event?.agent_run_name).toBe("job-42");
    expect(event?.agent_run_id?.startsWith("run_")).toBe(true);
  });

  it("omits agent_run fields entirely for a call issued outside any scope", async () => {
    const { client, events } = makeClient();
    await client.chat.completions.create({ model: "gpt-4o", messages: [] });
    await client.close();

    const [event] = events();
    expect(event).toBeDefined();
    expect("agent_run_id" in (event as object)).toBe(false);
    expect("agent_run_name" in (event as object)).toBe(false);
  });

  it("uses a run snapshot when the call is issued in-scope but reported later", async () => {
    const { client, events } = makeClient();
    // Issue the call inside the scope; the reporter flush happens on close(), outside it.
    await run("snapshot-run", async () => {
      await client.chat.completions.create({ model: "gpt-4o", messages: [] });
    });
    expect(currentRun()).toBeUndefined();
    await client.close();

    expect(events()[0]?.agent_run_name).toBe("snapshot-run");
  });
});

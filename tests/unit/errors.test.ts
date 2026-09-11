import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BudgetExceededError,
  ConfigurationError,
  CoverageMismatchError,
  ProviderUnavailableError,
  RunStoppedError,
  type RunStoppedSource,
  resolveBudgetPeriod,
  SolwynError,
  UnsupportedSurfaceError,
  UntrackedSpendSurfaceError,
  UntranslatableModelError,
  UntranslatableRequestError,
} from "../../src/errors";
import * as publicApi from "../../src/index";
import {
  RunStoppedError as PublicRunStoppedError,
  type RunStoppedSource as PublicRunStoppedSource,
  UnsupportedSurfaceError as PublicUnsupportedSurfaceError,
} from "../../src/index";

describe("SolwynError hierarchy", () => {
  it("exports UnsupportedSurfaceError from the public entry point", () => {
    expect(PublicUnsupportedSurfaceError).toBe(UnsupportedSurfaceError);
    expect(
      new PublicUnsupportedSurfaceError({ surface: "embeddings", provider: "openai" }),
    ).toBeInstanceOf(SolwynError);
  });

  it("SolwynError is the common base for every SDK exception", () => {
    const instances: SolwynError[] = [
      new BudgetExceededError({
        projectId: "proj_abc",
        budgetLimit: 100,
        currentUsage: 90,
        estimatedCost: 20,
        budgetPeriod: "daily",
        mode: "hard_deny",
      }),
      new ProviderUnavailableError("down"),
      new ConfigurationError("bad"),
      new CoverageMismatchError({ differences: ["tracked: changed [surface.example]"] }),
      new UnsupportedSurfaceError({ surface: "embeddings", provider: "openai" }),
      new UntrackedSpendSurfaceError({
        surface: "responses.create",
        token: "responses.create",
        provider: "groq",
        clientShape: "openai_sdk",
        kind: "unmetered_spend",
        capabilityScope: "operation",
        driftedFromRuleId: null,
      }),
      new UntranslatableRequestError({ source: "a", target: "b", feature: "f" }),
      new UntranslatableModelError({ model: "m", provider: "p" }),
    ];
    for (const err of instances) {
      expect(err).toBeInstanceOf(SolwynError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("a single catch on the base class intercepts every concrete subclass", () => {
    const throwers = [
      () => {
        throw new BudgetExceededError({
          projectId: null,
          budgetLimit: 1,
          currentUsage: 1,
          estimatedCost: 1,
          budgetPeriod: "monthly",
          mode: "hard_deny",
        });
      },
      () => {
        throw new ProviderUnavailableError("x");
      },
      () => {
        throw new ConfigurationError("x");
      },
      () => {
        throw new CoverageMismatchError({ differences: ["tracked: changed [surface.example]"] });
      },
      () => {
        throw new UnsupportedSurfaceError({ surface: "embeddings", provider: "openai" });
      },
      () => {
        throw new UntrackedSpendSurfaceError({
          surface: "responses.create",
          token: "responses.create",
          provider: "groq",
          clientShape: "openai_sdk",
          kind: "unmetered_spend",
          capabilityScope: "operation",
          driftedFromRuleId: null,
        });
      },
      () => {
        throw new UntranslatableRequestError({ source: "a", target: "b", feature: "f" });
      },
      () => {
        throw new UntranslatableModelError({ model: "m", provider: "p" });
      },
    ];
    for (const thrower of throwers) {
      let caught: unknown;
      try {
        thrower();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SolwynError);
    }
  });

  it("each subclass has the correct name property", () => {
    expect(new ConfigurationError("x").name).toBe("ConfigurationError");
    expect(
      new CoverageMismatchError({ differences: ["tracked: changed [surface.example]"] }).name,
    ).toBe("CoverageMismatchError");
    expect(new ProviderUnavailableError("x").name).toBe("ProviderUnavailableError");
    expect(new UnsupportedSurfaceError({ surface: "embeddings", provider: "openai" }).name).toBe(
      "UnsupportedSurfaceError",
    );
    expect(
      new UntrackedSpendSurfaceError({
        surface: "responses.create",
        token: "responses.create",
        provider: "groq",
        clientShape: "openai_sdk",
        kind: "unmetered_spend",
        capabilityScope: "operation",
        driftedFromRuleId: null,
      }).name,
    ).toBe("UntrackedSpendSurfaceError");
    expect(new UntranslatableModelError({ model: "m", provider: "p" }).name).toBe(
      "UntranslatableModelError",
    );
    expect(new UntranslatableRequestError({ source: "a", target: "b", feature: "f" }).name).toBe(
      "UntranslatableRequestError",
    );
    expect(
      new BudgetExceededError({
        projectId: null,
        budgetLimit: 1,
        currentUsage: 1,
        estimatedCost: 1,
        budgetPeriod: "daily",
        mode: "hard_deny",
      }).name,
    ).toBe("BudgetExceededError");
  });
});

describe("BudgetExceededError", () => {
  it("exposes all six inputs and builds the project message", () => {
    const err = new BudgetExceededError({
      projectId: "proj_xyz",
      budgetLimit: 100,
      currentUsage: 95,
      estimatedCost: 12,
      budgetPeriod: "daily",
      mode: "hard_deny",
    });
    expect(err.projectId).toBe("proj_xyz");
    expect(err.budgetLimit).toBe(100);
    expect(err.currentUsage).toBe(95);
    expect(err.estimatedCost).toBe(12);
    expect(err.budgetPeriod).toBe("daily");
    expect(err.mode).toBe("hard_deny");
    expect(err.message).toBe("Budget exceeded for project proj_xyz");
  });

  it("falls back to 'unknown project' in the message when projectId is null", () => {
    const err = new BudgetExceededError({
      projectId: null,
      budgetLimit: 1,
      currentUsage: 1,
      estimatedCost: 1,
      budgetPeriod: "daily",
      mode: "hard_deny",
    });
    expect(err.message).toBe("Budget exceeded for project unknown project");
  });

  it("stores whatever budgetPeriod is passed (never hardcoded to 'unknown') — D2", () => {
    const err = new BudgetExceededError({
      projectId: "proj_xyz",
      budgetLimit: 1,
      currentUsage: 1,
      estimatedCost: 1,
      budgetPeriod: "weekly",
      mode: "hard_deny",
    });
    expect(err.budgetPeriod).toBe("weekly");
  });

  it("repr surfaces the class name and key field values", () => {
    const err = new BudgetExceededError({
      projectId: "proj_xyz",
      budgetLimit: 100,
      currentUsage: 95,
      estimatedCost: 12,
      budgetPeriod: "daily",
      mode: "hard_deny",
    });
    const repr = err.toString();
    expect(repr).toContain("BudgetExceededError");
    expect(repr).toContain("100");
  });
});

describe("RunStoppedError", () => {
  it("keeps the source union closed through the package root", () => {
    type ExpectedRunStoppedSource = "server" | "local_velocity";

    expectTypeOf<RunStoppedSource>().toEqualTypeOf<ExpectedRunStoppedSource>();
    expectTypeOf<PublicRunStoppedSource>().toEqualTypeOf<ExpectedRunStoppedSource>();
    // @ts-expect-error RunStoppedSource must reject arbitrary source labels.
    const invalidSource: PublicRunStoppedSource = "control_plane";
    void invalidSource;
  });

  it("is root-exported with the exact direct Solwyn hierarchy and structural contract", () => {
    const source: RunStoppedSource = "local_velocity";
    const error = new RunStoppedError({
      agentRunId: "run_stopped_abc",
      reason: "velocity_limit",
      source,
    });

    expect(PublicRunStoppedError).toBe(RunStoppedError);
    expect(error).toBeInstanceOf(RunStoppedError);
    expect(error).toBeInstanceOf(SolwynError);
    expect(error).not.toBeInstanceOf(BudgetExceededError);
    expect(error.name).toBe("RunStoppedError");
    expect(error.message).toBe(
      "Agent run run_stopped_abc was stopped (local_velocity: velocity_limit)",
    );
    expect(error).toMatchObject({
      agentRunId: "run_stopped_abc",
      reason: "velocity_limit",
      source: "local_velocity",
    });
    expect(Object.keys(error).filter((key) => key !== "name")).toEqual([
      "agentRunId",
      "reason",
      "source",
    ]);
    expect(error).not.toHaveProperty("projectId");
    expect(error).not.toHaveProperty("estimatedCost");
    expect(error).not.toHaveProperty("budgetPeriod");
    expect(error.toString()).toBe(
      'RunStoppedError(agentRunId="run_stopped_abc", reason="velocity_limit", source="local_velocity")',
    );
  });

  it("escapes control bytes in the diagnostic message without changing structural fields", () => {
    const agentRunId = "run\0\n\x1b";
    const reason = "stop\t\r\x7f\x80\x9f";
    const error = new RunStoppedError({ agentRunId, reason, source: "server" });

    expect(error.message).toBe(
      "Agent run run\\x00\\n\\x1b was stopped (server: stop\\t\\r\\x7f\\x80\\x9f)",
    );
    expect(error).toMatchObject({ agentRunId, reason, source: "server" });
  });

  it("does not expose a superseded RunTerminatedError alias from the package root", () => {
    expect(publicApi).not.toHaveProperty("RunTerminatedError");
  });
});

describe("resolveBudgetPeriod (D2)", () => {
  it("returns the denied_by_period when present", () => {
    expect(resolveBudgetPeriod("daily")).toBe("daily");
    expect(resolveBudgetPeriod("monthly")).toBe("monthly");
  });

  it("returns 'unknown' when denied_by_period is null or undefined", () => {
    expect(resolveBudgetPeriod(null)).toBe("unknown");
    expect(resolveBudgetPeriod(undefined)).toBe("unknown");
  });
});

describe("ProviderUnavailableError", () => {
  it("legacy construction: provider/circuitState only, attempted stays null", () => {
    const err = new ProviderUnavailableError("circuit open", {
      provider: "openai",
      circuitState: "open",
    });
    expect(err.provider).toBe("openai");
    expect(err.circuitState).toBe("open");
    expect(err.attempted).toBeNull();
  });

  it("dispatch-chain construction: attempted only, provider/circuitState stay null", () => {
    const err = new ProviderUnavailableError("all failed", {
      attempted: ["openai", "anthropic"],
    });
    expect(err.attempted).toEqual(["openai", "anthropic"]);
    expect(err.provider).toBeNull();
    expect(err.circuitState).toBeNull();
  });

  it("message-only construction: all three options stay null", () => {
    const err = new ProviderUnavailableError("nothing available");
    expect(err.message).toBe("nothing available");
    expect(err.provider).toBeNull();
    expect(err.circuitState).toBeNull();
    expect(err.attempted).toBeNull();
  });
});

describe("ConfigurationError", () => {
  it("exposes field and message; field defaults to null", () => {
    expect(new ConfigurationError("bad").field).toBeNull();
    const err = new ConfigurationError("bad api key", { field: "api_key" });
    expect(err.field).toBe("api_key");
    expect(err.message).toBe("bad api key");
  });
});

describe("UntranslatableRequestError", () => {
  it("stores source/target/feature exactly as passed", () => {
    const err = new UntranslatableRequestError({
      source: "anthropic",
      target: "openai",
      feature: "anthropic.computer_use",
    });
    expect(err.source).toBe("anthropic");
    expect(err.target).toBe("openai");
    expect(err.feature).toBe("anthropic.computer_use");
  });

  it("message carries feature plus both source and target as substrings", () => {
    const err = new UntranslatableRequestError({
      source: "anthropic",
      target: "openai",
      feature: "anthropic.computer_use",
    });
    expect(err.message).toContain("anthropic.computer_use");
    expect(err.message).toContain("anthropic");
    expect(err.message).toContain("openai");
  });
});

describe("UntranslatableModelError", () => {
  it("stores model/provider and both appear in the message", () => {
    const err = new UntranslatableModelError({ model: "gpt-4o", provider: "anthropic" });
    expect(err.model).toBe("gpt-4o");
    expect(err.provider).toBe("anthropic");
    expect(err.message).toContain("gpt-4o");
    expect(err.message).toContain("anthropic");
  });
});

describe("UntrackedSpendSurfaceError", () => {
  it("exposes only the content-free structural decision fields", () => {
    const error = new UntrackedSpendSurfaceError({
      surface: "responses.create",
      token: "responses.create",
      provider: "groq",
      clientShape: "openai_sdk",
      kind: "unmetered_spend",
      capabilityScope: "operation",
      driftedFromRuleId: "surface.responses-create.metered.openai",
    });

    expect(error).toMatchObject({
      surface: "responses.create",
      token: "responses.create",
      provider: "groq",
      clientShape: "openai_sdk",
      kind: "unmetered_spend",
      capabilityScope: "operation",
      driftedFromRuleId: "surface.responses-create.metered.openai",
    });
    expect(error.message).toContain("surface='responses.create'");
    expect(error.message).toContain("provider='groq'");
    expect(error.message).toContain("clientShape='openai_sdk'");
    expect(error.message).toContain("kind='unmetered_spend'");
    expect(error.message).toContain("capabilityScope='operation'");
    expect(error.message).toContain("driftedFromRuleId='surface.responses-create.metered.openai'");
    expect(error.message).toContain("acknowledge exact token 'responses.create'");
    expect(error.message).toContain("on_unmetered='warn'");
    expect(error.message).toContain("on_unmetered='allow'");
    expect(error).toBeInstanceOf(SolwynError);
  });

  it("guides unknown terminals without advertising an acknowledgement token", () => {
    const error = new UntrackedSpendSurfaceError({
      surface: "future.create",
      token: "do-not-advertise-this-token",
      provider: "openai",
      clientShape: "undeclared_sdk",
      kind: "unknown",
      capabilityScope: null,
      driftedFromRuleId: null,
    });

    expect(error.token).toBe("do-not-advertise-this-token");
    expect(error.capabilityScope).toBeNull();
    expect(error.driftedFromRuleId).toBeNull();
    expect(error.message).toContain(
      "review the provider graph and acknowledge an exact terminal capability token",
    );
    expect(error.message).not.toContain("exact terminal 'future.create'");
    expect(error.message).not.toContain("do-not-advertise-this-token");
    expect(error.message).not.toContain("acknowledge exact token");
    expect(error.message).toContain("on_unmetered='warn'");
    expect(error.message).toContain("on_unmetered='allow'");
  });
});

describe("CoverageMismatchError", () => {
  it("detaches and freezes nonempty differences with the exact joined message", () => {
    const differences = [
      "tracked: expected 2 entries, got 1, missing [surface.chat]",
      "unknown: fingerprint mismatch (expected sha256:aaa, got sha256:bbb, entries 3)",
    ];
    const error = new CoverageMismatchError({ differences });
    differences[0] = "changed by caller";
    differences.push("later");

    expect(error.differences).toEqual([
      "tracked: expected 2 entries, got 1, missing [surface.chat]",
      "unknown: fingerprint mismatch (expected sha256:aaa, got sha256:bbb, entries 3)",
    ]);
    expect(Object.isFrozen(error.differences)).toBe(true);
    expect(error.message).toBe(
      "coverage expectation mismatch: tracked: expected 2 entries, got 1, missing " +
        "[surface.chat]; unknown: fingerprint mismatch (expected sha256:aaa, got sha256:bbb, " +
        "entries 3)",
    );
    expect(error).toBeInstanceOf(SolwynError);
  });

  it.each([
    ["null options", null],
    ["missing differences", {}],
    ["null differences", { differences: null }],
    ["non-array differences", { differences: "tracked: mismatch" }],
    ["empty differences", { differences: [] }],
    ["non-string member", { differences: [1] }],
    ["empty member", { differences: [""] }],
    ["blank member", { differences: ["   "] }],
  ])("rejects %s with the exact TypeError invariant", (_label, input) => {
    let caught: unknown;
    try {
      new CoverageMismatchError(input as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe("coverage mismatch requires at least one difference");
  });

  it("rejects a sparse differences array with the exact TypeError invariant", () => {
    let caught: unknown;
    try {
      new CoverageMismatchError({ differences: new Array(1) as string[] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe("coverage mismatch requires at least one difference");
  });

  it("copies indexed values without invoking a hostile iterator getter", () => {
    let iteratorReads = 0;
    const differences = ["tracked: mismatch"];
    Object.defineProperty(differences, Symbol.iterator, {
      get() {
        iteratorReads += 1;
        throw new Error("PRIVATE_ITERATOR_CONTENT");
      },
    });

    const error = new CoverageMismatchError({ differences });

    expect(iteratorReads).toBe(0);
    expect(error.differences).toEqual(["tracked: mismatch"]);
    expect(Object.isFrozen(error.differences)).toBe(true);
  });

  it("rejects an accessor-backed index without invoking or leaking it", () => {
    let indexReads = 0;
    const differences = new Array(1) as string[];
    Object.defineProperty(differences, "0", {
      enumerable: true,
      get() {
        indexReads += 1;
        throw new Error("PRIVATE_INDEX_CONTENT");
      },
    });

    let caught: unknown;
    try {
      new CoverageMismatchError({ differences });
    } catch (error) {
      caught = error;
    }

    expect(indexReads).toBe(0);
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe("coverage mismatch requires at least one difference");
    expect((caught as Error).message).not.toContain("PRIVATE_INDEX_CONTENT");
  });

  it.each([
    [
      "descriptor trap",
      () =>
        new Proxy(["tracked: mismatch"], {
          getOwnPropertyDescriptor() {
            throw new Error("PRIVATE_DESCRIPTOR_CONTENT");
          },
        }),
    ],
    [
      "revoked proxy",
      () => {
        const revocable = Proxy.revocable<string[]>(["tracked: mismatch"], {});
        revocable.revoke();
        return revocable.proxy;
      },
    ],
  ])("normalizes a %s to the fixed TypeError", (_label, buildDifferences) => {
    let caught: unknown;
    try {
      new CoverageMismatchError({ differences: buildDifferences() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe("coverage mismatch requires at least one difference");
    expect((caught as Error).message).not.toContain("PRIVATE_DESCRIPTOR_CONTENT");
  });
});

describe("keyword-only / no-content-smuggling (compile-time parity)", () => {
  it("rejects positional args and content-smuggling extra keys at the type level", () => {
    // @ts-expect-error UntranslatableRequestError is keyword-only — no positional args.
    void new UntranslatableRequestError("openai", "anthropic", "response_format");
    // @ts-expect-error the options type is exact — an extra `value` key (content) is rejected.
    void new UntranslatableRequestError({ source: "a", target: "b", feature: "f", value: "x" });
    // @ts-expect-error UntranslatableModelError is also keyword-only.
    void new UntranslatableModelError("m", "p");
    void new UntrackedSpendSurfaceError({
      surface: "future.create",
      token: null,
      provider: "openai",
      clientShape: "openai_sdk",
      kind: "unknown",
      capabilityScope: null,
      driftedFromRuleId: null,
      // @ts-expect-error untracked-surface errors cannot carry provider response data.
      response: "x",
    });
    const invalidPositionalCoverageConstructor = () => {
      // @ts-expect-error CoverageMismatchError requires one options object.
      return new CoverageMismatchError(["tracked: mismatch"]);
    };
    expect(invalidPositionalCoverageConstructor).toBeTypeOf("function");
    expect(true).toBe(true);
  });
});

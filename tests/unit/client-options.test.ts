import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import type { SolwynOptions } from "../../src/client";
import { ConfigurationError } from "../../src/errors";
import { Solwyn } from "../../src/index";
import { MetadataReporter } from "../../src/reporter";

afterEach(() => vi.restoreAllMocks());

describe("constructor shape validation", () => {
  it.each([
    ["options", null],
    ["options", 5],
    ["options", []],
    ["fallback", {}],
    ["fallback", 5],
    ["fallback", null],
    ["model", 5],
    ["model", {}],
    ["model", null],
    ["logger", 5],
    ["logger", {}],
    ["logger", { debug() {}, info() {}, warn() {}, error: 5 }],
    ["selectionPolicy", {}],
    ["selectionPolicy", 5],
    ["selectionPolicy", { order: 5 }],
  ])("rejects invalid %s before starting resources (%j)", (field, value) => {
    const start = vi.spyOn(MetadataReporter.prototype, "start").mockImplementation(() => {});
    const check = vi.spyOn(BudgetEnforcer.prototype, "checkBudget");
    const create = vi.fn();
    const raw = { chat: { completions: { create } } };
    const options =
      field === "options"
        ? value
        : { apiKey: `sk_proj_${"0".repeat(64)}`, [field as string]: value };
    let caught: unknown;
    try {
      new Solwyn(raw, options as SolwynOptions);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect(caught).toMatchObject({ field });
    expect(start).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

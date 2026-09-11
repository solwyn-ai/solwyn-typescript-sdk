import { describe, expect, it } from "vitest";
import { estimateResponsesContentLength } from "../../src/privacy";

describe("estimateResponsesContentLength", () => {
  it("counts a string input", () => {
    expect(estimateResponsesContentLength({ input: "hello" })).toBe(5);
  });

  it("adds instructions to string input", () => {
    expect(estimateResponsesContentLength({ instructions: "abc", input: "hello" })).toBe(8);
  });

  it("counts item string content", () => {
    expect(estimateResponsesContentLength({ input: [{ content: "abc" }] })).toBe(3);
  });

  it("counts only text objects from item content parts", () => {
    expect(
      estimateResponsesContentLength({
        input: [{ content: [{ text: "four" }, { image_url: "ignored" }, "skip"] }],
      }),
    ).toBe(4);
  });

  it("counts item string output", () => {
    expect(estimateResponsesContentLength({ input: [{ output: "abc" }] })).toBe(3);
  });

  it("counts only text objects from item output parts", () => {
    expect(
      estimateResponsesContentLength({ input: [{ output: [{ text: "xyz" }, { text: 2 }] }] }),
    ).toBe(3);
  });

  it("counts string content/output and text parts from input items", () => {
    expect(
      estimateResponsesContentLength({
        input: [
          { content: "abc", output: "de" },
          {
            content: [{ text: "four" }, { type: "input_image", image_url: "ignored" }, "skip"],
            output: [{ text: "xyz" }, { text: 42 }, { file_id: "ignored" }],
          },
        ],
      }),
    ).toBe(12);
  });

  it("ignores malformed, nontext, media, unknown, and bare-list values", () => {
    expect(
      estimateResponsesContentLength({
        instructions: 123,
        input: [
          null,
          "bare string ignored",
          42,
          { content: [{ image_url: "secret" }, null, { text: false }] },
          { output: { text: "wrong container" } },
          { unknown: "ignored" },
        ],
      }),
    ).toBe(0);
  });

  it("ignores non-object input list items", () => {
    expect(estimateResponsesContentLength({ input: [null, "bare", 1, false] })).toBe(0);
  });

  it("ignores a dictionary-shaped or otherwise non-list input", () => {
    expect(estimateResponsesContentLength({ input: { content: "ignored" } })).toBe(0);
  });

  it("ignores unrecognized keys", () => {
    expect(estimateResponsesContentLength({ unknown: "ignored", output: "ignored" })).toBe(0);
  });

  it("is total over garbage top-level shapes passed by untyped callers", () => {
    expect(estimateResponsesContentLength({})).toBe(0);
    expect(estimateResponsesContentLength({ input: false, output: [] })).toBe(0);
  });
});

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the README below npm's 64 KiB limit with headroom", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url));

  expect(
    readme.byteLength,
    "npm truncates README metadata at 64 KiB; keep README.md under 60,000 bytes and move reference material to docs/.",
  ).toBeLessThan(60_000);
});

import { describe, expect, it } from "vitest";
import { run } from "../../src/node";
import { FakeControlPlane } from "../../src/testing";

describe("cache usage settlement", () => {
  for (const surface of ["chat", "responses"] as const) {
    it.each([
      false,
      true,
    ])(`debits measured ${surface} usage after cache normalization (stream=%s)`, async (streaming) => {
      const plane = new FakeControlPlane({ grantedTokens: 15_000, finalGrant: true });
      const usage =
        surface === "chat"
          ? {
              prompt_tokens: 10,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 12 },
            }
          : { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 12 } };
      const create = async (request: Record<string, unknown>) => {
        const response = { id: "synthetic", choices: [], usage };
        if (!request["stream"]) return response;
        return (async function* () {
          yield surface === "chat" ? response : { type: "response.completed", response };
        })();
      };
      const client = plane.wrap(
        { chat: { completions: { create } }, responses: { create } },
        {
          breakerReportingEnabled: false,
          reportUntrackedSurfaces: false,
        },
      );
      try {
        await run(`cache-usage-${surface}-${streaming}`, async () => {
          for (let index = 0; index < 2; index += 1) {
            const result =
              surface === "chat"
                ? await client.chat.completions.create({
                    model: "gpt-4o",
                    messages: [],
                    stream: streaming,
                  })
                : await client.responses.create({ model: "gpt-4o", input: "", stream: streaming });
            if (streaming)
              for await (const _chunk of result as AsyncIterable<unknown>) {
                /* Consume terminal usage. */
              }
          }
        });
      } finally {
        await client.close();
      }

      expect(plane.confirms).toHaveLength(2);
      expect(plane.ingested).toHaveLength(2);
      for (const confirm of plane.confirms) {
        expect(confirm.token_details).toMatchObject({
          input_tokens: 12,
          output_tokens: 2,
          cached_input_tokens: 12,
          is_estimated: true,
        });
      }
      expect(plane.leaseSurrenders).toHaveLength(1);
      expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(28);
    });
  }
});

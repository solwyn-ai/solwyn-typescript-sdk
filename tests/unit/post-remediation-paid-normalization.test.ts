import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetEnforcer } from "../../src/budget";
import { noopLogger, Solwyn, UntranslatableRequestError } from "../../src/index";
import { run } from "../../src/node";
import { MetadataReporter } from "../../src/reporter";
import { FakeControlPlane } from "../../src/testing";
import type { BudgetConfirmRequest, MetadataEvent } from "../../src/types";

afterEach(() => vi.restoreAllMocks());

describe("post-remediation finding 3: paid normalization ownership", () => {
  for (const lease of [false, true]) {
    for (const malformed of [false, true]) {
      it.each([
        "delivered",
        "rejected",
        "enqueue failure",
        "construction failure",
      ] as const)(`retains measured paid usage (lease=${lease}, malformed=${malformed}, reporter=%s)`, async (reporting) => {
        const plane = new FakeControlPlane({ grantedTokens: 512, finalGrant: true });
        const attemptedConfirms: BudgetConfirmRequest[] = [];
        const attemptedEvents: MetadataEvent[] = [];
        const fallbackResponse = {
          id: crypto.randomUUID(),
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [
            {
              type: "tool_use",
              id: crypto.randomUUID(),
              name: "structural_tool",
              input: malformed ? [] : {},
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 30, output_tokens: 20 },
        };
        let primaryCalls = 0;
        let fallbackCalls = 0;
        const client = new Solwyn(
          new OpenAI({
            apiKey: crypto.randomUUID(),
            fetch: async () => {
              primaryCalls++;
              return new Response(null, { status: 429 });
            },
          }),
          {
            apiKey: plane.apiKey,
            apiUrl: plane.apiUrl,
            fetch: async (url, init) => {
              if (url.endsWith("/budgets/confirm")) {
                attemptedConfirms.push(JSON.parse(String(init?.body)) as BudgetConfirmRequest);
                if (reporting === "rejected") return new Response(null, { status: 422 });
              }
              if (url.endsWith("/metadata/ingest"))
                attemptedEvents.push(...(JSON.parse(String(init?.body)) as MetadataEvent[]));
              return plane.fetch(url, init);
            },
            logger: noopLogger,
            leaseEnabled: lease,
            reporterMaxSendAttempts: 1,
            breakerReportingEnabled: false,
            reportUntrackedSurfaces: false,
            fallback: [
              [
                new Anthropic({
                  apiKey: crypto.randomUUID(),
                  fetch: async () => {
                    fallbackCalls++;
                    return Response.json(fallbackResponse);
                  },
                }),
                "claude-sonnet-4-5",
              ],
            ],
          },
        );
        if (reporting === "enqueue failure") {
          vi.spyOn(MetadataReporter.prototype, "reportSettlement").mockImplementation(() => {
            throw new Error();
          });
        }
        if (reporting === "construction failure") {
          vi.spyOn(BudgetEnforcer.prototype, "buildConfirmRequest").mockImplementation(() => {
            throw new Error();
          });
        }
        try {
          await run("paid-normalization", async () => {
            const paid = client.chat.completions.create({
              model: "gpt-4o",
              messages: [],
              max_tokens: 128,
            });
            if (malformed) await expect(paid).rejects.toBeInstanceOf(UntranslatableRequestError);
            else {
              const result = await paid;
              expect(result.choices[0]?.finish_reason).toBe("tool_calls");
              expect(result.choices[0]?.message.tool_calls?.length).toBe(1);
            }
          });
        } finally {
          await client.close();
          await client.close();
          await client[Symbol.asyncDispose]();
        }
        expect(primaryCalls).toBe(1);
        expect(fallbackCalls).toBe(1);
        const confirmExpected = reporting === "delivered" || reporting === "rejected";
        expect(attemptedConfirms).toHaveLength(confirmExpected ? 1 : 0);
        expect(plane.confirms).toHaveLength(reporting === "delivered" ? 1 : 0);
        if (confirmExpected) {
          expect(attemptedConfirms[0]).toMatchObject({
            model: "claude-sonnet-4-5",
            provider: "anthropic",
            is_provider_fallback: true,
            token_details: { input_tokens: 30, output_tokens: 20 },
          });
          expect(attemptedConfirms[0]?.token_details?.is_estimated === true).toBe(false);
          expect(Boolean(attemptedConfirms[0]?.lease_id)).toBe(lease);
          expect(Boolean(attemptedConfirms[0]?.reservation_id)).toBe(!lease);
        }
        const paidEvents = plane.ingested.filter((event) => event.provider === "anthropic");
        expect(attemptedEvents.filter((event) => event.provider === "anthropic")).toHaveLength(1);
        expect(paidEvents).toHaveLength(1);
        expect(paidEvents[0]).toMatchObject({
          status: malformed ? "error" : "success",
          input_tokens: 30,
          output_tokens: 20,
          token_details: { input_tokens: 30, output_tokens: 20, is_estimated: false },
          attempt_index: 1,
          is_provider_fallback: true,
        });
        expect(paidEvents[0]?.failover_error_class ?? null).toBe(
          malformed ? "UntranslatableRequestError" : null,
        );
        expect(paidEvents[0]?.failover_reason ?? null).toBe(malformed ? null : "primary_error");
        if (confirmExpected) expect(paidEvents[0]?.call_id).toBe(attemptedConfirms[0]?.call_id);
        expect(plane.ingested.filter((event) => event.provider === "openai")).toHaveLength(1);
        expect(plane.leaseSurrenders).toHaveLength(lease ? 1 : 0);
        if (lease) {
          expect(plane.leaseSurrenders[0]?.spent_tokens).toBe(
            reporting === "construction failure" ? 128 : 50,
          );
        }
      });
    }
  }
});

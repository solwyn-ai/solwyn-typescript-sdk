import { Agent, OpenAIProvider, Runner, setDefaultOpenAIClient } from "@openai/agents";
import OpenAI from "openai";
import { Solwyn } from "../../../src/node";
import { SolwynAgents, solwynToolErrorFunction } from "../../../src/openai-agents/index";

const client = new Solwyn(new OpenAI({ maxRetries: 0 }), { apiKey: "synthetic-unused" });
setDefaultOpenAIClient(client as unknown as OpenAI);
const integration = new SolwynAgents({ client, OpenAIProvider });
const runner = new Runner({ modelProvider: integration.modelProvider, tracingDisabled: true });
const agent = new Agent({ name: "Worker", model: "gpt-4.1-mini" });
const result = await integration.run(runner, agent, "Synthetic input.", { workflow: "workflow" });
const text: string | undefined = result.finalOutput;
const stream = await integration.runStreamed(runner, agent, "Synthetic input.", {
  workflow: "workflow",
});
const streamedText: string | undefined = stream.finalOutput;
const fallback: string = solwynToolErrorFunction(undefined, new Error("synthetic failure"));
void [text, streamedText, fallback];

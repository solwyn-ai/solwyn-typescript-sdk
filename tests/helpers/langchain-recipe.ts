import type { ChatOpenAICompletions as Completions } from "@langchain/openai";
import { SolwynError } from "../../src/errors";
import type { SolwynRunScopeHandler } from "../../src/langchain/index";

/** The complete documented shim is separately compiled and executed. */
export async function recipeModel(
  client: object,
  handler: SolwynRunScopeHandler,
  options: Record<string, unknown> = {},
) {
  const { ChatOpenAI, ChatOpenAICompletions, ChatOpenAIResponses } = await import(
    "@langchain/openai"
  );
  const leaf = handler.chatCompletionsLeaf(client);
  class Metered extends ChatOpenAICompletions {
    constructor(fields: ConstructorParameters<typeof ChatOpenAICompletions>[0]) {
      super(fields);
      this.client = leaf as typeof this.client;
    }
    override _generate(...[opaque, callOptions, manager]: Parameters<Completions["_generate"]>) {
      return super._generate(opaque, handler.bindModelCall(callOptions, manager), manager);
    }
    override _streamResponseChunks(
      ...[opaque, callOptions, manager]: Parameters<Completions["_streamResponseChunks"]>
    ) {
      return super._streamResponseChunks(
        opaque,
        handler.bindModelCall(callOptions, manager),
        manager,
      );
    }
    // biome-ignore lint/correctness/useYield: typed refusal before any provider dispatch.
    override async *_streamChatModelEvents(): AsyncGenerator<never> {
      throw new SolwynError("LangChain chat-model stream events are not admitted");
    }
  }
  class RefuseResponses extends ChatOpenAIResponses {
    override async _generate(): Promise<never> {
      throw new SolwynError("LangChain Responses API is not admitted");
    }
    // biome-ignore lint/correctness/useYield: typed refusal before any provider dispatch.
    override async *_streamResponseChunks(): AsyncGenerator<never> {
      throw new SolwynError("LangChain Responses API is not admitted");
    }
    // biome-ignore lint/correctness/useYield: typed refusal before any provider dispatch.
    override async *_streamChatModelEvents(): AsyncGenerator<never> {
      throw new SolwynError("LangChain Responses API is not admitted");
    }
  }
  const fields = {
    model: "gpt-4.1-mini",
    apiKey: "synthetic-unused",
    useResponsesApi: false,
    maxRetries: 0,
    configuration: {
      fetch: () => Promise.reject(new SolwynError("Unmetered LangChain client refused")),
    },
    ...options,
  };
  return new ChatOpenAI({
    ...fields,
    completions: new Metered(fields),
    responses: new RefuseResponses(fields),
  });
}

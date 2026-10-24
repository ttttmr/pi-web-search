import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getProviderKind } from "./config.ts";
import { ANTHROPIC_SEARCH_TOOL, createAnthropicSearchStream } from "./anthropic.ts";
import { createGoogleSearchStream } from "./google.ts";
import { createOpenAISearchStream, getOpenAISearchOptions } from "./openai.ts";
import type { StreamResult } from "./types.ts";

export async function callVirtualSearch(
    ctx: ExtensionContext,
    model: Model<Api>,
    prompt: string,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
    thinkingLevel?: ModelThinkingLevel,
    urls?: string[]
): Promise<StreamResult> {
    let stream: ReturnType<typeof createOpenAISearchStream | typeof createAnthropicSearchStream | typeof createGoogleSearchStream> | undefined;
    const options = {
        signal,
        sessionId: ctx.sessionManager.getSessionId(),
        reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
        // Search requests are independent of the main conversation's cached continuation.
        transport: "sse" as const,
        onPayload(payload: any, target: Model<Api>) {
            // A provider can retry with another account; each attempt owns its search metadata.
            const kind = getProviderKind(target);
            if (kind === "openai" || kind === "xai") {
                stream = createOpenAISearchStream(target, onUpdate);
                const request = { ...payload, ...getOpenAISearchOptions(target), store: false };
                if (kind === "xai") delete request.reasoning;
                return request;
            }
            if (kind === "anthropic") {
                stream = createAnthropicSearchStream(onUpdate);
                return { ...payload, tools: [ANTHROPIC_SEARCH_TOOL] };
            }
            if (target.api === "google-generative-ai") {
                stream = createGoogleSearchStream(onUpdate, signal);
                return {
                    ...payload,
                    config: {
                        ...payload.config,
                        tools: [{ googleSearch: {} }, ...(urls?.length ? [{ urlContext: {} }] : [])],
                    },
                };
            }
            throw new Error(`Virtual model ${model.provider}/${model.id} routed to an unsupported search model: ${target.provider}/${target.id} (${target.api})`);
        },
        onProviderStreamEvent(event: unknown) {
            stream?.onEvent(event);
        },
    };
    const response = await ctx.modelRegistry.streamSimple(model, {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, options).result();

    if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage || "Web search request failed");
    }
    if (!stream) throw new Error("The routed provider did not expose its search request");
    return { ...await stream.result(), usage: response.usage };
}

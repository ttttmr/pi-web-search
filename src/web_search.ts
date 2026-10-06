import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { callApiStream, getConfig } from "./api.ts";
import { formatWebSearchResult } from "./format.ts";
import { getWebSearchModel, getWebSearchThinkingLevel, missingWebSearchConfigResult, errorResult } from "./utils.ts";

export const WebSearchSchema = Type.Object({
    query: Type.String({ description: "The search query or question to answer" }),
    urls: Type.Optional(Type.Array(Type.String(), { 
        description: "Additional URLs to analyze along with search (up to 20)",
        maxItems: 20
    })),
});
export type WebSearchInput = Static<typeof WebSearchSchema>;

export async function webSearch(
    id: string, 
    params: WebSearchInput, 
    signal: AbortSignal,
    onUpdate: AgentToolUpdateCallback | undefined, 
    ctx: ExtensionContext,
    thinkingLevel?: ModelThinkingLevel
) {
    const model = await getWebSearchModel(ctx);
    if (!model) return missingWebSearchConfigResult(ctx);

    const hasUrls = params.urls && params.urls.length > 0;
    const urlCount = hasUrls ? params.urls!.length : 0;
    
    onUpdate?.({ 
        content: [{ 
            type: "text", 
            text: hasUrls 
                ? `Searching and analyzing ${urlCount} URL(s)...` 
                : `Searching for "${params.query}"...`
        }], 
        details: {} 
    });

    try {
        const config = getConfig(model);

        // Build prompt: include URLs if provided. Ollama receives the URL list as
        // a separate argument (its search is a REST endpoint, not a model tool),
        // so the prompt stays a clean query.
        const prompt = hasUrls && config.kind !== "ollama"
            ? `${params.query}\n\nAlso analyze these URLs:\n${params.urls!.join("\n")}`
            : params.query;

        // Enable provider-native search tools. Google needs explicit Gemini tool names;
        // OpenAI/Anthropic are handled inside callApiStream based on the current model.
        const tools = config.kind === "google"
            ? (hasUrls
                ? [{ [config.searchTool!]: {} }, { [config.urlContextTool!]: {} }]
                : [{ [config.searchTool!]: {} }])
            : undefined;

        const result = await callApiStream(ctx, model, {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            ...(tools ? { tools } : {})
        }, onUpdate, signal, getWebSearchThinkingLevel(thinkingLevel), params.urls);

        return formatWebSearchResult(result, { modelId: model.id });
    } catch (e: any) {
        return errorResult(e);
    }
}

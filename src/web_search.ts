import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { callApiStream, getConfig } from "./api.ts";
import { formatWebSearchResult } from "./format.ts";
import { resolveWebSearchModel, webSearchModelError, errorResult } from "./utils.ts";

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
    const resolved = await resolveWebSearchModel(ctx);
    if (resolved.status !== "ok") return webSearchModelError(ctx, resolved);
    const model = resolved.model;

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

        // Build prompt: include URLs if provided. Ollama and DeepSeek receive
        // the URL list as a separate argument (their search is a REST endpoint,
        // not a model tool), so the prompt stays a clean query.
        const prompt = hasUrls && config.kind !== "ollama" && config.kind !== "deepseek"
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
        }, onUpdate, signal, resolved.thinkingLevel ?? thinkingLevel, params.urls);

        return formatWebSearchResult(result, { modelId: model.id });
    } catch (e: any) {
        return errorResult(e);
    }
}

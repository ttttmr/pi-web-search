import type { ExtensionContext, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { callApiStream, getConfig, applyCitations } from "./api.js";
import { getModel, missingConfigResult, errorResult, formatResult } from "./utils.js";

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
    ctx: ExtensionContext
) {
    const model = await getModel(ctx);
    if (!model) return missingConfigResult(ctx);

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
        
        // Build prompt: include URLs if provided
        const prompt = hasUrls
            ? `${params.query}\n\nAlso analyze these URLs:\n${params.urls!.join("\n")}`
            : params.query;

        // Enable google_search, add url_context if URLs provided
        const tools = hasUrls
            ? [{ [config.searchTool]: {} }, { [config.urlContextTool]: {} }]
            : [{ [config.searchTool]: {} }];

        const result = await callApiStream(ctx, model, {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            tools
        }, onUpdate);

        const { text, sources } = applyCitations(result.text, result.groundingMetadata);

        // Handle URL context metadata
        const urlMeta = result.urlContextMetadata?.urlMetadata 
            || result.urlContextMetadata?.url_metadata || [];

        const retrieved = urlMeta
            .filter((m: any) => (m.urlRetrievalStatus || m.url_retrieval_status) === "URL_RETRIEVAL_STATUS_SUCCESS")
            .map((m: any) => m.retrievedUrl || m.retrieved_url || m.url);

        const failed = urlMeta
            .filter((m: any) => (m.urlRetrievalStatus || m.url_retrieval_status) !== "URL_RETRIEVAL_STATUS_SUCCESS")
            .map((m: any) => ({ 
                url: m.retrievedUrl || m.retrieved_url || m.url, 
                status: m.urlRetrievalStatus || m.url_retrieval_status 
            }));

        let summary = text;
        
        // Add URL status if there were failures
        if (failed.length > 0) {
            summary += `\n\n## URL Status\n✅ Retrieved: ${retrieved.length}\n❌ Failed: ${failed.length}`;
            failed.forEach((f: any) => { summary += `\n- ${f.url}: ${f.status}`; });
        }

        // Add sources
        if (sources.length > 0) {
            summary += `\n\n## Sources\n${sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`;
        }

        return formatResult(summary, {
            sources,
            searchQueries: result.groundingMetadata?.webSearchQueries,
            retrieved: retrieved.length > 0 ? retrieved : undefined,
            failed: failed.length > 0 ? failed : undefined,
            model: model.id,
            grounded: sources.length > 0
        });
    } catch (e: any) {
        return errorResult(e);
    }
}

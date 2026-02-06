import type { ExtensionContext, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { callApiStream, getConfig, applyCitations } from "./api.js";
import { getModel, missingConfigResult, errorResult, formatResult } from "./utils.js";

export const UrlContextSchema = Type.Object({
    query: Type.String({ description: "Question or task to perform on the URLs" }),
    urls: Type.Array(Type.String(), { 
        description: "URLs to analyze (up to 20). Supports text/html, PDF, images, JSON, CSV, etc.",
        minItems: 1,
        maxItems: 20
    }),
});
export type UrlContextInput = Static<typeof UrlContextSchema>;

export async function urlContext(
    id: string, 
    params: UrlContextInput, 
    signal: AbortSignal, 
    onUpdate: AgentToolUpdateCallback | undefined, 
    ctx: ExtensionContext
) {
    const model = await getModel(ctx);
    if (!model) return missingConfigResult(ctx);

    const count = params.urls.length;
    onUpdate?.({ content: [{ type: "text", text: `Analyzing ${count} URL${count > 1 ? 's' : ''}...` }], details: {} });

    try {
        const config = getConfig(model);
        const combinedPrompt = `${params.query}\n\nURLs:\n${params.urls.join("\n")}`;

        const result = await callApiStream(ctx, model, {
            contents: [{ role: "user", parts: [{ text: combinedPrompt }] }],
            tools: [{ [config.urlContextTool]: {} }]
        }, onUpdate);

        const { text, sources } = applyCitations(result.text, result.groundingMetadata);
        
        // Handle both camelCase and snake_case metadata
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
        if (failed.length > 0) {
            summary += `\n\n## URL Status\n✅ Retrieved: ${retrieved.length}\n❌ Failed: ${failed.length}`;
            failed.forEach((f: any) => { summary += `\n- ${f.url}: ${f.status}`; });
        }
        if (sources.length > 0 && !summary.includes("## Sources")) {
            summary += `\n\n## Sources\n${sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`;
        }

        return formatResult(summary, {
            retrieved,
            failed: failed.length > 0 ? failed : undefined,
            model: model.id
        });
    } catch (e: any) {
        return errorResult(e);
    }
}

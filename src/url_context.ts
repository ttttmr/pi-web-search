import type { ExtensionContext, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { callApiStream, getConfig, applyCitations } from "./api.js";
import { getModel, missingConfigResult, errorResult, formatResult } from "./utils.js";

export const UrlContextSchema = Type.Object({
    query: Type.String({ description: "Question or task to perform on the URLs" }),
    urls: Type.Array(Type.String(), { 
        description: "Public URLs to analyze (web pages, documents, images, YouTube videos, etc).",
        minItems: 1,
        maxItems: 20
    }),
});
export type UrlContextInput = Static<typeof UrlContextSchema>;

const YOUTUBE_REGEX = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

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
        
        let contents: any[] = [];
        let tools: any[] | undefined = [{ [config.urlContextTool]: {} }];

        // Special handling for YouTube videos on Gemini
        if (model.api === "google-generative-ai") {
            const youtubeUrls: string[] = [];
            const otherUrls: string[] = [];

            for (const url of params.urls) {
                if (YOUTUBE_REGEX.test(url)) {
                    youtubeUrls.push(url);
                } else {
                    otherUrls.push(url);
                }
            }

            // If we have YouTube URLs, construct file_data parts
            if (youtubeUrls.length > 0) {
                const parts: any[] = [];
                
                for (const url of youtubeUrls) {
                    parts.push({
                        file_data: { file_uri: url, mime_type: "video/mp4" }
                    });
                }

                let prompt = params.query;
                if (otherUrls.length > 0) {
                    prompt += `\n\nURLs:\n${otherUrls.join("\n")}`;
                } else {
                    // If no other URLs, we might not need the tool, but keep it just in case
                    // or maybe the tool is required for grounding even with video?
                    // "google_search_retrieval" tool might confuse if there are no URLs to retrieve.
                    // But if we remove the tool, we might lose grounding capabilities (like search).
                    // Let's keep the tool enabled.
                }

                parts.push({ text: prompt });
                contents = [{ role: "user", parts }];
            } else {
                // No YouTube URLs, standard behavior
                const combinedPrompt = `${params.query}\n\nURLs:\n${params.urls.join("\n")}`;
                contents = [{ role: "user", parts: [{ text: combinedPrompt }] }];
            }
        } else {
            // Not Gemini, standard behavior
            const combinedPrompt = `${params.query}\n\nURLs:\n${params.urls.join("\n")}`;
            contents = [{ role: "user", parts: [{ text: combinedPrompt }] }];
        }

        const result = await callApiStream(ctx, model, {
            contents,
            tools
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

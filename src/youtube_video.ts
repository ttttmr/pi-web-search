import type { ExtensionContext, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { callApiStream } from "./api.js";
import { getModel, missingConfigResult, errorResult, formatResult } from "./utils.js";
import { urlContext } from "./url_context.js";

export const YoutubeVideoSchema = Type.Object({
    video_url: Type.String({ description: "YouTube video URL" }),
    query: Type.String({ description: "Question or task about the video" }),
    start_offset: Type.Optional(Type.String({ description: "Start time (e.g., '120s' or '2:00')" })),
    end_offset: Type.Optional(Type.String({ description: "End time (e.g., '300s' or '5:00')" })),
});
export type YoutubeVideoInput = Static<typeof YoutubeVideoSchema>;

export async function youtubeVideo(
    id: string, 
    params: YoutubeVideoInput, 
    signal: AbortSignal, 
    onUpdate: AgentToolUpdateCallback | undefined, 
    ctx: ExtensionContext
) {
    const model = await getModel(ctx);
    if (!model) return missingConfigResult(ctx);

    // Only google-generative-ai supports native video; others use URL context
    if (model.api !== "google-generative-ai") {
        let query = params.query;
        if (params.start_offset || params.end_offset) {
            query += "\n\nFocus on the video section";
            if (params.start_offset) query += ` from ${params.start_offset}`;
            if (params.end_offset) query += ` to ${params.end_offset}`;
            query += ".";
        }
        return urlContext(id, { query, urls: [params.video_url] }, signal, onUpdate, ctx);
    }

    onUpdate?.({ content: [{ type: "text", text: `Analyzing YouTube video...` }], details: {} });

    try {
        const videoPart: any = {
            file_data: { file_uri: params.video_url, mime_type: "video/mp4" }
        };

        if (params.start_offset || params.end_offset) {
            videoPart.video_metadata = {};
            if (params.start_offset) videoPart.video_metadata.start_offset = params.start_offset;
            if (params.end_offset) videoPart.video_metadata.end_offset = params.end_offset;
        }

        const result = await callApiStream(ctx, model, {
            contents: [{ role: "user", parts: [videoPart, { text: params.query }] }]
        }, onUpdate);

        return formatResult(result.text, {
            videoUrl: params.video_url,
            clipping: (params.start_offset || params.end_offset) 
                ? { start: params.start_offset, end: params.end_offset } 
                : undefined,
            model: model.id
        });
    } catch (e: any) {
        return errorResult(e);
    }
}

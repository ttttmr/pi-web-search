import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { webSearch, WebSearchSchema } from "./web_search.js";
import { urlContext, UrlContextSchema } from "./url_context.js";
import { youtubeVideo, YoutubeVideoSchema } from "./youtube_video.js";

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "web_search",
        label: "Web Search",
        description: "Search the web using Google Gemini's grounding. Optionally include URLs to analyze alongside search results.",
        parameters: WebSearchSchema,
        execute: webSearch
    });

    pi.registerTool({
        name: "url_context",
        label: "URL Context",
        description: "Analyze web pages and documents. Extract data, compare documents, synthesize content. Supports text/html, PDF, images, JSON, CSV. Up to 20 URLs.",
        parameters: UrlContextSchema,
        execute: urlContext
    });

    pi.registerTool({
        name: "youtube_video",
        label: "YouTube Video",
        description: "Analyze YouTube videos. Summarize, answer questions, find timestamps. Supports video clipping (start/end offsets). Preview feature.",
        parameters: YoutubeVideoSchema,
        execute: youtubeVideo
    });
}

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { webSearch, WebSearchSchema } from "./web_search.js";
import { urlContext, UrlContextSchema } from "./url_context.js";

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
        description: "Analyze the content of up to 20 public URLs. Supports web pages, documents, images, and YouTube videos.",
        parameters: UrlContextSchema,
        execute: urlContext
    });
}

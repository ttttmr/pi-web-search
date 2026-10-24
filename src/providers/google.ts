import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { TextEncoder, TextDecoder } from "util";
import { getConfig } from "./config.ts";
import { getAuth, getProviderSessionHeaders, mergeRequestHeaders } from "./auth.ts";
import { readSseEvents } from "./sse.ts";
import { deriveSources, pushUniqueSearchResult, sanitizeSearchResults, titleFromUrl } from "./results.ts";
import type { SearchResultDetail, Source, StreamResult } from "./types.ts";

export function extractPromptFromGeminiBody(body: any): string {
    const parts: string[] = [];
    for (const content of body?.contents || []) {
        for (const part of content?.parts || []) {
            if (typeof part?.text === "string") {
                parts.push(part.text);
            } else if (part?.file_data?.file_uri) {
                parts.push(String(part.file_data.file_uri));
            }
        }
    }
    return parts.join("\n\n").trim();
}

function isGoogleGroundingRedirect(url: string | undefined): boolean {
    return !!url && /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//.test(url);
}

async function resolveGoogleGroundingRedirectUrls(searchResults: SearchResultDetail[], citations: SearchResultDetail[], signal?: AbortSignal) {
    const redirectUrls = [...new Set([...searchResults, ...citations].map((item) => item.url).filter((url): url is string => isGoogleGroundingRedirect(url)))];
    if (redirectUrls.length === 0) return;

    const resolved = new Map<string, string>();
    await Promise.all(redirectUrls.slice(0, 20).map(async (url) => {
        try {
            const response = await fetch(url, { method: "HEAD", redirect: "manual", signal });
            const location = response.headers.get("location");
            if (location) resolved.set(url, location);
        } catch {
            // Ignore redirect resolution failures and keep the original URL.
        }
    }));

    if (resolved.size === 0) return;
    for (const item of [...searchResults, ...citations]) {
        if (!item.url) continue;
        const canonicalUrl = resolved.get(item.url);
        if (!canonicalUrl) continue;
        item.url = canonicalUrl;
        if (!item.title || item.title === "Unknown") item.title = titleFromUrl(canonicalUrl);
    }
}

function extractGoogleSearchDetails(groundingMetadata: any): { searchQueries: string[]; searchResults: SearchResultDetail[]; citations: SearchResultDetail[] } {
    const searchQueries = groundingMetadata?.webSearchQueries || [];
    const chunks = groundingMetadata?.groundingChunks || [];
    const supports = groundingMetadata?.groundingSupports || [];
    const searchResults: SearchResultDetail[] = [];
    const citations: SearchResultDetail[] = [];

    chunks.forEach((chunk: any, index: number) => {
        if (!chunk?.web) return;
        pushUniqueSearchResult(searchResults, {
            title: chunk.web.title || "Unknown",
            url: chunk.web.uri || "",
            source: "google.groundingChunks",
            type: "web",
            raw: { index, ...chunk.web },
        });
    });

    supports.forEach((support: any) => {
        for (const index of support?.groundingChunkIndices || []) {
            const web = chunks[index]?.web;
            if (!web) continue;
            pushUniqueSearchResult(citations, {
                title: web.title || "Unknown",
                url: web.uri || "",
                citedText: support?.segment?.text,
                source: "google.groundingSupports",
                type: "citation",
                raw: support,
            });
        }
    });

    return { searchQueries, searchResults, citations };
}

export async function callGoogleStream(
    ctx: ExtensionContext,
    model: Model<Api>,
    body: any,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal
): Promise<StreamResult> {
    const config = getConfig(model);
    if (!config.buildRequest) {
        throw new Error(`Unsupported Google provider: ${model.provider}`);
    }

    const auth = await getAuth(ctx, model);
    if (!auth.ok) {
        throw new Error(auth.error || "Failed to get API key and headers");
    }

    const req = config.buildRequest(model, body, auth);

    // Handle auth
    req.headers = mergeRequestHeaders(req.headers, getProviderSessionHeaders(model, ctx), auth.headers);
    if (auth.apiKey && model.provider !== "antigravity" && model.api !== "antigravity") {
        req.headers["x-goog-api-key"] = auth.apiKey;
    }

    const response = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal
    });

    if (!response.ok) {
        throw new Error(`API error (${response.status}): ${await response.text()}`);
    }

    const stream = createGoogleSearchStream(onUpdate, signal);
    await readSseEvents(response, signal, ({ data }) => stream.onEvent(data));
    return stream.result();
}

export function createGoogleSearchStream(onUpdate?: AgentToolUpdateCallback, signal?: AbortSignal) {
    let accumulatedText = "";
    let groundingMetadata: any;
    let urlContextMetadata: any;

    const onEvent = (chunk: any) => {
        if (chunk.error) {
            const errorMsg = chunk.error.message || JSON.stringify(chunk.error);
            throw new Error(`API error (${chunk.error.code || chunk.error.status || 'unknown'}): ${errorMsg}`);
        }

        // Unwrap response for internal APIs
        const data = chunk.response || chunk;
        const candidate = data.candidates?.[0];

        if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
                // Pi's Google transport can include reasoning parts alongside answer text.
                if (part.text && !part.thought) {
                    accumulatedText += part.text;
                    onUpdate?.({
                        content: [{ type: "text", text: accumulatedText }],
                        details: { streaming: true }
                    });
                }
            }
        }

        // Capture metadata from final chunk
        if (candidate?.groundingMetadata) {
            groundingMetadata = candidate.groundingMetadata;
        }
        // Handle both camelCase and snake_case
        if (candidate?.urlContextMetadata || candidate?.url_context_metadata) {
            urlContextMetadata = candidate.urlContextMetadata || candidate.url_context_metadata;
        }
    };

    const result = async (): Promise<StreamResult> => {
        const searchDetails = extractGoogleSearchDetails(groundingMetadata);
        await resolveGoogleGroundingRedirectUrls(searchDetails.searchResults, searchDetails.citations, signal);
        const searchResults = sanitizeSearchResults(searchDetails.searchResults);
        const citations = sanitizeSearchResults(searchDetails.citations);
        return {
            text: accumulatedText || "No answer available.",
            sources: deriveSources(searchResults, citations),
            providerKind: "google",
            nativeSearchUsed: searchDetails.searchQueries.length > 0 || searchResults.length > 0,
            nativeSearchEvents: searchDetails.searchQueries.length > 0 ? ["google.groundingMetadata.webSearchQueries"] : [],
            searchQueries: searchDetails.searchQueries,
            searchResults,
            citations,
            groundingMetadata,
            urlContextMetadata
        };
    };
    return { onEvent, result };
}

// --- Citation Processing (byte-safe) ---

export function applyCitations(text: string, groundingMetadata: any): { text: string; sources: Source[] } {
    const chunks = groundingMetadata?.groundingChunks || [];
    const supports = groundingMetadata?.groundingSupports || [];

    const sources = chunks
        .filter((c: any) => c.web)
        .map((c: any) => ({ title: c.web.title || "Unknown", url: c.web.uri || "" }));

    if (!supports.length || !sources.length) return { text, sources };

    // Collect insertions, sort descending
    const insertions = supports
        .filter((s: any) => s.segment?.endIndex !== undefined && s.groundingChunkIndices?.length)
        .map((s: any) => ({
            index: s.segment.endIndex,
            marker: s.groundingChunkIndices.map((i: number) => `[${i + 1}]`).join("")
        }))
        .sort((a: any, b: any) => b.index - a.index);

    // Byte-safe insertion
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bytes = encoder.encode(text);

    const parts: Uint8Array[] = [];
    let lastIndex = bytes.length;

    for (const ins of insertions) {
        const pos = Math.min(ins.index, lastIndex);
        if (pos < lastIndex) parts.unshift(bytes.subarray(pos, lastIndex));
        parts.unshift(encoder.encode(ins.marker));
        lastIndex = pos;
    }
    if (lastIndex > 0) parts.unshift(bytes.subarray(0, lastIndex));

    const total = parts.reduce((acc, p) => acc + p.length, 0);
    const final = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        final.set(part, offset);
        offset += part.length;
    }

    return { text: decoder.decode(final), sources };
}

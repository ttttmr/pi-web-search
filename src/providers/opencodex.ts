import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAuth } from "./auth.ts";
import { deriveSources, sanitizeSearchResults, titleFromUrl } from "./results.ts";
import type { SearchResultDetail, StreamResult } from "./types.ts";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface OpenCodexSearchResponse {
    output?: unknown;
    results?: unknown;
    error?: { message?: unknown };
}

function searchUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/alpha/search`;
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        void response.body?.cancel();
        throw new Error("OpenCodex search response exceeded 16 MiB");
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
                void reader.cancel();
                throw new Error("OpenCodex search response exceeded 16 MiB");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
}

export async function callOpenCodexSearch(
    ctx: ExtensionContext,
    model: Model<Api>,
    query: string,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
): Promise<StreamResult> {
    const auth = await getAuth(ctx, model);
    if (!auth.ok) throw new Error(auth.error || "Failed to resolve OpenCodex credentials");

    const headers = new Headers(model.headers || {});
    for (const [name, value] of Object.entries(auth.headers || {})) headers.set(name, value);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");
    if (auth.apiKey && auth.apiKey !== "opencodex-loopback" && !headers.has("x-opencodex-api-key")) {
        headers.set("x-opencodex-api-key", auth.apiKey);
        // This endpoint may relay a real ChatGPT bearer. OpenCodex admission keys belong in
        // its dedicated header and must never be mistaken for an upstream credential.
        headers.delete("Authorization");
    }
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const sessionAffinity = model.compat as { sendSessionAffinityHeaders?: boolean } | undefined;
    if (sessionId && sessionAffinity?.sendSessionAffinityHeaders) {
        headers.set("session_id", sessionId);
        headers.set("x-client-request-id", sessionId);
        headers.set("x-session-affinity", sessionId);
    }

    onUpdate?.({
        content: [{ type: "text", text: "Searching the web through OpenCodex..." }],
        details: { streaming: true, searching: true },
    });

    const response = await fetch(searchUrl(model.baseUrl), {
        method: "POST",
        headers: Object.fromEntries(headers.entries()),
        body: JSON.stringify({
            id: `pi-web-search-${crypto.randomUUID()}`,
            model: model.id,
            commands: { search_query: [{ q: query }] },
        }),
        signal,
    });
    const bytes = await boundedBytes(response);
    let payload: OpenCodexSearchResponse = {};
    try { payload = JSON.parse(new TextDecoder().decode(bytes)) as OpenCodexSearchResponse; } catch { /* handled below */ }
    if (!response.ok) {
        const message = typeof payload.error?.message === "string" ? payload.error.message : response.statusText;
        throw new Error(`OpenCodex search error (${response.status}): ${message}`);
    }

    const rows = Array.isArray(payload.results) ? payload.results : [];
    const searchResults: SearchResultDetail[] = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const { title, url } = row as { title?: unknown; url?: unknown };
        if (typeof url !== "string" || !url) continue;
        const safeTitle = typeof title === "string" && title ? title : titleFromUrl(url);
        searchResults.push({ title: safeTitle, url, query, source: "opencodex.alpha_search", type: "search_result" });
    }
    const sanitizedSearchResults = sanitizeSearchResults(searchResults);

    return {
        text: typeof payload.output === "string" ? payload.output : "No answer available.",
        sources: deriveSources(sanitizedSearchResults),
        providerKind: "opencodex",
        nativeSearchUsed: true,
        searchQueries: [query],
        searchResults: sanitizedSearchResults,
    };
}

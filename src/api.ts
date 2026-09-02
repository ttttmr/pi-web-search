import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { TextEncoder, TextDecoder } from "util";

// --- Provider Configuration ---

type ProviderKind = "google" | "openai" | "anthropic" | "unsupported";

type GoogleRequestBuilder = (model: Model<Api>, body: any, auth?: ResolvedAuth) => { url: string; headers: Record<string, string>; body: any };

type ProviderConfig = {
    kind: ProviderKind;
    searchTool?: string;
    urlContextTool?: string;
    buildRequest?: GoogleRequestBuilder;
};

const ANTIGRAVITY_MODEL_MAP: Record<string, string> = {
    "gemini-3.7-flash": "gemini-3.7-flash-medium",
    "gemini-3.7-flash-medium": "gemini-3.7-flash-medium",
    "gemini-3.6-flash": "gemini-3.6-flash-low",
    "gemini-3.5-flash": "gemini-3.5-flash-extra-low",
};

const GOOGLE_PROVIDERS: Record<string, ProviderConfig> = {
    "google-generative-ai": {
        kind: "google",
        searchTool: "google_search",
        urlContextTool: "url_context",
        buildRequest: (model, body) => ({
            url: `${model.baseUrl}/models/${model.id}:streamGenerateContent?alt=sse`,
            headers: {
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
            body
        })
    },
    "antigravity": {
        kind: "google",
        searchTool: "google_search",
        urlContextTool: "url_context",
        buildRequest: (model, body, auth) => {
            let token = "";
            let projectId = "aicode-consumers";
            if (auth && auth.ok && auth.apiKey) {
                try {
                    const parsed = JSON.parse(auth.apiKey);
                    token = parsed.token || auth.apiKey;
                    projectId = parsed.projectId || projectId;
                } catch {
                    token = auth.apiKey;
                }
            }
            const runtimeModel = ANTIGRAVITY_MODEL_MAP[model.id] || model.id;
            const platform = process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";
            const osType = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
            const arch = process.arch === "arm64" ? "arm64" : "x64";
            return {
                url: "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "Accept": "text/event-stream",
                    "User-Agent": `antigravity/hub/2.8.0 ${osType}/${arch}`,
                    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
                    "Client-Metadata": JSON.stringify({
                        ideType: "ANTIGRAVITY",
                        platform,
                        pluginType: "GEMINI"
                    })
                },
                body: {
                    project: projectId,
                    model: runtimeModel,
                    request: {
                        contents: body.contents,
                        ...(body.tools ? { tools: body.tools } : {})
                    },
                    requestType: "AGENT",
                    userAgent: "antigravity"
                }
            };
        }
    }
};

export function getProviderKind(model: Model<Api>): ProviderKind {
    if (GOOGLE_PROVIDERS[model.provider] || GOOGLE_PROVIDERS[model.api]) return "google";
    if (
        model.api === "openai-responses"
        || model.api === "azure-openai-responses"
        || model.api === "openai-codex-responses"
    ) return "openai";
    if (model.api === "anthropic-messages") return "anthropic";
    return "unsupported";
}

export function getConfig(model: Model<Api>): ProviderConfig {
    const googleConfig = GOOGLE_PROVIDERS[model.provider] || GOOGLE_PROVIDERS[model.api];
    if (googleConfig) return googleConfig;
    const kind = getProviderKind(model);
    return { kind };
}

// --- Auth Compatibility Layer ---

type ResolvedAuth = 
    | { ok: true; apiKey?: string; headers?: Record<string, string>; baseUrl?: string; }
    | { ok: false; error: string; };

function getEnvAuth(model: Model<Api>): Extract<ResolvedAuth, { ok: true }> | undefined {
    const apiKey = getEnvApiKey(model.provider);
    return apiKey ? { ok: true, apiKey } : undefined;
}

/**
 * Get API key and headers for a model.
 */
async function getAuth(ctx: ExtensionContext, model: Model<Api>): Promise<ResolvedAuth> {
    const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!resolved.ok) return resolved;

    // pi-coding-agent 0.80.1+ returns { ok: true } from getApiKeyAndHeaders()
    // when auth only comes from provider env vars such as ANTHROPIC_API_KEY.
    // The main agent still works because pi-ai's streamSimple() performs its own
    // getEnvApiKey() fallback, but this extension calls fetch() directly, so it
    // must mirror that fallback while preserving explicit model/auth headers.
    const envAuth = !resolved.apiKey && !hasAuthHeader(resolved.headers) ? getEnvAuth(model) : undefined;
    return envAuth ? { ...resolved, apiKey: envAuth.apiKey } : resolved;
}

function hasAuthHeader(headers?: Record<string, string>): boolean {
    if (!headers) return false;
    return Object.entries(headers).some(([name, value]) => {
        if (!value) return false;
        const normalized = name.toLowerCase();
        return normalized === "authorization" || normalized === "x-api-key" || normalized === "x-goog-api-key";
    });
}

// --- Streaming API Call ---

export interface Source {
    title: string;
    url: string;
}

export interface SearchResultDetail {
    title?: string;
    url?: string;
    query?: string;
    source?: string;
    pageAge?: string | null;
    citedText?: string;
    status?: string;
    type?: string;
    raw?: any;
}

export interface NativeSearchCallDetail {
    id?: string;
    provider: ProviderKind;
    status?: string;
    actionType?: string;
    queries?: string[];
    urls?: string[];
    raw?: any;
}

export interface StreamResult {
    text: string;
    sources?: Source[];
    providerKind?: ProviderKind;
    nativeSearchUsed?: boolean;
    nativeSearchEvents?: string[];
    nativeSearchCalls?: NativeSearchCallDetail[];
    searchQueries?: string[];
    searchResults?: SearchResultDetail[];
    citations?: SearchResultDetail[];
    groundingMetadata?: any;
    urlContextMetadata?: any;
}

type SseEvent = {
    event: string;
    data: any;
};

async function readSseEvents(
    response: Response,
    signal: AbortSignal | undefined,
    onEvent: (event: SseEvent) => boolean | void | Promise<boolean | void>
): Promise<void> {
    if (!response.body) {
        throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEventData = "";
    let currentEventName = "";
    let stopRequested = false;
    let reachedEof = false;

    const flushEvent = async (): Promise<boolean> => {
        if (!currentEventData) return false;
        const raw = currentEventData.trim();
        currentEventData = "";
        const eventName = currentEventName;
        currentEventName = "";
        if (!raw || raw === "[DONE]") return false;

        let data: any;
        try {
            data = JSON.parse(raw);
        } catch {
            return false;
        }
        return await onEvent({ event: eventName, data }) === true;
    };

    try {
        readLoop: while (true) {
            if (signal?.aborted) {
                throw new Error("Request was aborted");
            }

            const { done, value } = await reader.read();
            if (done) {
                reachedEof = true;
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line === "" || line === "\r") {
                    if (await flushEvent()) {
                        stopRequested = true;
                        break readLoop;
                    }
                    continue;
                }

                if (line.startsWith("data:")) {
                    const data = line.slice(5).trim();
                    currentEventData = currentEventData ? currentEventData + "\n" + data : data;
                } else if (line.startsWith("event:")) {
                    currentEventName = line.slice(6).trim();
                }
            }
        }

        if (!stopRequested && buffer.trim()) {
            const line = buffer.trim();
            if (line.startsWith("data:")) {
                const data = line.slice(5).trim();
                currentEventData = currentEventData ? currentEventData + "\n" + data : data;
            }
        }
        if (!stopRequested) stopRequested = await flushEvent();
    } finally {
        if (!reachedEof) {
            try {
                await reader.cancel();
            } catch {
                // Ignore cancellation failures while cleaning up an interrupted stream.
            }
        }
        reader.releaseLock();
    }
}

function extractPromptFromGeminiBody(body: any): string {
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

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

function isOpenAICodexModel(model: Model<Api>): boolean {
    return model.api === "openai-codex-responses";
}

function resolveGitHubCopilotBaseUrl(
    model: Model<Api>,
    auth: Extract<ResolvedAuth, { ok: true }>,
): string {
    if (model.provider !== "github-copilot") return model.baseUrl;

    // Modern pi versions expose the credential-specific Copilot endpoint
    // resolved by the provider. Prefer it so GitHub Enterprise Server and any
    // future provider-owned routing continue to work without token parsing here.
    if (typeof auth.baseUrl === "string" && auth.baseUrl.trim()) {
        return auth.baseUrl;
    }

    // Compatibility fallback for older pi versions whose extension auth API
    // returned the Copilot token but not its resolved base URL.
    if (!auth.apiKey) return model.baseUrl;
    const proxyEndpoints = auth.apiKey
        .split(";")
        .filter((field) => field.startsWith("proxy-ep="))
        .map((field) => field.slice("proxy-ep=".length));
    if (proxyEndpoints.length !== 1) return model.baseUrl;

    const proxyHost = proxyEndpoints[0].toLowerCase();
    const labels = proxyHost.split(".");
    const isValidLabel = (label: string) =>
        label.length > 0
        && label.length <= 63
        && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
    const isCopilotProxyHost = proxyHost.length <= 253
        && labels.length >= 4
        && labels[0] === "proxy"
        && labels.at(-2) === "githubcopilot"
        && labels.at(-1) === "com"
        && labels.every(isValidLabel);
    if (!isCopilotProxyHost) return model.baseUrl;

    return `https://api.${labels.slice(1).join(".")}`;
}

function resolveOpenAIResponsesUrl(model: Model<Api>, baseUrl = model.baseUrl): string {
    const base = trimTrailingSlash(baseUrl);
    if (!isOpenAICodexModel(model)) return `${base}/responses`;
    if (base.endsWith("/codex/responses")) return base;
    if (base.endsWith("/codex")) return `${base}/responses`;
    return `${base}/codex/responses`;
}

function extractOpenAICodexAccountId(token: string): string {
    try {
        const parts = token.split(".");
        if (parts.length !== 3) throw new Error("Invalid token");
        const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
        const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
        if (typeof accountId !== "string" || !accountId) throw new Error("Missing account ID");
        return accountId;
    } catch {
        throw new Error("Failed to extract ChatGPT account ID from openai-codex credentials");
    }
}

function resolveAnthropicMessagesUrl(baseUrl: string): string {
    const base = trimTrailingSlash(baseUrl);
    return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

function pushUniqueSource(sources: Source[], source: Source): number {
    const url = source.url || "";
    const title = source.title || "Unknown";
    const existingIndex = sources.findIndex((s) => s.url === url && s.title === title);
    if (existingIndex >= 0) return existingIndex;
    sources.push({ title, url });
    return sources.length - 1;
}

function pushUniqueString(values: string[], value: string | undefined | null) {
    if (!value || values.includes(value)) return;
    values.push(value);
}

function pushUniqueSearchResult(results: SearchResultDetail[], result: SearchResultDetail) {
    const key = `${result.url || ""}\t${result.title || ""}\t${result.query || ""}\t${result.citedText || ""}\t${result.type || ""}`;
    const exists = results.some((item) => `${item.url || ""}\t${item.title || ""}\t${item.query || ""}\t${item.citedText || ""}\t${item.type || ""}` === key);
    if (!exists) results.push(result);
}

function pushNativeSearchEvent(events: string[], event: string) {
    if (!events.includes(event)) events.push(event);
}

function normalizeSearchUrl(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.hash = "";
        if (!/(^|\.)youtube\.com$/i.test(parsed.hostname) && !/(^|\.)youtu\.be$/i.test(parsed.hostname)) {
            const removableParams = ["ref", "referral_type", "openLinerExtension", "_clear", "lang", "api-mode"];
            for (const name of removableParams) parsed.searchParams.delete(name);
            for (const name of [...parsed.searchParams.keys()]) {
                if (name.toLowerCase().startsWith("utm_")) parsed.searchParams.delete(name);
            }
        }
        const query = parsed.searchParams.toString();
        parsed.search = query ? `?${query}` : "";
        return parsed.toString();
    } catch {
        return url;
    }
}

function titleFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
        return lastSegment || parsed.hostname || url;
    } catch {
        return url;
    }
}

function extractOpenAIUrlCitation(annotation: any): { endIndex?: number; title: string; url: string } | undefined {
    const nested = annotation?.url_citation || annotation?.urlCitation;
    const url = annotation?.url || nested?.url;
    if (!url || typeof url !== "string") return undefined;

    const title = annotation?.title || nested?.title || titleFromUrl(url);
    const endIndexValue = annotation?.end_index ?? annotation?.endIndex ?? nested?.end_index ?? nested?.endIndex;
    return {
        endIndex: typeof endIndexValue === "number" ? endIndexValue : undefined,
        title,
        url,
    };
}

function mergeSearchResultMetadata(results: SearchResultDetail[], extras: SearchResultDetail[]) {
    for (const extra of extras) {
        if (!extra.url) continue;
        const existing = results.find((item) => item.url === extra.url);
        if (!existing) continue;
        if (!existing.title && extra.title) existing.title = extra.title;
        if (!existing.query && extra.query) existing.query = extra.query;
        if (!existing.citedText && extra.citedText) existing.citedText = extra.citedText;
        if (!existing.status && extra.status) existing.status = extra.status;
        if (!existing.type && extra.type) existing.type = extra.type;
        if (!existing.source && extra.source) existing.source = extra.source;
    }
}

function isLikelyJunkSearchUrl(url: string | undefined): boolean {
    if (!url) return true;
    try {
        const parsed = new URL(url);
        const decodedPath = decodeURIComponent(parsed.pathname).toLowerCase();
        const suspiciousSuffixes = [
            ".gz", ".zip", ".tgz", ".tar", ".woff", ".woff2", ".ttf", ".otf", ".eot",
            ".webm", ".mp4", ".mp3", ".wav", ".eps", ".sql", ".csv", ".xls", ".xlsx", ".ppt", ".pptx"
        ];
        if (suspiciousSuffixes.some((suffix) => decodedPath.endsWith(suffix))) return true;
        if (decodedPath === "/%" || decodedPath.endsWith("/%")) return true;
        return false;
    } catch {
        return false;
    }
}

function sanitizeSearchResults(results: SearchResultDetail[]): SearchResultDetail[] {
    const sanitized: SearchResultDetail[] = [];
    for (const result of results) {
        const normalizedUrl = result.url ? normalizeSearchUrl(result.url) : result.url;
        const normalized = { ...result, url: normalizedUrl };
        if (normalized.url && isLikelyJunkSearchUrl(normalized.url)) continue;
        pushUniqueSearchResult(sanitized, normalized);
    }
    return sanitized;
}

function deriveSources(searchResults: SearchResultDetail[], citations: SearchResultDetail[] = []): Source[] {
    const sources: Source[] = [];
    for (const item of [...citations, ...searchResults]) {
        if (!item.url) continue;
        const url = normalizeSearchUrl(item.url);
        if (isLikelyJunkSearchUrl(url)) continue;
        pushUniqueSource(sources, {
            title: item.title || titleFromUrl(url),
            url,
        });
    }
    return sources;
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

function applyIndexCitations(text: string, citations: Array<{ endIndex?: number; title: string; url: string }>): { text: string; sources: Source[] } {
    const sources: Source[] = [];
    const insertions = citations
        .filter((c) => c.url && c.endIndex !== undefined)
        .map((c) => ({
            index: Math.max(0, Math.min(c.endIndex!, text.length)),
            marker: `[${pushUniqueSource(sources, { title: c.title, url: c.url }) + 1}]`
        }))
        .sort((a, b) => b.index - a.index);

    let result = text;
    const seen = new Set<string>();
    for (const insertion of insertions) {
        const key = `${insertion.index}:${insertion.marker}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result = result.slice(0, insertion.index) + insertion.marker + result.slice(insertion.index);
    }

    // Preserve sources that had no end index.
    for (const citation of citations) {
        if (citation.url) pushUniqueSource(sources, { title: citation.title, url: citation.url });
    }

    return { text: result, sources };
}

function applyTextCitations(text: string, citations: Array<{ citedText?: string; title: string; url: string }>): { text: string; sources: Source[] } {
    const sources: Source[] = [];
    const insertions: Array<{ index: number; marker: string }> = [];
    const usedRanges = new Set<string>();

    for (const citation of citations) {
        if (!citation.url) continue;
        const marker = `[${pushUniqueSource(sources, { title: citation.title, url: citation.url }) + 1}]`;
        const citedText = citation.citedText?.trim();
        if (!citedText) continue;
        const index = text.indexOf(citedText);
        if (index < 0) continue;
        const end = index + citedText.length;
        const key = `${end}:${marker}`;
        if (usedRanges.has(key)) continue;
        usedRanges.add(key);
        insertions.push({ index: end, marker });
    }

    let result = text;
    for (const insertion of insertions.sort((a, b) => b.index - a.index)) {
        result = result.slice(0, insertion.index) + insertion.marker + result.slice(insertion.index);
    }

    return { text: result, sources };
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

async function callGoogleStream(
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
    if (auth.headers) {
        Object.assign(req.headers, auth.headers);
    }
    if (auth.apiKey && model.provider !== "antigravity") {
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

    let accumulatedText = "";
    let groundingMetadata: any;
    let urlContextMetadata: any;

    await readSseEvents(response, signal, ({ data: chunk }) => {
        if (chunk.error) {
            const errorMsg = chunk.error.message || JSON.stringify(chunk.error);
            throw new Error(`API error (${chunk.error.code || chunk.error.status || 'unknown'}): ${errorMsg}`);
        }

        // Unwrap response for internal APIs
        const data = chunk.response || chunk;
        const candidate = data.candidates?.[0];

        if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
                if (part.text) {
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
    });

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
}

async function callOpenAIStream(
    ctx: ExtensionContext,
    model: Model<Api>,
    prompt: string,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal
): Promise<StreamResult> {
    const auth = await getAuth(ctx, model);
    if (!auth.ok) {
        throw new Error(auth.error || "Failed to get API key and headers");
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(model.headers || {})) headers.set(name, value);
    for (const [name, value] of Object.entries(auth.headers || {})) headers.set(name, value);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (!headers.has("Accept")) headers.set("Accept", "text/event-stream");
    if (auth.apiKey && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${auth.apiKey}`);

    const isCodex = isOpenAICodexModel(model);
    if (isCodex) {
        const authorization = headers.get("Authorization");
        const hasBearerAuth = typeof authorization === "string" && /^Bearer\s+\S+/i.test(authorization);
        if (!auth.apiKey && !hasBearerAuth) {
            throw new Error("No OAuth credential configured for openai-codex model");
        }
        if (!headers.has("chatgpt-account-id")) {
            if (!auth.apiKey) {
                throw new Error("No ChatGPT account ID configured for openai-codex model");
            }
            headers.set("chatgpt-account-id", extractOpenAICodexAccountId(auth.apiKey));
        }
        if (!headers.has("originator")) headers.set("originator", "codex_cli_rs");
    }
    const requestHeaders = Object.fromEntries(headers.entries());

    const requestBody: any = {
        model: model.id,
        input: isCodex
            ? [{ role: "user", content: [{ type: "input_text", text: prompt }] }]
            : prompt,
        tools: [{ type: "web_search" }],
        include: isCodex
            ? ["web_search_call.action.sources"]
            : ["web_search_call.action.sources", "web_search_call.results"],
        stream: true,
        store: false,
    };
    if (model.reasoning) {
        requestBody.reasoning = { effort: "none" };
    }
    if (isCodex) {
        requestBody.instructions = "Answer the user's request using web search when needed.";
        requestBody.text = { verbosity: "low" };
        requestBody.tool_choice = "required";
        requestBody.parallel_tool_calls = true;
    }

    const baseUrl = resolveGitHubCopilotBaseUrl(model, auth);
    const response = await fetch(resolveOpenAIResponsesUrl(model, baseUrl), {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
        signal
    });

    if (!response.ok) {
        throw new Error(`OpenAI API error (${response.status}): ${await response.text()}`);
    }

    let accumulatedText = "";
    const citations: Array<{ endIndex?: number; title: string; url: string }> = [];
    const nativeSearchEvents: string[] = [];
    const nativeSearchCalls: NativeSearchCallDetail[] = [];
    const searchQueries: string[] = [];
    const searchResults: SearchResultDetail[] = [];

    const collectAnnotation = (annotation: any) => {
        if (annotation?.type !== "url_citation") return;
        const citation = extractOpenAIUrlCitation(annotation);
        if (!citation) return;
        citations.push(citation);
    };

    const collectWebSearchCall = (item: any) => {
        if (item?.type !== "web_search_call") return;
        const action = item.action || {};
        const call: NativeSearchCallDetail = {
            id: item.id,
            provider: "openai",
            status: item.status,
            actionType: action.type,
            raw: item,
        };
        if (Array.isArray(action.queries)) {
            const queries = action.queries.filter((query: any): query is string => typeof query === "string");
            call.queries = queries;
            for (const query of queries) pushUniqueString(searchQueries, query);
        } else if (typeof action.query === "string") {
            call.queries = [action.query];
            pushUniqueString(searchQueries, action.query);
        }
        if (Array.isArray(action.sources)) {
            call.urls = action.sources.map((source: any) => source?.url).filter((url: any): url is string => typeof url === "string");
            for (const source of action.sources) {
                if (!source?.url) continue;
                pushUniqueSearchResult(searchResults, {
                    title: source.title || source.display_name || source.name || titleFromUrl(source.url),
                    url: source.url,
                    source: "openai.web_search_call.action.sources",
                    type: source.type || "url",
                    raw: source,
                });
            }
        }
        if (action.url) {
            call.urls = [...(call.urls || []), action.url];
            pushUniqueSearchResult(searchResults, {
                title: titleFromUrl(action.url),
                url: action.url,
                source: `openai.web_search_call.action.${action.type}`,
                type: action.type,
                raw: action,
            });
        }
        const existingCall = call.id ? nativeSearchCalls.find((existing) => existing.id === call.id) : undefined;
        if (existingCall) {
            Object.assign(existingCall, Object.fromEntries(
                Object.entries(call).filter(([, value]) => value !== undefined)
            ));
        } else {
            nativeSearchCalls.push(call);
        }
    };

    const collectFromResponse = (response: any) => {
        for (const item of response?.output || []) {
            collectWebSearchCall(item);
            if (item?.type !== "message") continue;
            for (const content of item.content || []) {
                if (content?.type !== "output_text") continue;
                for (const annotation of content.annotations || []) collectAnnotation(annotation);
            }
        }
    };

    await readSseEvents(response, signal, ({ data: event }) => {
        if (event.type === "error" || event.type === "response.failed") {
            const message = event.message || event.error?.message || event.response?.error?.message;
            throw new Error(message || JSON.stringify(event.error || event.response?.error || event));
        } else if (event.type === "response.output_text.delta") {
            accumulatedText += event.delta || "";
            onUpdate?.({
                content: [{ type: "text", text: accumulatedText }],
                details: { streaming: true }
            });
        } else if (event.type === "response.output_text.annotation.added") {
            collectAnnotation(event.annotation);
        } else if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
            collectWebSearchCall(event.item);
        } else if (event.type === "response.incomplete" || event.response?.status === "incomplete") {
            collectFromResponse(event.response);
            if (isCodex) return true;
        } else if (event.type === "response.completed" || event.type === "response.done") {
            collectFromResponse(event.response);
            if (isCodex) return true;
        } else if (event.type === "response.web_search_call.in_progress" || event.type === "response.web_search_call.searching" || event.type === "response.web_search_call.completed") {
            pushNativeSearchEvent(nativeSearchEvents, event.type);
            const call = nativeSearchCalls.find((item) => item.id === event.item_id);
            if (call) call.status = event.type.replace("response.web_search_call.", "");
            else nativeSearchCalls.push({ id: event.item_id, provider: "openai", status: event.type.replace("response.web_search_call.", ""), raw: event });
            if (event.type === "response.web_search_call.searching") {
                onUpdate?.({
                    content: [{ type: "text", text: accumulatedText || "Searching the web with OpenAI..." }],
                    details: { streaming: true, searching: true }
                });
            }
        }
    });

    const cited = applyIndexCitations(accumulatedText || "No answer available.", citations);
    const citationDetails = citations.map((citation) => ({
        title: citation.title,
        url: citation.url,
        source: "openai.url_citation",
        type: "citation",
        raw: citation,
    }));
    for (const citation of citationDetails) pushUniqueSearchResult(searchResults, citation);
    mergeSearchResultMetadata(searchResults, citationDetails);
    const sanitizedSearchResults = sanitizeSearchResults(searchResults);
    const sanitizedCitations = sanitizeSearchResults(citationDetails);
    mergeSearchResultMetadata(sanitizedSearchResults, sanitizedCitations);
    const derivedSources = deriveSources(sanitizedSearchResults, sanitizedCitations);

    return {
        text: cited.text,
        sources: cited.sources.length ? cited.sources.map((source) => ({ ...source, url: normalizeSearchUrl(source.url) })).filter((source) => !isLikelyJunkSearchUrl(source.url)) : derivedSources,
        providerKind: "openai",
        nativeSearchUsed: nativeSearchEvents.length > 0 || nativeSearchCalls.length > 0 || sanitizedSearchResults.length > 0,
        nativeSearchEvents,
        nativeSearchCalls,
        searchQueries,
        searchResults: sanitizedSearchResults,
        citations: sanitizedCitations,
    };
}

async function callAnthropicStream(
    ctx: ExtensionContext,
    model: Model<Api>,
    prompt: string,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal
): Promise<StreamResult> {
    const auth = await getAuth(ctx, model);
    if (!auth.ok) {
        throw new Error(auth.error || "Failed to get API key and headers");
    }

    const isOAuth = !!auth.apiKey && auth.apiKey.includes("sk-ant-oat");
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "anthropic-version": "2023-06-01",
        ...(model.headers || {}),
        ...(auth.headers || {}),
    };

    if (auth.apiKey) {
        if (isOAuth) {
            if (!headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${auth.apiKey}`;
            headers["anthropic-beta"] = headers["anthropic-beta"]
                ? `${headers["anthropic-beta"]},claude-code-20250219,oauth-2025-04-20`
                : "claude-code-20250219,oauth-2025-04-20";
            headers["user-agent"] = headers["user-agent"] || "claude-cli/2.1.75";
            headers["x-app"] = headers["x-app"] || "cli";
        } else if (!headers["x-api-key"] && !headers["X-Api-Key"]) {
            headers["x-api-key"] = auth.apiKey;
        }
    }

    const maxTokens = Math.min(Math.max(1024, Math.floor(model.maxTokens / 3) || 4096), 8192);
    const requestBody = {
        model: model.id,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
        stream: true,
    };

    const response = await fetch(resolveAnthropicMessagesUrl(model.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal
    });

    if (!response.ok) {
        throw new Error(`Anthropic API error (${response.status}): ${await response.text()}`);
    }

    let accumulatedText = "";
    const citations: Array<{ citedText?: string; title: string; url: string }> = [];
    const nativeSearchEvents: string[] = [];
    const nativeSearchCalls: NativeSearchCallDetail[] = [];
    const searchResults: SearchResultDetail[] = [];

    const collectSource = (source: any, toolUseId?: string) => {
        if (!source?.url) return;
        const title = source.title || titleFromUrl(source.url);
        citations.push({ title, url: source.url });
        pushUniqueSearchResult(searchResults, {
            title,
            url: source.url,
            pageAge: source.page_age ?? source.pageAge,
            source: "anthropic.web_search_tool_result",
            type: source.type || "web_search_result",
            raw: { toolUseId, ...source },
        });
    };

    await readSseEvents(response, signal, ({ data: event }) => {
        if (event.type === "content_block_start") {
            const block = event.content_block;
            if (block?.type === "text" && block.text) {
                accumulatedText += block.text;
                onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: { streaming: true } });
            } else if (block?.type === "server_tool_use" && block.name === "web_search") {
                pushNativeSearchEvent(nativeSearchEvents, "anthropic.content_block_start.server_tool_use.web_search");
                nativeSearchCalls.push({
                    id: block.id,
                    provider: "anthropic",
                    status: "in_progress",
                    actionType: block.name,
                    queries: typeof block.input?.query === "string" ? [block.input.query] : undefined,
                    raw: block,
                });
                onUpdate?.({
                    content: [{ type: "text", text: accumulatedText || "Searching the web with Anthropic..." }],
                    details: { streaming: true, searching: true }
                });
            } else if (block?.type === "web_search_tool_result") {
                pushNativeSearchEvent(nativeSearchEvents, "anthropic.content_block_start.web_search_tool_result");
                const call = nativeSearchCalls.find((item) => item.id === block.tool_use_id);
                if (call) call.status = "completed";
                else nativeSearchCalls.push({ id: block.tool_use_id, provider: "anthropic", status: "completed", actionType: "web_search", raw: block });
                if (Array.isArray(block.content)) {
                    for (const result of block.content) collectSource(result, block.tool_use_id);
                } else if (block.content?.type === "web_search_tool_result_error") {
                    pushUniqueSearchResult(searchResults, {
                        status: block.content.error_code,
                        source: "anthropic.web_search_tool_result_error",
                        type: block.content.type,
                        raw: block,
                    });
                }
            }
        } else if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta?.type === "text_delta") {
                accumulatedText += delta.text || "";
                onUpdate?.({
                    content: [{ type: "text", text: accumulatedText }],
                    details: { streaming: true }
                });
            } else if (delta?.type === "citations_delta") {
                const citation = delta.citation;
                if (citation?.type === "web_search_result_location" && citation.url) {
                    const detail = {
                        citedText: citation.cited_text,
                        title: citation.title || titleFromUrl(citation.url),
                        url: citation.url,
                        source: "anthropic.citations_delta",
                        type: citation.type,
                        raw: citation,
                    };
                    citations.push({ citedText: detail.citedText, title: detail.title, url: detail.url });
                    pushUniqueSearchResult(searchResults, detail);
                }
            }
        } else if (event.type === "error") {
            throw new Error(event.error?.message || JSON.stringify(event.error || event));
        }
    });

    const cited = applyTextCitations(accumulatedText || "No answer available.", citations);
    const citationDetails = citations.map((citation) => ({
        title: citation.title || titleFromUrl(citation.url),
        url: citation.url,
        citedText: citation.citedText,
        source: "anthropic.citation",
        type: "citation",
        raw: citation,
    }));
    mergeSearchResultMetadata(searchResults, citationDetails);
    const sanitizedSearchResults = sanitizeSearchResults(searchResults);
    const sanitizedCitations = sanitizeSearchResults(citationDetails);
    mergeSearchResultMetadata(sanitizedSearchResults, sanitizedCitations);
    const derivedSources = deriveSources(sanitizedSearchResults, sanitizedCitations);

    return {
        text: cited.text,
        sources: cited.sources.length ? cited.sources.map((source) => ({ ...source, url: normalizeSearchUrl(source.url) })).filter((source) => !isLikelyJunkSearchUrl(source.url)) : derivedSources,
        providerKind: "anthropic",
        nativeSearchUsed: nativeSearchEvents.length > 0 || nativeSearchCalls.length > 0 || sanitizedSearchResults.length > 0,
        nativeSearchEvents,
        nativeSearchCalls,
        searchQueries: nativeSearchCalls.flatMap((call) => call.queries || []),
        searchResults: sanitizedSearchResults,
        citations: sanitizedCitations,
    };
}

export async function callApiStream(
    ctx: ExtensionContext,
    model: Model<Api>,
    body: any,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal
): Promise<StreamResult> {
    const kind = getProviderKind(model);
    if (kind === "google") {
        return callGoogleStream(ctx, model, body, onUpdate, signal);
    }

    const prompt = extractPromptFromGeminiBody(body);
    if (!prompt) {
        throw new Error("No prompt text found in request body");
    }

    if (kind === "openai") {
        return callOpenAIStream(ctx, model, prompt, onUpdate, signal);
    }
    if (kind === "anthropic") {
        return callAnthropicStream(ctx, model, prompt, onUpdate, signal);
    }

    throw new Error(`Unsupported provider for web search: ${model.provider} (${model.api})`);
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

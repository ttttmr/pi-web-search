import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { TextDecoder } from "util";
import { getProviderKind, getSearchDialect } from "./config.ts";
import { getAuth, getProviderSessionHeaders, mergeRequestHeaders, type ResolvedAuth } from "./auth.ts";
import { readSseEvents } from "./sse.ts";
import {
    applyIndexCitations,
    deriveSources,
    mergeSearchResultMetadata,
    normalizeCitedSources,
    preserveInlineCitations,
    pushNativeSearchEvent,
    pushUniqueSearchResult,
    pushUniqueString,
    sanitizeSearchResults,
    titleFromUrl,
} from "./results.ts";
import type { NativeSearchCallDetail, SearchResultDetail, StreamResult } from "./types.ts";

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
    const base = baseUrl.replace(/\/+$/, "");
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

export function getOpenAISearchOptions(model: Model<Api>) {
    const isCodex = isOpenAICodexModel(model);
    const isGrok = getSearchDialect(model) === "grok";
    return {
        tools: [{ type: "web_search" }],
        include: isCodex || isGrok
            ? ["web_search_call.action.sources"]
            : ["web_search_call.action.sources", "web_search_call.results"],
        ...(isCodex ? {
            instructions: "Answer the user's request using web search when needed.",
            text: { verbosity: "low" },
            tool_choice: "required",
            parallel_tool_calls: true,
        } : {}),
    };
}

export async function callOpenAIStream(
    ctx: ExtensionContext,
    model: Model<Api>,
    prompt: string,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
    thinkingLevel?: ModelThinkingLevel
): Promise<StreamResult> {
    const auth = await getAuth(ctx, model);
    if (!auth.ok) {
        throw new Error(auth.error || "Failed to get API key and headers");
    }

    const headers = new Headers(mergeRequestHeaders(getProviderSessionHeaders(model, ctx), model.headers, auth.headers));
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

    const isXai = getProviderKind(model) === "xai";
    // Dialect shapes the wire format only (input, include, citations); labels,
    // providerKind, and reasoning stay keyed to provider identity.
    const isGrok = getSearchDialect(model) === "grok";
    const requestBody: any = {
        model: model.id,
        input: isCodex
            ? [{ role: "user", content: [{ type: "input_text", text: prompt }] }]
            : isGrok
                ? [{ role: "user", content: prompt }]
                : [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        ...getOpenAISearchOptions(model),
        stream: true,
        store: false,
    };
    // Inherit the live session setting, clamped/mapped for the selected search
    // model (which can differ from the conversation model). Keep provider defaults
    // when thinking is off/unavailable; do not reintroduce an implicit "none".
    // xAI shares this transport but does not share OpenAI's effort semantics.
    // Keyed to provider identity, not dialect: gateway-hosted Grok keeps effort.
    if (!isXai && model.reasoning && thinkingLevel && thinkingLevel !== "off") {
        const level = clampThinkingLevel(model, thinkingLevel);
        const effort = model.thinkingLevelMap?.[level] ?? level;
        if (level !== "off") requestBody.reasoning = { effort };
    }
    const baseUrl = resolveGitHubCopilotBaseUrl(model, auth);
    const response = await fetch(resolveOpenAIResponsesUrl(model, baseUrl), {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
        signal
    });

    if (!response.ok) {
        throw new Error(`${isXai ? "xAI" : "OpenAI"} API error (${response.status}): ${await response.text()}`);
    }

    const stream = createOpenAISearchStream(model, onUpdate);
    await readSseEvents(response, signal, ({ data }) => stream.onEvent(data));
    return stream.result();
}

export function createOpenAISearchStream(model: Model<Api>, onUpdate?: AgentToolUpdateCallback) {
    const isCodex = isOpenAICodexModel(model);
    const isXai = getProviderKind(model) === "xai";
    const isGrok = getSearchDialect(model) === "grok";
    const searchProvider: "xai" | "openai" = isXai ? "xai" : "openai";
    const providerSourceName = isXai ? "xai" : "openai";
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
            provider: searchProvider,
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
                    source: `${providerSourceName}.web_search_call.action.sources`,
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
                source: `${providerSourceName}.web_search_call.action.${action.type}`,
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

    const onEvent = (event: any) => {
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
            else nativeSearchCalls.push({ id: event.item_id, provider: searchProvider, status: event.type.replace("response.web_search_call.", ""), raw: event });
            if (event.type === "response.web_search_call.searching") {
                onUpdate?.({
                    content: [{ type: "text", text: accumulatedText || `Searching the web with ${isXai ? "xAI" : "OpenAI"}...` }],
                    details: { streaming: true, searching: true }
                });
            }
        }
    };

    const result = (): StreamResult => {
        const cited = isGrok
            ? preserveInlineCitations(accumulatedText || "No answer available.", citations)
            : applyIndexCitations(accumulatedText || "No answer available.", citations);
        const citationDetails = citations.map((citation) => ({
            title: citation.title,
            url: citation.url,
            source: `${providerSourceName}.url_citation`,
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
            sources: cited.sources.length ? normalizeCitedSources(cited.sources) : derivedSources,
            providerKind: searchProvider,
            nativeSearchUsed: nativeSearchEvents.length > 0 || nativeSearchCalls.length > 0 || sanitizedSearchResults.length > 0,
            nativeSearchEvents,
            nativeSearchCalls,
            searchQueries,
            searchResults: sanitizedSearchResults,
            citations: sanitizedCitations,
        };
    };
    return { onEvent, result };
}

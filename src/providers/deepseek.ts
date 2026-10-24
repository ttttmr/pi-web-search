import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAuth, mergeRequestHeaders, type ResolvedAuth } from "./auth.ts";
import { deriveSources, sanitizeSearchResults, titleFromUrl } from "./results.ts";
import type { SearchResultDetail, Source, StreamResult } from "./types.ts";

/**
 * DeepSeek exposes web search two ways: a server-side `web_search` tool on the
 * Responses API (deepseek-v4-pro only), and the standalone Search & Fetch
 * endpoints used here:
 *   POST {root}/v1/tools/search and POST {root}/v1/tools/fetch
 * This module drives the REST pair deliberately: it is model-independent (any
 * key works, including models that cannot call the server-side tool), takes an
 * explicit result count and query operators, and returns ranked results in a
 * single call without a model completion.
 */

// DeepSeek documents `count` as 1–50 and bills per request, so stop at its
// default instead of spending the full range on every call.
const SEARCH_RESULT_LIMIT = 10;
const SNIPPET_LIMIT = 2000;
const FETCH_CONTENT_LIMIT = 8000;

// Only the fields this module reads; the whole payload is kept on `raw`, which
// is where `rerank_score` and `authority` stay available to callers.
interface DeepSeekSearchResult {
    title?: string;
    url?: string;
    snippet?: string;
    summary?: string;
    site_name?: string | null;
    date?: string | null;
}

interface DeepSeekFetchResult {
    title?: string;
    content?: string;
}

/**
 * Strip any OpenAI-compatible or Anthropic-compatible suffix so the
 * `/v1/tools/*` endpoints resolve on the API root. Preserve a configured proxy
 * origin/path instead of sending its credentials to api.deepseek.com.
 */
export function resolveDeepSeekApiRoot(model: Model<Api>, auth?: Extract<ResolvedAuth, { ok: true }>): string {
    const base = ((auth?.baseUrl || model.baseUrl || "https://api.deepseek.com")).replace(/\/+$/, "");
    return base.replace(/\/(?:anthropic|v\d+)(?:\/v\d+)?$/i, "");
}

/**
 * Keep the page content exactly as the API documents it ("content as Markdown
 * text"); only guard against a missing or oversized body.
 */
function truncateContent(text: string | undefined, limit = FETCH_CONTENT_LIMIT): string {
    const trimmed = (text || "").trim();
    return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
    for (const value of values) {
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (trimmed) return trimmed;
    }
    return "";
}

/** DeepSeek errors follow the OpenAI-compatible `{ error: { message, code } }` shape. */
async function deepSeekError(response: Response, label: "search" | "fetch"): Promise<Error> {
    const text = await response.text().catch(() => "");
    let message = "";
    try {
        message = JSON.parse(text)?.error?.message || "";
    } catch {
        // Fall back to the raw body below.
    }
    const detail = message || text.trim() || response.statusText;

    if (response.status === 401) {
        return new Error("No DeepSeek API key found. Run /login in pi and select DeepSeek, or set DEEPSEEK_API_KEY.");
    }
    if (response.status === 402) {
        return new Error(`DeepSeek ${label} failed: insufficient account balance. Top up the DeepSeek account and retry.`);
    }
    if (response.status === 403) {
        return new Error(`DeepSeek ${label} was rejected by the security policy: ${detail}`);
    }
    if (response.status === 404 && label === "fetch") {
        return new Error(`DeepSeek fetch could not retrieve usable page content: ${detail}`);
    }
    if (response.status === 429) {
        return new Error(`DeepSeek ${label} rate limit exceeded (5 QPS per account). Wait and retry: ${detail}`);
    }
    return new Error(`DeepSeek ${label} error (${response.status}): ${detail}`);
}

async function deepSeekPost<T>(
    root: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
): Promise<T> {
    const response = await fetch(`${root}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...headers,
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) throw await deepSeekError(response, path.endsWith("/fetch") ? "fetch" : "search");
    return (await response.json()) as T;
}

async function resolveDeepSeekTarget(
    ctx: ExtensionContext,
    model: Model<Api>,
): Promise<{ root: string; headers: Record<string, string> }> {
    const auth = await getAuth(ctx, model);
    if (!auth.ok) throw new Error(auth.error || "Failed to resolve DeepSeek credentials");

    const headers = mergeRequestHeaders(model.headers, auth.headers);
    const hasAuth = Object.entries(headers).some(([name, value]) =>
        value && ["authorization", "x-api-key"].includes(name.toLowerCase()));
    const apiKey = auth.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!hasAuth && apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (!hasAuth && !apiKey) {
        throw new Error("No DeepSeek API key found. Run /login in pi and select DeepSeek, or set DEEPSEEK_API_KEY.");
    }

    return { root: resolveDeepSeekApiRoot(model, auth), headers };
}

/** URL metadata in the same shape Gemini's url_context produces downstream. */
function toUrlContextMetadata(pages: Array<{ url: string; ok: boolean }>) {
    return {
        urlMetadata: pages.map((page) => ({
            retrievedUrl: page.url,
            urlRetrievalStatus: page.ok ? "URL_RETRIEVAL_STATUS_SUCCESS" : "URL_RETRIEVAL_STATUS_ERROR",
        })),
    };
}

function formatHit(hit: DeepSeekSearchResult, index: number): string {
    const title = hit.title || titleFromUrl(hit.url || "");
    const lines = [`## ${index + 1}. ${title}`];
    if (hit.url) lines.push(hit.url);
    const meta = [hit.site_name, hit.date].filter(Boolean).join(" · ");
    if (meta) lines.push(meta);
    // `summary` supersedes `snippet` when present: DeepSeek documents it as the
    // model-facing text, while `snippet` is display text.
    const body = firstNonEmpty(hit.summary, hit.snippet);
    // Blank line keeps a Markdown heading in the summary from being swallowed by
    // the metadata line above it.
    if (body) lines.push("", truncateContent(body, SNIPPET_LIMIT));
    return lines.join("\n");
}

type FetchedPage =
    | { url: string; ok: true; title?: string; content: string }
    | { url: string; ok: false; status: string };

async function fetchPages(
    root: string,
    urls: string[],
    headers: Record<string, string>,
    signal?: AbortSignal,
): Promise<FetchedPage[]> {
    return Promise.all(
        urls.map(async (url): Promise<FetchedPage> => {
            try {
                const data = await deepSeekPost<DeepSeekFetchResult>(root, "/v1/tools/fetch", { url }, headers, signal);
                const content = truncateContent(data.content);
                if (!content) return { url, ok: false, status: "No extractable Markdown content." };
                return { url, title: data.title || undefined, content, ok: true };
            } catch (error) {
                return {
                    url,
                    ok: false,
                    status: error instanceof Error ? error.message : String(error),
                };
            }
        }),
    );
}

function pushSource(sources: Source[], source: Source) {
    if (!sources.some((existing) => existing.url === source.url)) sources.push(source);
}

export async function callDeepSeekSearch(
    ctx: ExtensionContext,
    model: Model<Api>,
    query: string,
    urls?: string[],
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
): Promise<StreamResult> {
    const { root, headers } = await resolveDeepSeekTarget(ctx, model);

    onUpdate?.({
        content: [{ type: "text", text: `Searching the web with DeepSeek...` }],
        details: { streaming: true, searching: true },
    });

    // need_content=false: `content` is the full page, which would blow up the
    // tool result for little gain over `summary`. Requested URLs are fetched
    // separately through the matching fetch endpoint instead.
    const data = await deepSeekPost<{ results?: DeepSeekSearchResult[] }>(
        root,
        "/v1/tools/search",
        { query, count: SEARCH_RESULT_LIMIT, need_content: false },
        headers,
        signal,
    );
    // `results` is empty for a normal search with no matches, never an error.
    // URLs are what every downstream consumer keys on, so drop the rest.
    const hits = (data.results ?? []).filter((hit) => hit && typeof hit.url === "string" && hit.url);

    const searchResults: SearchResultDetail[] = hits.map((hit) => ({
        title: hit.title || titleFromUrl(hit.url!),
        url: hit.url,
        query,
        citedText: firstNonEmpty(hit.summary, hit.snippet) || undefined,
        source: "deepseek.tools.search",
        type: "search_result",
        pageAge: hit.date || undefined,
        raw: hit,
    }));
    const sources: Source[] = hits.map((hit) => ({
        title: hit.title || titleFromUrl(hit.url!),
        url: hit.url!,
    }));

    const lines = [`Search results for "${query}" via DeepSeek:`];
    if (hits.length === 0) lines.push("No results found.");
    hits.forEach((hit, i) => lines.push("", formatHit(hit, i)));

    let urlContextMetadata;
    if (urls?.length) {
        onUpdate?.({
            content: [{ type: "text", text: `Fetching ${urls.length} URL(s) with DeepSeek...` }],
            details: { streaming: true },
        });
        const pages = await fetchPages(root, urls, headers, signal);
        urlContextMetadata = toUrlContextMetadata(pages);
        for (const page of pages) {
            if (!page.ok) {
                lines.push("", `## Fetch failed: ${page.url}`, page.status || "Unknown error");
                continue;
            }
            lines.push("", `## Fetched: ${page.title || page.url}`, page.url, "", page.content);
            pushSource(sources, { title: page.title || titleFromUrl(page.url), url: page.url });
            searchResults.push({
                title: page.title || titleFromUrl(page.url),
                url: page.url,
                citedText: page.content,
                source: "deepseek.tools.fetch",
                type: "fetched_page",
                raw: page,
            });
        }
    }

    const sanitizedSearchResults = sanitizeSearchResults(searchResults);

    return {
        text: lines.join("\n"),
        sources: sources.length ? sources : deriveSources(sanitizedSearchResults),
        providerKind: "deepseek",
        // No streaming events exist on this path; nativeSearchUsed still marks
        // that DeepSeek's own search engine answered, matching the Ollama shape.
        nativeSearchUsed: true,
        searchQueries: [query],
        searchResults: sanitizedSearchResults,
        urlContextMetadata,
    };
}

/** url_context for DeepSeek: fetch each URL through the fetch endpoint, no model involved. */
export async function callDeepSeekUrlContext(
    ctx: ExtensionContext,
    model: Model<Api>,
    query: string,
    urls: string[],
    signal?: AbortSignal,
): Promise<StreamResult> {
    const { root, headers } = await resolveDeepSeekTarget(ctx, model);
    const pages = await fetchPages(root, urls, headers, signal);

    const lines = [`URL contents for: ${query}`];
    const sources: Source[] = [];
    const searchResults: SearchResultDetail[] = [];
    for (const page of pages) {
        if (!page.ok) {
            lines.push("", `## Failed: ${page.url}`, page.status || "Unknown error");
            continue;
        }
        lines.push("", `## ${page.title || page.url}`, page.url, "", page.content);
        pushSource(sources, { title: page.title || titleFromUrl(page.url), url: page.url });
        searchResults.push({
            title: page.title || titleFromUrl(page.url),
            url: page.url,
            citedText: page.content,
            source: "deepseek.tools.fetch",
            type: "fetched_page",
            raw: page,
        });
    }

    return {
        text: lines.join("\n"),
        sources,
        providerKind: "deepseek",
        nativeSearchUsed: false,
        searchResults: sanitizeSearchResults(searchResults),
        urlContextMetadata: toUrlContextMetadata(pages),
    };
}

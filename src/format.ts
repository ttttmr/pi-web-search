import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { applyCitations } from "./providers/google.ts";
import type { SearchResultDetail, Source, StreamResult } from "./providers/types.ts";

const ADDITIONAL_RESULTS_LIMIT = 8;

export interface FailedUrl {
    url: string;
    status?: string;
}

export function formatResult(text: string, details: any): AgentToolResult<any> {
    const { content, truncated } = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    return {
        content: [{ type: "text", text: content + (truncated ? "\n\n[Truncated]" : "") }],
        details
    };
}

/**
 * Resolve the answer text and sources the same way for every provider: apply
 * Gemini grounding citations (a no-op when there is no grounding metadata) and
 * prefer the provider's own source list when it is non-empty.
 */
export function resolveCitedText(result: StreamResult): { text: string; sources: Source[] } {
    const cited = applyCitations(result.text, result.groundingMetadata);
    return {
        text: cited.text,
        sources: result.sources?.length ? result.sources : cited.sources,
    };
}

/** Read Gemini's URL Context retrieval status, tolerating camelCase and snake_case keys. */
export function extractUrlContextStatus(result: StreamResult): { retrieved: string[]; failed: FailedUrl[] } {
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

    return { retrieved, failed };
}

/** Provider search results that are not already represented as sources. */
export function collectAdditionalSearchResults(
    result: StreamResult,
    sources: Source[],
    options: { dedupe?: boolean } = {},
): SearchResultDetail[] {
    const { dedupe = false } = options;
    const seen = new Set<string>();
    const collected: SearchResultDetail[] = [];

    for (const item of result.searchResults || []) {
        if (!item.url) continue;
        if (sources.some((source) => source.url === item.url)) continue;
        if (dedupe) {
            const key = `${item.title || ""}\t${item.url}`;
            if (seen.has(key)) continue;
            seen.add(key);
        }
        collected.push(item);
    }

    return collected;
}

function appendUrlStatusSection(summary: string, retrieved: string[], failed: FailedUrl[]): string {
    if (failed.length === 0) return summary;
    let result = summary + `\n\n## URL Status\n✅ Retrieved: ${retrieved.length}\n❌ Failed: ${failed.length}`;
    failed.forEach((f) => { result += `\n- ${f.url}: ${f.status}`; });
    return result;
}

function appendSourcesSection(summary: string, sources: Source[]): string {
    if (sources.length === 0 || summary.includes("## Sources")) return summary;
    return summary + `\n\n## Sources\n${sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`;
}

function appendAdditionalResultsSection(
    summary: string,
    results: SearchResultDetail[],
    options: { limit?: number; includeMeta?: boolean } = {},
): string {
    if (results.length === 0) return summary;
    const { limit, includeMeta = false } = options;
    const visible = limit !== undefined ? results.slice(0, limit) : results;

    const lines = visible.map((r, i) => {
        const label = r.title || r.url || `Result ${i + 1}`;
        const url = r.url ? ` - ${r.url}` : "";
        const meta = includeMeta
            ? [r.source, r.type, r.status, r.query ? `query=${r.query}` : undefined].filter(Boolean).join(", ")
            : "";
        return `${i + 1}. ${label}${url}${meta ? ` (${meta})` : ""}`;
    });

    let result = summary + `\n\n## Additional Search Results\n${lines.join("\n")}`;
    if (results.length > visible.length) {
        result += `\n... and ${results.length - visible.length} more results in tool details.`;
    }
    return result;
}

function buildResultDetails(
    result: StreamResult,
    sources: Source[],
    retrieved: string[] | undefined,
    failed: FailedUrl[],
    modelId: string,
): Record<string, any> {
    return {
        sources,
        providerKind: result.providerKind,
        nativeSearchUsed: result.nativeSearchUsed,
        nativeSearchEvents: result.nativeSearchEvents,
        nativeSearchCalls: result.nativeSearchCalls,
        searchQueries: result.searchQueries || result.groundingMetadata?.webSearchQueries,
        searchResults: result.searchResults,
        citations: result.citations,
        retrieved,
        failed: failed.length > 0 ? failed : undefined,
        model: modelId,
        grounded: sources.length > 0 || (result.searchResults?.length || 0) > 0,
        resultCount: result.searchResults?.length || sources.length,
    };
}

export function formatWebSearchResult(result: StreamResult, options: { modelId: string }): AgentToolResult<any> {
    const { text, sources } = resolveCitedText(result);
    const additionalResults = collectAdditionalSearchResults(result, sources, { dedupe: true });
    const { retrieved, failed } = extractUrlContextStatus(result);

    let summary = text;
    summary = appendUrlStatusSection(summary, retrieved, failed);
    summary = appendSourcesSection(summary, sources);
    summary = appendAdditionalResultsSection(summary, additionalResults);

    return {
        ...formatResult(summary, buildResultDetails(
            result,
            sources,
            retrieved.length > 0 ? retrieved : undefined,
            failed,
            options.modelId,
        )),
        ...(result.usage ? { usage: result.usage } : {}),
    };
}

export function formatUrlContextResult(result: StreamResult, options: { modelId: string }): AgentToolResult<any> {
    const { text, sources } = resolveCitedText(result);
    const additionalResults = collectAdditionalSearchResults(result, sources);
    const { retrieved, failed } = extractUrlContextStatus(result);
    const hasUrlContextMetadata = retrieved.length > 0
        || failed.length > 0
        || sources.length > 0
        || additionalResults.length > 0;

    let summary = text;
    summary = appendUrlStatusSection(summary, retrieved, failed);
    if (!hasUrlContextMetadata) {
        summary += `\n\n## URL Context Verification\n⚠️ No verified URL context metadata was returned by provider ${result.providerKind || "unknown"}. Treat the answer as ungrounded unless sources, retrieved URLs, or searchResults are present in tool details.`;
    }
    summary = appendSourcesSection(summary, sources);
    summary = appendAdditionalResultsSection(summary, additionalResults, {
        limit: ADDITIONAL_RESULTS_LIMIT,
        includeMeta: true,
    });

    return formatResult(summary, buildResultDetails(
        result,
        sources,
        retrieved,
        failed,
        options.modelId,
    ));
}

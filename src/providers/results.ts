import type { SearchResultDetail, Source } from "./types.ts";

export function pushUniqueSource(sources: Source[], source: Source): number {
    const url = source.url || "";
    const title = source.title || "Unknown";
    const existingIndex = sources.findIndex((s) => s.url === url && s.title === title);
    if (existingIndex >= 0) return existingIndex;
    sources.push({ title, url });
    return sources.length - 1;
}

export function pushUniqueString(values: string[], value: string | undefined | null) {
    if (!value || values.includes(value)) return;
    values.push(value);
}

export function pushUniqueSearchResult(results: SearchResultDetail[], result: SearchResultDetail) {
    const key = `${result.url || ""}\t${result.title || ""}\t${result.query || ""}\t${result.citedText || ""}\t${result.type || ""}`;
    const exists = results.some((item) => `${item.url || ""}\t${item.title || ""}\t${item.query || ""}\t${item.citedText || ""}\t${item.type || ""}` === key);
    if (!exists) results.push(result);
}

export function pushNativeSearchEvent(events: string[], event: string) {
    if (!events.includes(event)) events.push(event);
}

export function normalizeSearchUrl(url: string): string {
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

export function titleFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
        return lastSegment || parsed.hostname || url;
    } catch {
        return url;
    }
}

export function mergeSearchResultMetadata(results: SearchResultDetail[], extras: SearchResultDetail[]) {
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

export function isLikelyJunkSearchUrl(url: string | undefined): boolean {
    if (!url) return true;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
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

export function sanitizeSearchResults(results: SearchResultDetail[]): SearchResultDetail[] {
    const sanitized: SearchResultDetail[] = [];
    for (const result of results) {
        const normalizedUrl = result.url ? normalizeSearchUrl(result.url) : result.url;
        const normalized = { ...result, url: normalizedUrl };
        if (normalized.url && isLikelyJunkSearchUrl(normalized.url)) continue;
        pushUniqueSearchResult(sanitized, normalized);
    }
    return sanitized;
}

export function deriveSources(searchResults: SearchResultDetail[], citations: SearchResultDetail[] = []): Source[] {
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

export function normalizeCitedSources(sources: Source[]): Source[] {
    return sources
        .map((source) => ({ ...source, url: normalizeSearchUrl(source.url) }))
        .filter((source) => !isLikelyJunkSearchUrl(source.url));
}

export function preserveInlineCitations(text: string, citations: Array<{ endIndex?: number; title: string; url: string }>): { text: string; sources: Source[] } {
    const sources: Source[] = [];
    for (const citation of citations) {
        if (citation.url) pushUniqueSource(sources, { title: citation.title, url: citation.url });
    }
    return { text, sources };
}

export function applyIndexCitations(text: string, citations: Array<{ endIndex?: number; title: string; url: string }>): { text: string; sources: Source[] } {
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

export function applyTextCitations(text: string, citations: Array<{ citedText?: string; title: string; url: string }>): { text: string; sources: Source[] } {
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

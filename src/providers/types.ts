import type { Usage } from "@earendil-works/pi-ai";

export type ProviderKind = "google" | "openai" | "xai" | "anthropic" | "deepseek" | "ollama" | "virtual" | "unsupported";

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
    usage?: Usage;
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

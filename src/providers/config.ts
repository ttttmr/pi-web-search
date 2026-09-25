import type { Api, Model } from "@earendil-works/pi-ai";
import type { ProviderKind } from "./types.ts";
import type { ResolvedAuth } from "./auth.ts";

export type GoogleRequestBuilder = (model: Model<Api>, body: any, auth?: ResolvedAuth) => { url: string; headers: Record<string, string>; body: any };

export type ProviderConfig = {
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
            if (auth?.ok && auth.apiKey) {
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
                    "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform, pluginType: "GEMINI" })
                },
                body: {
                    project: projectId,
                    model: runtimeModel,
                    request: { contents: body.contents, ...(body.tools ? { tools: body.tools } : {}) },
                    requestType: "AGENT",
                    userAgent: "antigravity"
                }
            };
        }
    }
};

function isOllamaModel(model: Model<Api>): boolean {
    if (model.provider === "ollama-cloud") return true;
    try {
        return new URL(model.baseUrl).hostname === "ollama.com";
    } catch {
        return false;
    }
}

export function getProviderKind(model: Model<Api>): ProviderKind {
    if (model.provider === "opencodex") return "opencodex";
    if (model.provider === "antigravity" || model.api === "antigravity") return "google";
    if (GOOGLE_PROVIDERS[model.provider] || GOOGLE_PROVIDERS[model.api]) return "google";
    if (isOllamaModel(model)) return "ollama";
    if (model.provider === "xai" && model.api === "openai-responses") return "xai";
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

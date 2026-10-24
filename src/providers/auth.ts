import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";

export type ResolvedAuth =
    | { ok: true; apiKey?: string; headers?: ProviderHeaders; baseUrl?: string; }
    | { ok: false; error: string; };

function getEnvAuth(model: Model<Api>): Extract<ResolvedAuth, { ok: true }> | undefined {
    const apiKey = getEnvApiKey(model.provider);
    return apiKey ? { ok: true, apiKey } : undefined;
}

/**
 * Get API key and headers for a model.
 */
export async function getAuth(ctx: ExtensionContext, model: Model<Api>): Promise<ResolvedAuth> {
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

// Match Pi's case-insensitive merging, where null removes an earlier header.
export function mergeRequestHeaders(...sources: (ProviderHeaders | undefined)[]): Record<string, string> {
    const merged = new Map<string, [string, string]>();
    for (const source of sources) {
        for (const [name, value] of Object.entries(source || {})) {
            merged.delete(name.toLowerCase());
            if (value !== null) merged.set(name.toLowerCase(), [name, value]);
        }
    }
    return Object.fromEntries(merged.values());
}

function hasAuthHeader(headers?: ProviderHeaders): boolean {
    if (!headers) return false;
    return Object.entries(headers).some(([name, value]) => {
        if (!value) return false;
        const normalized = name.toLowerCase();
        return normalized === "authorization" || normalized === "x-api-key" || normalized === "x-goog-api-key";
    });
}

const OPENCODE_HOST = "opencode.ai";

function isOpenCodeModel(model: Model<Api>): boolean {
    if (model.provider === "opencode" || model.provider === "opencode-go") return true;
    try {
        return new URL(model.baseUrl).hostname === OPENCODE_HOST;
    } catch {
        return false;
    }
}

/**
 * OpenCode Zen/Go require a stable per-conversation session id on every
 * request. pi adds these headers to its own provider calls (see pi's
 * provider-attribution), but this extension talks to the API with fetch()
 * directly, so it has to mirror that or the gateway rejects the request with
 * MissingSessionID.
 */
export function getProviderSessionHeaders(model: Model<Api>, ctx: ExtensionContext): Record<string, string> | undefined {
    if (!isOpenCodeModel(model)) return undefined;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return undefined;
    return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

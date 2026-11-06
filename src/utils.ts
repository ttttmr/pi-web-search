import type { ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProviderKind } from "./api.ts";

// --- Model Selection ---

// Pi's extension loader cannot import model-schema; keep this list exhaustive instead.
const THINKING_LEVELS = {
    off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true,
} satisfies Record<ModelThinkingLevel, true>;

function isWebSearchThinkingLevel(value: unknown): value is ModelThinkingLevel {
    return typeof value === "string" && Object.hasOwn(THINKING_LEVELS, value);
}

const SUPPORTED_PROVIDERS = ["deepseek", "google-generative-ai", "antigravity", "xai", "openai-responses", "azure-openai-responses", "openai-codex-responses", "anthropic-messages", "ollama"];

type WebSearchModelConfig =
    | { status: "missing"; path: string; }
    | { status: "configured"; path: string; provider: string; modelId: string; thinkingLevel?: ModelThinkingLevel; }
    | { status: "invalid"; path: string; error: string; };

function isSupportedSearchModel(model: Model<Api> | undefined): model is Model<Api> {
    if (!model) return false;
    return getProviderKind(model) !== "unsupported";
}

function describeModel(model: Model<Api>): string {
    return `${model.id} (${model.provider}/${model.api})`;
}

function getWebSearchConfigPath(): string {
    return process.env.PI_WEB_SEARCH_CONFIG || join(getAgentDir(), "web-search.json");
}

function readWebSearchModelConfig(): WebSearchModelConfig {
    const path = getWebSearchConfigPath();
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (error: any) {
        if (error?.code === "ENOENT") return { status: "missing", path };
        return { status: "invalid", path, error: error?.message || String(error) };
    }

    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch (error: any) {
        return { status: "invalid", path, error: `Invalid JSON: ${error?.message || String(error)}` };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: "invalid", path, error: "Expected a JSON object with provider and model fields" };
    }

    const provider = parsed.provider;
    const modelId = parsed.model ?? parsed.modelId;
    if (typeof provider !== "string" || provider.trim() === "") {
        return { status: "invalid", path, error: "Missing required string field: provider" };
    }
    if (typeof modelId !== "string" || modelId.trim() === "") {
        return { status: "invalid", path, error: "Missing required string field: model" };
    }

    const thinkingLevel: unknown = parsed.thinking;
    if (thinkingLevel !== undefined && !isWebSearchThinkingLevel(thinkingLevel)) {
        return { status: "invalid", path, error: `Invalid thinking level: ${JSON.stringify(thinkingLevel)}. Use one of: ${Object.keys(THINKING_LEVELS).join(", ")}` };
    }

    return { status: "configured", path, provider: provider.trim(), modelId: modelId.trim(), thinkingLevel };
}

export async function getModel(ctx: ExtensionContext): Promise<Model<Api> | undefined> {
    // Only use the currently selected model. Do not silently fall back to another
    // configured model, because that can surprise users with unexpected API costs.
    return isSupportedSearchModel(ctx.model) ? ctx.model : undefined;
}

export async function getWebSearchModel(ctx: ExtensionContext): Promise<Model<Api> | undefined> {
    const config = readWebSearchModelConfig();
    if (config.status === "invalid") return undefined;

    if (config.status === "configured") {
        const model = ctx.modelRegistry.find(config.provider, config.modelId);
        return isSupportedSearchModel(model) ? model : undefined;
    }

    return getModel(ctx);
}

// Why getWebSearchModel returned no usable model, for error reporting.
type WebSearchModelResolution =
    | { status: "ok"; model: Model<Api>; thinkingLevel?: ModelThinkingLevel }
    | { status: "invalid_config"; path: string; error: string }
    | { status: "configured_model_not_found"; path: string; provider: string; modelId: string }
    | { status: "configured_model_unsupported"; path: string; model: Model<Api> }
    | { status: "current_model_unsupported" };

export async function resolveWebSearchModel(ctx: ExtensionContext): Promise<WebSearchModelResolution> {
    const config = readWebSearchModelConfig();
    if (config.status === "invalid") {
        return { status: "invalid_config", path: config.path, error: config.error };
    }

    if (config.status === "configured") {
        const model = ctx.modelRegistry.find(config.provider, config.modelId);
        if (!model) {
            return { status: "configured_model_not_found", path: config.path, provider: config.provider, modelId: config.modelId };
        }
        if (!isSupportedSearchModel(model)) {
            return { status: "configured_model_unsupported", path: config.path, model };
        }
        return { status: "ok", model, thinkingLevel: config.thinkingLevel };
    }

    const model = await getModel(ctx);
    return model ? { status: "ok", model } : { status: "current_model_unsupported" };
}

// --- Error Results ---

export function webSearchModelError(ctx: ExtensionContext, resolution: Exclude<WebSearchModelResolution, { status: "ok" }>): AgentToolResult<any> {
    switch (resolution.status) {
        case "invalid_config":
            return {
                content: [{ type: "text", text: `Failed: Invalid web search model config at ${resolution.path}: ${resolution.error}. Fix the file or remove it to use the current conversation model.` }],
                details: {
                    error: "invalid_config",
                    configPath: resolution.path,
                    configError: resolution.error,
                    supportedProviders: SUPPORTED_PROVIDERS,
                }
            };
        case "configured_model_not_found":
            return {
                content: [{ type: "text", text: `Failed: Configured web search model ${resolution.provider}/${resolution.modelId} from ${resolution.path} is not a registered model. Fix the file or remove it to use the current conversation model.` }],
                details: {
                    error: "configured_model_not_found",
                    configPath: resolution.path,
                    configuredProvider: resolution.provider,
                    configuredModel: resolution.modelId,
                    supportedProviders: SUPPORTED_PROVIDERS,
                }
            };
        case "configured_model_unsupported":
            return unsupportedModelError(ctx, resolution.model, { configPath: resolution.path });
        case "current_model_unsupported":
            return missingConfigResult(ctx);
    }
}

function unsupportedModelError(_ctx: ExtensionContext, model: Model<Api>, opts: { configPath?: string }): AgentToolResult<any> {
    const reason = `${describeModel(model)} has no native web search (API: ${model.api})`;

    if (opts.configPath) {
        return {
            content: [{ type: "text", text: `Failed: Configured web search model ${reason}. Fix or remove ${opts.configPath} to use the current model.` }],
            details: {
                error: "unsupported_model",
                configPath: opts.configPath,
                configuredModel: describeModel(model),
                configuredProvider: model.provider,
                api: model.api,
            }
        };
    }

    return {
        content: [{ type: "text", text: `Failed: ${reason}. Select a search-capable model (Gemini, xAI Grok, OpenAI/Azure/Codex Responses, Anthropic, DeepSeek, Ollama Cloud) or set a dedicated search model in ${getWebSearchConfigPath()}.` }],
        details: {
            error: "unsupported_model",
            currentModel: describeModel(model),
            api: model.api,
            configPath: getWebSearchConfigPath(),
        }
    };
}

export function missingConfigResult(ctx: ExtensionContext): AgentToolResult<any> {
    if (ctx.model) return unsupportedModelError(ctx, ctx.model, {});
    return {
        content: [{ type: "text", text: "Failed: No model selected for web search." }],
        details: { error: "missing_config" }
    };
}

// Builds the failure result for a failed resolveWebSearchModel call by
// re-resolving. Kept for callers that resolved via getWebSearchModel.
export function missingWebSearchConfigResult(ctx: ExtensionContext): AgentToolResult<any> {
    const config = readWebSearchModelConfig();

    if (config.status === "invalid") {
        return webSearchModelError(ctx, { status: "invalid_config", path: config.path, error: config.error });
    }

    if (config.status === "configured") {
        const model = ctx.modelRegistry.find(config.provider, config.modelId);
        if (!model) {
            return webSearchModelError(ctx, { status: "configured_model_not_found", path: config.path, provider: config.provider, modelId: config.modelId });
        }
        return unsupportedModelError(ctx, model, { configPath: config.path });
    }

    return missingConfigResult(ctx);
}

export function errorResult(e: Error): AgentToolResult<any> {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], details: { error: true } };
}

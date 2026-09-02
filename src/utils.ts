import type { ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getProviderKind } from "./api.ts";

// --- Formatting ---

export function formatResult(text: string, details: any): AgentToolResult<any> {
    const { content, truncated } = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    return {
        content: [{ type: "text", text: content + (truncated ? "\n\n[Truncated]" : "") }],
        details
    };
}

// --- Model Selection ---

const SUPPORTED_PROVIDERS = ["google-generative-ai", "antigravity", "openai-responses", "azure-openai-responses", "openai-codex-responses", "anthropic-messages"];
const WEB_SEARCH_CONFIG_PATH = join(homedir(), ".pi", "agent", "web-search.json");

type WebSearchModelConfig =
    | { status: "missing"; path: string; }
    | { status: "configured"; path: string; provider: string; modelId: string; }
    | { status: "invalid"; path: string; error: string; };

function isSupportedSearchModel(model: Model<Api> | undefined): model is Model<Api> {
    if (!model) return false;
    return getProviderKind(model) !== "unsupported";
}

function describeModel(model: Model<Api>): string {
    return `${model.id} (${model.provider}/${model.api})`;
}

function getWebSearchConfigPath(): string {
    return process.env.PI_WEB_SEARCH_CONFIG || WEB_SEARCH_CONFIG_PATH;
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

    return { status: "configured", path, provider: provider.trim(), modelId: modelId.trim() };
}

function getAvailableSupportedModels(ctx: ExtensionContext): string[] {
    try {
        return ctx.modelRegistry.getAvailable()
            .filter(isSupportedSearchModel)
            .map(describeModel);
    } catch {
        return [];
    }
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

// --- Error Results ---

export function missingConfigResult(ctx: ExtensionContext): AgentToolResult<any> {
    const availableSupportedModels = getAvailableSupportedModels(ctx);
    const supportedList = SUPPORTED_PROVIDERS.join(", ");

    if (ctx.model) {
        const availableHint = availableSupportedModels.length > 0
            ? ` Select one of these configured supported models manually: ${availableSupportedModels.join(", ")}.`
            : ` Configure and select a supported provider: ${supportedList}.`;
        const msg = `The current model ${describeModel(ctx.model)} does not support native web search. pi-web-search will not switch to another configured model automatically to avoid unexpected API costs.${availableHint}`;
        return {
            content: [{ type: "text", text: `Failed: ${msg}` }],
            details: {
                error: "unsupported_model",
                currentModel: describeModel(ctx.model),
                availableSupportedModels,
                supportedProviders: SUPPORTED_PROVIDERS,
            }
        };
    }

    const availableHint = availableSupportedModels.length > 0
        ? ` Select one of these configured supported models manually: ${availableSupportedModels.join(", ")}.`
        : ` Configure and select a supported provider: ${supportedList}.`;
    const msg = `No current model selected for web search.${availableHint}`;
    return {
        content: [{ type: "text", text: `Failed: ${msg}` }],
        details: {
            error: "missing_config",
            availableSupportedModels,
            supportedProviders: SUPPORTED_PROVIDERS,
        }
    };
}

export function missingWebSearchConfigResult(ctx: ExtensionContext): AgentToolResult<any> {
    const config = readWebSearchModelConfig();
    const availableSupportedModels = getAvailableSupportedModels(ctx);
    const supportedList = SUPPORTED_PROVIDERS.join(", ");

    if (config.status === "invalid") {
        return {
            content: [{ type: "text", text: `Failed: Invalid web search model config at ${config.path}: ${config.error}. Fix the file or remove it to use the current conversation model.` }],
            details: {
                error: "invalid_config",
                configPath: config.path,
                configError: config.error,
                supportedProviders: SUPPORTED_PROVIDERS,
            }
        };
    }

    if (config.status === "configured") {
        const model = ctx.modelRegistry.find(config.provider, config.modelId);
        if (!model) {
            return {
                content: [{ type: "text", text: `Failed: Configured web search model ${config.provider}/${config.modelId} from ${config.path} was not found. Fix the file or remove it to use the current conversation model.` }],
                details: {
                    error: "configured_model_not_found",
                    configPath: config.path,
                    configuredProvider: config.provider,
                    configuredModel: config.modelId,
                    availableSupportedModels,
                    supportedProviders: SUPPORTED_PROVIDERS,
                }
            };
        }
        return {
            content: [{ type: "text", text: `Failed: Configured web search model ${describeModel(model)} from ${config.path} does not support native web search. Configure a model backed by ${supportedList}, or remove the file to use the current conversation model.` }],
            details: {
                error: "unsupported_model",
                configPath: config.path,
                configuredModel: describeModel(model),
                configuredProvider: config.provider,
                availableSupportedModels,
                supportedProviders: SUPPORTED_PROVIDERS,
            }
        };
    }

    return missingConfigResult(ctx);
}

export function errorResult(e: Error): AgentToolResult<any> {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], details: { error: true } };
}

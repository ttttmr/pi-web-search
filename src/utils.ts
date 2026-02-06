import type { ExtensionContext, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { type Model } from "@mariozechner/pi-ai";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";

// --- Formatting ---

export function formatResult(text: string, details: any): AgentToolResult<any> {
    const { content, truncated } = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    return {
        content: [{ type: "text", text: content + (truncated ? "\n\n[Truncated]" : "") }],
        details
    };
}

// --- Model Selection ---

export async function getModel(ctx: ExtensionContext): Promise<Model<any> | undefined> {
    // flash first, big first: 3-flash -> 2.5-flash -> 2.0-flash
    // provider priority: google-gemini-cli -> google-antigravity -> google -> google-generative-ai
    const models = ctx.modelRegistry.getAvailable();
    
    const flashModels = [
        /gemini-3.*flash/i,
        /gemini-2\.5.*flash/i,
        /gemini-2\.0.*flash/i,
        /gemini.*flash/i,
    ];
    
    const providers = [
        "google-gemini-cli",
        "google-antigravity", 
        "google",
        "google-generative-ai",
    ];
    
    // Filter to only Google-compatible models (those with supported api/provider)
    const googleModels = models.filter(m => 
        providers.includes(m.provider) ||
        m.api === "google-generative-ai" || 
        m.api === "google-gemini-cli"
    );
    
    // Try each flash pattern in priority order
    for (const pattern of flashModels) {
        const matching = googleModels.filter(m => pattern.test(m.id));
        if (matching.length === 0) continue;
        
        // Among matches, pick by provider priority
        for (const provider of providers) {
            const model = matching.find(m => m.provider === provider);
            if (model) return model;
        }
        
        // Fall back to first match if no priority provider found
        return matching[0];
    }
    
    // No flash model found, try any Google model by provider priority
    for (const provider of providers) {
        const model = googleModels.find(m => m.provider === provider);
        if (model) return model;
    }
    
    // Return first available Google model if any
    return googleModels[0];
}

// --- Error Results ---

export function missingConfigResult(ctx: ExtensionContext): AgentToolResult<any> {
    const msg = ctx.model && ["google-gemini-cli", "google-antigravity"].includes(ctx.model.provider)
        ? `Provider ${ctx.model.provider} requires valid OAuth credentials.`
        : "No Google Gemini configuration found. Please configure GEMINI_API_KEY.";
    return { content: [{ type: "text", text: `Failed: ${msg}` }], details: { error: "missing_config" } };
}

export function errorResult(e: Error): AgentToolResult<any> {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], details: { error: true } };
}

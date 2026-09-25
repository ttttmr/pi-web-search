# pi-web-search

Provider-native web search for [pi](https://pi.dev) with Gemini + URL Context, xAI Grok, OpenAI Responses variants, Anthropic, Ollama Cloud, OpenCodex, and OpenCode Zen/Go.

## Tools

### `web_search`

Search the web using your currently selected model. Automatically picks the right provider API:

| Provider | API |
|---|---|
| Google Gemini | Grounding with Google Search |
| xAI Grok | Responses API `web_search` |
| OpenAI | Responses API web search |
| Azure OpenAI | Responses API web search (`azure-openai-responses`) |
| OpenAI Codex | Codex Responses API web search (`openai-codex-responses`) |
| GitHub Copilot | OpenAI Responses API web search via Copilot credentials |
| Anthropic | Messages API web search |
| Ollama Cloud | Ollama web search API (`/api/web_search`, standalone REST) |
| OpenCodex | `/v1/alpha/search`, routed by OpenCodex to the current model's resolved provider |
| OpenCode Zen / Go | Responses API web search (models that use the `openai-responses` API) |

GitHub Copilot OpenAI Responses models are supported, including Business and Enterprise seats whose API endpoint is resolved from their authenticated Copilot credentials. This includes models such as `gpt-5.6-sol`.

OpenCode Zen and OpenCode Go Responses models (for example `opencode-go/gpt-5.6-luna` or `opencode-go/grok-4.6`) use the same Responses web search. OpenCode routes traffic per conversation, so `web_search` sends the `x-opencode-session` and `x-opencode-client` headers pi uses, keyed to the active session. Only models exposed through that Responses API are supported: OpenCode `chat/completions` models have no provider-native search tool, and the gateway's Anthropic Messages models are unverified.

Ollama Cloud models (provider `ollama-cloud` or any model hosted on `ollama.com`) call Ollama's standalone web search API rather than a model tool. Auth is `OLLAMA_API_KEY` or `/login ollama-cloud`. Any `urls` are fetched through `web_fetch`. A local Ollama daemon is out of scope — the official `@ollama/pi-web-search` package covers its `/api/experimental/*` endpoints.

OpenCodex models send the current `model.id` to the configured OpenCodex base URL. OpenCodex resolves aliases, combos, and the real adapter, then uses that provider's native search path when available; it does not make pi choose or maintain a second search model. The generated `opencodex-loopback` placeholder is omitted from auth headers, while a real configured OpenCodex data-plane key is sent as `x-opencodex-api-key`.

Supports passing up to 20 additional URLs to analyze alongside the query. Successful `web_search` results are collapsed by default in pi; expand the tool call to inspect the full answer and source details.

### `url_context`

Gemini and Ollama Cloud. Analyze up to 20 public URLs — web pages, documents, images, and YouTube videos. Gemini uses native URL Context retrieval with verified metadata; Ollama uses its `web_fetch` endpoint (web pages and documents only).

When using `google-generative-ai`, YouTube URLs are passed as `file_data` for native video understanding.

## Install

```bash
pi install npm:pi-web-search
```

## Usage

No extra config needed. Select a supported current model in pi and the tools auto-detect the matching provider API.

`web_search` will not scan configured models and pick one automatically when the current model does not support native search. To use a dedicated search model, opt in explicitly with `web-search.json` in pi's agent directory (by default `~/.pi/agent/`; respects `PI_CODING_AGENT_DIR`):

```json
{
  "provider": "openai",
  "model": "gpt-5.1"
}
```

When this file exists, `web_search` uses the configured provider/model first. If it is missing, `web_search` uses the current conversation model. If the selected model does not support native search, the tool returns an error instead of falling back.

For OpenAI Responses models (including Azure, Codex, and Copilot), `web_search` inherits the agent's current thinking level on each call. Enabled levels are clamped to the selected search model's supported levels and translated through its `thinkingLevelMap` using pi's model metadata. This also applies when `web-search.json` selects a dedicated search model. Higher effort can increase latency and cost.

When thinking is off or unavailable, or the search model is non-reasoning, the request omits `reasoning` and leaves the choice to the provider. Off does not force reasoning off: some models reject `reasoning.effort: "none"`. Google, Anthropic, xAI, and Ollama behavior is unchanged.

`url_context` is automatically removed from active tools when using a model that supports neither Gemini URL Context nor Ollama web fetch.

## Test

```bash
cp .env.example .env   # edit with your models
npm test               # unit tests
npm run test:real:web-search
npm run test:real:url-context
```

## License

MIT

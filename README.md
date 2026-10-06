# pi-web-search

Provider-native web search for [pi](https://pi.dev) with Gemini + URL Context, xAI Grok, OpenAI Responses variants, Anthropic, DeepSeek, Ollama Cloud, and OpenCode Zen/Go.

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
| DeepSeek | Anthropic-compatible Messages API `web_search_20260209` |
| Ollama Cloud | Ollama web search API (`/api/web_search`, standalone REST) |
| OpenCode Zen / Go | Responses API web search (models that use the `openai-responses` API) |

GitHub Copilot OpenAI Responses models are supported, including Business and Enterprise seats whose API endpoint is resolved from their authenticated Copilot credentials. This includes models such as `gpt-5.6-sol`.

OpenCode Zen and OpenCode Go Responses models (for example `opencode-go/gpt-5.6-luna` or `opencode-go/grok-4.6`) use the same Responses web search. OpenCode routes traffic per conversation, so `web_search` sends the `x-opencode-session` and `x-opencode-client` headers pi uses, keyed to the active session. Only models exposed through that Responses API are supported: OpenCode `chat/completions` models have no provider-native search tool, and the gateway's Anthropic Messages models are unverified. Grok ids such as `opencode-go/grok-4.6` get the Grok request shape described below unless `compat.webSearchDialect` is `"openai"`; the session headers are unchanged.

Grok models on OpenAI-compatible Responses gateways use Grok's request shape: no `web_search_call.results` include (Grok rejects it with 400), a message-array input, and inline citations. By default this applies to the native `xai` provider and to any model id starting with `grok-`, `grok.`, or equal to `grok`. Set `"compat": { "webSearchDialect": "grok" }` or `"openai"` in `models.json` to override detection, on the model or on a provider that serves only Grok; model-level `compat` wins over provider-level. Only the request shape changes: auth, error labels, and `providerKind` still follow the provider, and gateway Grok still inherits the session thinking level. Only the native `xai` provider omits `reasoning.effort`.

Ollama Cloud models (provider `ollama-cloud` or any model hosted on `ollama.com`) call Ollama's standalone web search API rather than a model tool. Auth is `OLLAMA_API_KEY` or `/login ollama-cloud`. Any `urls` are fetched through `web_fetch`. A local Ollama daemon is out of scope — the official `@ollama/pi-web-search` package covers its `/api/experimental/*` endpoints.

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

To search at a fixed level instead, add `thinking` to `web-search.json`. It replaces the inherited level for every search and goes through the same clamping and mapping; `"off"` omits `reasoning`. Valid values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Like the inherited level, it only affects OpenAI Responses models.

```json
{
  "provider": "openai-codex",
  "model": "gpt-6-luna",
  "thinking": "low"
}
```

When thinking is off or unavailable, or the search model is non-reasoning, the request omits `reasoning` and leaves the choice to the provider. Off does not force reasoning off: some models reject `reasoning.effort: "none"`. Google, Anthropic, xAI, and Ollama behavior is unchanged.

`url_context` is automatically removed from active tools when using a model that supports neither Gemini URL Context nor Ollama web fetch.

### DeepSeek

Select a model from pi's `deepseek` provider and authenticate with `/login` or
`DEEPSEEK_API_KEY`. Search automatically uses DeepSeek's Anthropic-compatible
endpoint (`https://api.deepseek.com/anthropic/v1/messages`) with the same model
and credentials. A configured proxy base URL is preserved and routed through
its `/anthropic/v1/messages` endpoint; the proxy must support that route.

To use DeepSeek search with another conversation model, set `web-search.json`:

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash"
}
```

The selected model must be registered in pi and support DeepSeek's server-side
search. Unlike the standalone `pi-deepseek-search` extension, this integration
uses the model selected by this project's configuration; it does not read
`DEEPSEEK_SEARCH_MODEL` or silently switch models. Do not load both extensions,
since they both register `web_search`.

DeepSeek requests support cancellation through pi. Additional `urls` are included in
the prompt; Gemini's verified URL Context retrieval remains Gemini-only.

This integration was informed by [pi-deepseek-search](https://github.com/bxff/pi-deepseek-search).

## Test

```bash
cp .env.example .env   # edit with your models
npm test               # unit tests
npm run test:real:web-search
npm run test:real:url-context
```

## License

MIT

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callApiStream } from '../src/api.ts';
import { createModelScopedToolManager } from '../src/index.ts';
import { getModel, getWebSearchModel, missingConfigResult, missingWebSearchConfigResult } from '../src/utils.ts';
import { urlContext } from '../src/url_context.ts';
import { webSearch } from '../src/web_search.ts';

const OPENAI_CODEX_TOKEN = [
  'eyJhbGciOiJub25lIn0',
  'eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF90ZXN0In0sIm5vdGUiOiLguJrguLHguI3guIrguLU_MTAifQ',
  'signature',
].join('.');

function sse(events) {
  return events.map((event) => {
    const name = event.event ? `event: ${event.event}\n` : '';
    return `${name}data: ${JSON.stringify(event.data)}\n\n`;
  }).join('');
}

function mockCtx(apiKey, model = undefined, headers = undefined, baseUrl = undefined) {
  const resolvedApiKey = arguments.length === 0 ? 'test-key' : apiKey;
  return {
    model,
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: resolvedApiKey, headers, baseUrl };
      },
      getAvailable() {
        return model ? [model] : [];
      },
    },
  };
}

function makeResponse(events) {
  return new Response(sse(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeCopilotResponsesModel() {
  return {
    id: 'gpt-5.6-sol',
    provider: 'github-copilot',
    api: 'openai-responses',
    baseUrl: 'https://api.individual.githubcopilot.com',
    reasoning: true,
    headers: {},
  };
}

function makeMinimalOpenAIResponse() {
  return makeResponse([
    { data: { type: 'response.done', response: { output: [] } } },
  ]);
}

for (const [provider, api, baseUrl, apiKey] of [
  ['openai', 'openai-responses', 'https://api.openai.com/v1', 'test-key'],
  ['openai-codex', 'openai-codex-responses', 'https://chatgpt.com/backend-api', OPENAI_CODEX_TOKEN],
  ['azure-openai', 'azure-openai-responses', 'https://example-resource.cognitiveservices.azure.com/openai/v1', 'test-key'],
  ['github-copilot', 'openai-responses', 'https://api.individual.githubcopilot.com', 'test-key'],
]) {
  test(`${provider} web search leaves reasoning effort to the provider default`, async () => {
    const previousFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async (_url, init) => {
      requestCount++;
      const body = JSON.parse(init.body);
      assert.equal(Object.hasOwn(body, 'reasoning'), false);
      assert.deepEqual(body.tools, [{ type: 'web_search' }]);
      return makeMinimalOpenAIResponse();
    };

    try {
      for (const reasoning of [true, false]) {
        await callApiStream(mockCtx(apiKey), {
          id: 'gpt-6-astra', provider, api, baseUrl, reasoning, headers: {},
        }, { contents: [{ parts: [{ text: 'Search OpenAI docs' }] }] });
      }
      assert.equal(requestCount, 2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}

test('GitHub Copilot Responses uses the credential-specific base URL exposed by pi', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.business.githubcopilot.com/responses');
    assert.equal(init.headers.authorization, 'Bearer copilot-token');
    assert.equal(JSON.parse(init.body).model, 'gpt-5.6-sol');
    return makeMinimalOpenAIResponse();
  };

  try {
    await callApiStream(
      mockCtx('copilot-token', undefined, undefined, 'https://api.business.githubcopilot.com'),
      makeCopilotResponsesModel(),
      { contents: [{ parts: [{ text: 'Search with Copilot' }] }] },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub Copilot Responses derives Business and Individual endpoints from older pi tokens', async () => {
  const previousFetch = globalThis.fetch;
  const expectedUrls = [
    'https://api.business.githubcopilot.com/responses',
    'https://api.individual.githubcopilot.com/responses',
  ];
  let requestIndex = 0;
  globalThis.fetch = async (url) => {
    assert.equal(url, expectedUrls[requestIndex++]);
    return makeMinimalOpenAIResponse();
  };

  try {
    for (const proxyEndpoint of [
      'proxy.business.githubcopilot.com',
      'proxy.individual.githubcopilot.com',
    ]) {
      await callApiStream(
        mockCtx(`tid=test;proxy-ep=${proxyEndpoint};exp=9999999999`),
        makeCopilotResponsesModel(),
        { contents: [{ parts: [{ text: 'Search with Copilot' }] }] },
      );
    }
    assert.equal(requestIndex, expectedUrls.length);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub Copilot Responses rejects unsafe proxy endpoints and falls back to the model URL', async () => {
  const previousFetch = globalThis.fetch;
  const unsafeTokens = [
    'tid=test;exp=9999999999',
    'tid=test;proxy-ep=evil.example.com;exp=9999999999',
    'tid=test;proxy-ep=proxy.business.githubcopilot.com.evil.example;exp=9999999999',
    'tid=test;proxy-ep=proxy.business.githubcopilot.com/path;exp=9999999999',
    'tid=test;proxy-ep=proxy.business.githubcopilot.com:443;exp=9999999999',
    'tid=test;proxy-ep=https://proxy.business.githubcopilot.com;exp=9999999999',
    'tid=test;proxy-ep=proxy.business.githubcopilot.com;proxy-ep=proxy.individual.githubcopilot.com;exp=9999999999',
  ];
  let requestCount = 0;
  globalThis.fetch = async (url) => {
    requestCount++;
    assert.equal(url, 'https://api.individual.githubcopilot.com/responses');
    return makeMinimalOpenAIResponse();
  };

  try {
    for (const token of unsafeTokens) {
      await callApiStream(
        mockCtx(token),
        makeCopilotResponsesModel(),
        { contents: [{ parts: [{ text: 'Search with Copilot' }] }] },
      );
    }
    assert.equal(requestCount, unsafeTokens.length);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('non-Copilot Responses ignores proxy endpoint text in its API key', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://example.test/v1/responses');
    return makeMinimalOpenAIResponse();
  };

  try {
    await callApiStream(mockCtx(
      'tid=test;proxy-ep=proxy.business.githubcopilot.com;exp=9999999999',
      undefined,
      undefined,
      'https://api.business.githubcopilot.com',
    ), {
      id: 'gpt-test',
      provider: 'openai',
      api: 'openai-responses',
      baseUrl: 'https://example.test/v1',
      reasoning: false,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with OpenAI' }] }] });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Azure OpenAI Responses appends /responses to the configured Azure v1 base URL', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://example-resource.cognitiveservices.azure.com/openai/v1/responses');
    assert.equal(init.headers.authorization, 'Bearer entra-token');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-5.6-terra');
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    return makeMinimalOpenAIResponse();
  };

  try {
    const result = await callApiStream(mockCtx('entra-token'), {
      id: 'gpt-5.6-terra',
      provider: 'azure-openai',
      api: 'azure-openai-responses',
      baseUrl: 'https://example-resource.cognitiveservices.azure.com/openai/v1/',
      reasoning: false,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with Azure OpenAI' }] }] });

    assert.equal(result.providerKind, 'openai');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI stream exposes native search calls, queries, URLs, and citations', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tools[0].type, 'web_search');
    assert.deepEqual(body.include, ['web_search_call.action.sources', 'web_search_call.results']);
    assert.equal(body.tool_choice, undefined);
    return makeResponse([
      { data: { type: 'response.web_search_call.in_progress', item_id: 'ws_1' } },
      { data: { type: 'response.web_search_call.searching', item_id: 'ws_1' } },
      { data: { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws_1', status: 'searching', action: { type: 'search', query: 'OpenAI docs', queries: ['OpenAI docs'], sources: [{ type: 'url', url: 'https://platform.openai.com/docs/guides/tools-web-search' }] } } } },
      { data: { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1', content: [] } } },
      { data: { type: 'response.content_part.added', part: { type: 'output_text', text: '', annotations: [] } } },
      { data: { type: 'response.output_text.delta', delta: 'See OpenAI docs' } },
      { data: { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', start_index: 4, end_index: 15, url_citation: { title: 'OpenAI docs', url: 'https://platform.openai.com/docs/guides/tools-web-search' } } } },
      { data: { type: 'response.web_search_call.completed', item_id: 'ws_1' } },
      { data: { type: 'response.completed', response: { output: [
        { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', queries: ['OpenAI docs'], sources: [{ type: 'url', url: 'https://platform.openai.com/docs/guides/tools-web-search' }] } },
        { type: 'message', content: [{ type: 'output_text', text: 'See OpenAI docs', annotations: [{ type: 'url_citation', start_index: 4, end_index: 15, url_citation: { title: 'OpenAI docs', url: 'https://platform.openai.com/docs/guides/tools-web-search' } }] }] },
      ] } } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(), {
      id: 'gpt-test',
      provider: 'proxy-provider',
      api: 'openai-responses',
      baseUrl: 'https://example.test/v1',
      reasoning: false,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search OpenAI docs' }] }] });

    assert.equal(result.providerKind, 'openai');
    assert.equal(result.nativeSearchUsed, true);
    assert.deepEqual(result.nativeSearchEvents, [
      'response.web_search_call.in_progress',
      'response.web_search_call.searching',
      'response.web_search_call.completed',
    ]);
    assert.deepEqual(result.searchQueries, ['OpenAI docs']);
    assert.equal(result.nativeSearchCalls.length >= 1, true);
    assert.equal(result.searchResults.some((item) => item.url === 'https://platform.openai.com/docs/guides/tools-web-search' && item.title === 'OpenAI docs'), true);
    assert.equal(result.citations.some((item) => item.title === 'OpenAI docs' && item.url.includes('/tools-web-search')), true);
    assert.equal(result.sources[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
    assert.equal(result.sources[0].title, 'OpenAI docs');
    assert.equal(result.sources.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI stream falls back to env API key when resolved auth has no credential', async () => {
  const previousFetch = globalThis.fetch;
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'env-openai-key';
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer env-openai-key');
    return makeResponse([
      { data: { type: 'response.output_text.delta', delta: 'Fallback auth accepted' } },
      { data: { type: 'response.done', response: { output: [] } } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(undefined), {
      id: 'gpt-test',
      provider: 'openai',
      api: 'openai-responses',
      baseUrl: 'https://example.test/v1',
      reasoning: false,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with fallback auth' }] }] });

    assert.equal(result.text, 'Fallback auth accepted');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
  }
});

test('OpenAI Codex stream uses Codex Responses transport with native web search', async () => {
  const previousFetch = globalThis.fetch;
  const tokenPayload = OPENAI_CODEX_TOKEN.split('.')[1];
  assert.match(tokenPayload, /[-_]/);
  assert.notEqual(tokenPayload.length % 4, 0);
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(init.headers.authorization, `Bearer ${OPENAI_CODEX_TOKEN}`);
    assert.equal(init.headers['chatgpt-account-id'], 'acct_test');
    assert.equal(init.headers.originator, 'codex_cli_rs');
    assert.equal(Object.keys(init.headers).some((key) => key.toLowerCase() === 'openai-beta'), false);

    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-5.5');
    assert.deepEqual(body.input, [{
      role: 'user',
      content: [{ type: 'input_text', text: 'Search with Codex' }],
    }]);
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.deepEqual(body.include, ['web_search_call.action.sources']);
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.parallel_tool_calls, true);
    assert.equal(body.stream, true);
    assert.equal(body.store, false);

    return makeResponse([
      { data: { type: 'response.web_search_call.in_progress', item_id: 'ws_codex' } },
      { data: { type: 'response.output_text.delta', delta: 'Codex search answer' } },
      { data: { type: 'response.web_search_call.completed', item_id: 'ws_codex' } },
      { data: { type: 'response.done', response: { output: [
        { type: 'web_search_call', id: 'ws_codex', status: 'completed', action: { type: 'search', query: 'Codex web search' } },
      ] } } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(OPENAI_CODEX_TOKEN), {
      id: 'gpt-5.5',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: true,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] });

    assert.equal(result.providerKind, 'openai');
    assert.equal(result.nativeSearchUsed, true);
    assert.equal(result.text, 'Codex search answer');
    assert.deepEqual(result.searchQueries, ['Codex web search']);
    assert.equal(result.nativeSearchCalls.length, 1);
    assert.equal(result.nativeSearchCalls[0].status, 'completed');
    assert.deepEqual(result.nativeSearchCalls[0].queries, ['Codex web search']);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI Codex stream stops after terminal event without waiting for EOF', async () => {
  const previousFetch = globalThis.fetch;
  let cancelled = false;
  let timeout;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse([
        { data: { type: 'response.output_text.delta', delta: 'Terminal Codex answer' } },
        { data: { type: 'response.done', response: { output: [
          { type: 'web_search_call', id: 'ws_terminal', status: 'completed', action: { type: 'search', query: 'terminal query' } },
        ] } } },
      ])));
    },
    cancel() {
      cancelled = true;
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  try {
    const result = await Promise.race([
      callApiStream(mockCtx(OPENAI_CODEX_TOKEN), {
        id: 'gpt-5.5',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        headers: {},
      }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Codex stream did not stop')), 250);
      }),
    ]);

    assert.equal(result.text, 'Terminal Codex answer');
    assert.deepEqual(result.searchQueries, ['terminal query']);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timeout);
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI Codex stream rejects error events with server message', async () => {
  const previousFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse([
        { data: { type: 'error', error: { message: 'Codex SSE error message' } } },
      ])));
    },
    cancel() {
      cancelled = true;
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  try {
    await assert.rejects(
      callApiStream(mockCtx(OPENAI_CODEX_TOKEN), {
        id: 'gpt-5.5',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        headers: {},
      }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] }),
      /Codex SSE error message/,
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI Codex stream rejects response.failed with server message', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse([
    { data: { type: 'response.failed', response: { error: { message: 'Codex response failed message' } } } },
    { data: { type: 'response.done', response: { output: [] } } },
  ]);

  try {
    await assert.rejects(
      callApiStream(mockCtx(OPENAI_CODEX_TOKEN), {
        id: 'gpt-5.5',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        headers: {},
      }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] }),
      /Codex response failed message/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI Codex stream preserves custom headers over defaults', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer explicit-auth');
    assert.equal(init.headers['chatgpt-account-id'], 'explicit-account');
    assert.equal(init.headers.originator, 'custom-originator');
    assert.equal(init.headers['openai-beta'], 'custom-beta');
    assert.equal(init.headers.accept, 'application/x-test-stream');
    assert.equal(Object.keys(init.headers).filter((key) => key.toLowerCase() === 'originator').length, 1);
    return makeResponse([
      { data: { type: 'response.output_text.delta', delta: 'Custom headers preserved' } },
      { data: { type: 'response.done', response: { output: [] } } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(OPENAI_CODEX_TOKEN, undefined, {
      authorization: 'Bearer explicit-auth',
      'ChatGPT-Account-ID': 'explicit-account',
      'openai-beta': 'custom-beta',
      accept: 'application/x-test-stream',
    }), {
      id: 'gpt-5.5',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: true,
      headers: { Originator: 'custom-originator' },
    }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] });

    assert.equal(result.text, 'Custom headers preserved');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI Codex stream accepts headers-only authentication', async () => {
  const previousFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async (_url, init) => {
    fetched = true;
    assert.equal(init.headers.authorization, 'Bearer headers-only-token');
    assert.equal(init.headers['chatgpt-account-id'], 'headers-only-account');
    return makeResponse([
      { data: { type: 'response.output_text.delta', delta: 'Headers-only auth accepted' } },
      { data: { type: 'response.done', response: { output: [] } } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(undefined, undefined, {
      authorization: 'Bearer headers-only-token',
      'ChatGPT-Account-ID': 'headers-only-account',
    }), {
      id: 'gpt-5.5',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: true,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] });

    assert.equal(fetched, true);
    assert.equal(result.text, 'Headers-only auth accepted');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI Codex stream normalizes mixed-case Authorization with auth headers winning', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const authorizationKeys = Object.keys(init.headers).filter((key) => key.toLowerCase() === 'authorization');
    assert.deepEqual(authorizationKeys, ['authorization']);
    assert.equal(init.headers.authorization, 'Bearer auth-oauth-token');
    assert.doesNotMatch(init.headers.authorization, /model-stale-token/);
    return makeResponse([
      { data: { type: 'response.done', response: { output: [] } } },
    ]);
  };

  try {
    await callApiStream(mockCtx(undefined, undefined, {
      authorization: 'Bearer auth-oauth-token',
      'ChatGPT-Account-ID': 'collision-account',
    }), {
      id: 'gpt-5.5',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: true,
      headers: { Authorization: 'Bearer model-stale-token' },
    }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI Codex stream rejects missing authentication', async () => {
  const previousFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return makeResponse([]);
  };

  try {
    await assert.rejects(
      callApiStream(mockCtx(undefined), {
        id: 'gpt-5.5',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        headers: {},
      }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] }),
      /No OAuth credential configured for openai-codex model/,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI Codex stream preserves partial results from incomplete responses', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse([
    { data: { type: 'response.web_search_call.in_progress', item_id: 'ws_codex_partial' } },
    { data: { type: 'response.output_text.delta', delta: 'Partial Codex answer' } },
    { data: { type: 'response.incomplete', response: {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        { type: 'web_search_call', id: 'ws_codex_partial', status: 'completed', action: { type: 'search', query: 'partial Codex query' } },
      ],
    } } },
  ]);

  try {
    const result = await callApiStream(mockCtx(OPENAI_CODEX_TOKEN), {
      id: 'gpt-5.5',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: true,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] });

    assert.equal(result.text, 'Partial Codex answer');
    assert.equal(result.nativeSearchCalls.length, 1);
    assert.equal(result.nativeSearchCalls[0].status, 'completed');
    assert.deepEqual(result.nativeSearchCalls[0].queries, ['partial Codex query']);
    assert.deepEqual(result.searchQueries, ['partial Codex query']);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI stream preserves partial results from incomplete responses', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse([
    { data: { type: 'response.web_search_call.in_progress', item_id: 'ws_partial' } },
    { data: { type: 'response.output_text.delta', delta: 'Partial OpenAI answer' } },
    { data: { type: 'response.incomplete', response: {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        { type: 'web_search_call', id: 'ws_partial', status: 'completed', action: { type: 'search', query: 'partial query' } },
      ],
    } } },
  ]);

  try {
    const result = await callApiStream(mockCtx(), {
      id: 'gpt-test',
      provider: 'openai',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      reasoning: false,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with OpenAI' }] }] });

    assert.equal(result.text, 'Partial OpenAI answer');
    assert.equal(result.nativeSearchCalls.length, 1);
    assert.equal(result.nativeSearchCalls[0].status, 'completed');
    assert.deepEqual(result.nativeSearchCalls[0].queries, ['partial query']);
    assert.deepEqual(result.searchQueries, ['partial query']);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Anthropic stream exposes server web search, result URLs, and citation details', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 10 });
    assert.equal(body.tool_choice, undefined);
    return makeResponse([
      { data: { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'OpenAI docs' } } } },
      { data: { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', title: 'OpenAI docs', url: 'https://platform.openai.com/docs/guides/tools-web-search', page_age: null, encrypted_content: 'x' }] } } },
      { data: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
      { data: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'OpenAI docs explain web search.' } } },
      { data: { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', cited_text: 'OpenAI docs', title: 'OpenAI docs', url: 'https://platform.openai.com/docs/guides/tools-web-search', encrypted_index: 'abc' } } } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(), {
      id: 'claude-test',
      provider: 'proxy-provider',
      api: 'anthropic-messages',
      baseUrl: 'https://example.test/anthropic',
      maxTokens: 4096,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search OpenAI docs' }] }] });

    assert.equal(result.providerKind, 'anthropic');
    assert.equal(result.nativeSearchUsed, true);
    assert.deepEqual(result.nativeSearchEvents, [
      'anthropic.content_block_start.server_tool_use.web_search',
      'anthropic.content_block_start.web_search_tool_result',
    ]);
    assert.deepEqual(result.searchQueries, ['OpenAI docs']);
    assert.equal(result.nativeSearchCalls[0].id, 'srv_1');
    assert.equal(result.searchResults.some((item) => item.url === 'https://platform.openai.com/docs/guides/tools-web-search'), true);
    assert.equal(result.citations.some((item) => item.citedText === 'OpenAI docs'), true);
    assert.equal(result.sources[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Anthropic stream falls back to env API key when resolved auth has no credential', async () => {
  const previousFetch = globalThis.fetch;
  const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'env-fallback-key';
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers['x-api-key'], 'env-fallback-key');
    return makeResponse([
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fallback auth accepted' } } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(undefined), {
      id: 'claude-test',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://example.test/anthropic',
      maxTokens: 4096,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with fallback auth' }] }] });

    assert.equal(result.text, 'Fallback auth accepted');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
  }
});

test('Anthropic stream does not replace existing auth headers with env API key fallback', async () => {
  const previousFetch = globalThis.fetch;
  const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'env-fallback-key';
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers['x-api-key'], 'header-key');
    return makeResponse([
      { data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Header auth accepted' } } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(undefined, undefined, { 'x-api-key': 'header-key' }), {
      id: 'claude-test',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://example.test/anthropic',
      maxTokens: 4096,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with header auth' }] }] });

    assert.equal(result.text, 'Header auth accepted');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
  }
});

test('Google stream falls back to env API key when resolved auth has no credential', async () => {
  const previousFetch = globalThis.fetch;
  const previousGeminiApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'env-gemini-key';
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers['x-goog-api-key'], 'env-gemini-key');
    return makeResponse([
      { data: { candidates: [{ content: { parts: [{ text: 'Fallback auth accepted' }] } }] } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(undefined), {
      id: 'gemini-test',
      provider: 'google',
      api: 'google-generative-ai',
      baseUrl: 'https://example.test/gemini/v1beta',
      headers: {},
    }, {
      contents: [{ role: 'user', parts: [{ text: 'Search with fallback auth' }] }],
      tools: [{ google_search: {} }],
    });

    assert.equal(result.text, 'Fallback auth accepted');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiApiKey;
  }
});

test('Google stream exposes grounding queries, chunks, support citations, and resolves redirect URLs', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'HEAD') {
      assert.equal(url, 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc');
      return new Response('', {
        status: 302,
        headers: { location: 'https://platform.openai.com/docs/guides/tools-web-search' },
      });
    }
    assert.equal(JSON.parse(init.body).tools[0].google_search instanceof Object, true);
    return makeResponse([
      { data: { candidates: [{ content: { parts: [{ text: 'Gemini grounded answer' }] } }] } },
      { data: { candidates: [{ groundingMetadata: {
        webSearchQueries: ['OpenAI docs'],
        groundingChunks: [{ web: { title: 'OpenAI docs', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc' } }],
        groundingSupports: [{ segment: { text: 'Gemini grounded answer', endIndex: 22 }, groundingChunkIndices: [0] }],
      } }] } },
    ]);
  };

  try {
    const result = await callApiStream(mockCtx(), {
      id: 'gemini-test',
      provider: 'proxy-provider',
      api: 'google-generative-ai',
      baseUrl: 'https://example.test/gemini/v1beta',
      headers: {},
    }, {
      contents: [{ role: 'user', parts: [{ text: 'Search OpenAI docs' }] }],
      tools: [{ google_search: {} }],
    });

    assert.equal(result.providerKind, 'google');
    assert.equal(result.nativeSearchUsed, true);
    assert.deepEqual(result.searchQueries, ['OpenAI docs']);
    assert.equal(result.searchResults[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
    assert.equal(result.citations[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
    assert.equal(result.citations[0].citedText, 'Gemini grounded answer');
    assert.equal(result.sources[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('getModel does not fall back to another configured supported model', async () => {
  const currentModel = {
    id: 'local-test',
    provider: 'local-provider',
    api: 'openai-chat-completions',
    baseUrl: 'https://example.test/local',
    headers: {},
  };
  const supportedModel = {
    id: 'gpt-test',
    provider: 'proxy-provider',
    api: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    headers: {},
  };
  const ctx = {
    model: currentModel,
    modelRegistry: {
      getAvailable() {
        return [currentModel, supportedModel];
      },
    },
  };

  assert.equal(await getModel(ctx), undefined);
  const result = missingConfigResult(ctx);
  assert.match(result.content[0].text, /will not switch to another configured model automatically/i);
  assert.match(result.content[0].text, /gpt-test/);
  assert.equal(result.details.error, 'unsupported_model');
  assert.deepEqual(result.details.availableSupportedModels, ['gpt-test (proxy-provider/openai-responses)']);
});

test('getModel accepts Azure OpenAI Responses models', async () => {
  const model = {
    id: 'gpt-5.6-terra',
    provider: 'azure-openai',
    api: 'azure-openai-responses',
    baseUrl: 'https://example-resource.cognitiveservices.azure.com/openai/v1',
    headers: {},
  };
  const ctx = {
    model,
    modelRegistry: {
      getAvailable() {
        return [model];
      },
    },
  };

  assert.equal(await getModel(ctx), model);
});

test('getModel accepts openai-codex Responses models', async () => {
  const model = {
    id: 'gpt-5.5',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    headers: {},
  };
  const ctx = {
    model,
    modelRegistry: {
      getAvailable() {
        return [model];
      },
    },
  };

  assert.equal(await getModel(ctx), model);
});

test('getWebSearchModel prefers explicit config over current conversation model', async () => {
  const previousConfigPath = process.env.PI_WEB_SEARCH_CONFIG;
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-search-test-'));
  const configPath = join(dir, 'web-search.json');
  const currentModel = {
    id: 'current-test',
    provider: 'current-provider',
    api: 'openai-responses',
    baseUrl: 'https://example.test/current',
    headers: {},
  };
  const configuredModel = {
    id: 'gpt-test',
    provider: 'proxy-provider',
    api: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    headers: {},
  };
  const ctx = {
    model: currentModel,
    modelRegistry: {
      find(provider, modelId) {
        return provider === configuredModel.provider && modelId === configuredModel.id ? configuredModel : undefined;
      },
      getAvailable() {
        return [currentModel, configuredModel];
      },
    },
  };

  try {
    process.env.PI_WEB_SEARCH_CONFIG = configPath;
    await writeFile(configPath, JSON.stringify({ provider: 'proxy-provider', model: 'gpt-test' }));

    assert.equal(await getWebSearchModel(ctx), configuredModel);
  } finally {
    if (previousConfigPath === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
    else process.env.PI_WEB_SEARCH_CONFIG = previousConfigPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('getWebSearchModel reports unsupported configured model instead of falling back', async () => {
  const previousConfigPath = process.env.PI_WEB_SEARCH_CONFIG;
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-search-test-'));
  const configPath = join(dir, 'web-search.json');
  const currentModel = {
    id: 'current-test',
    provider: 'current-provider',
    api: 'openai-responses',
    baseUrl: 'https://example.test/current',
    headers: {},
  };
  const unsupportedConfiguredModel = {
    id: 'local-test',
    provider: 'local-provider',
    api: 'openai-chat-completions',
    baseUrl: 'https://example.test/local',
    headers: {},
  };
  const ctx = {
    model: currentModel,
    modelRegistry: {
      find(provider, modelId) {
        return provider === unsupportedConfiguredModel.provider && modelId === unsupportedConfiguredModel.id ? unsupportedConfiguredModel : undefined;
      },
      getAvailable() {
        return [currentModel];
      },
    },
  };

  try {
    process.env.PI_WEB_SEARCH_CONFIG = configPath;
    await writeFile(configPath, JSON.stringify({ provider: 'local-provider', model: 'local-test' }));

    assert.equal(await getWebSearchModel(ctx), undefined);
    const result = missingWebSearchConfigResult(ctx);
    assert.match(result.content[0].text, /Configured web search model local-test/i);
    assert.match(result.content[0].text, /does not support native web search/i);
    assert.equal(result.details.error, 'unsupported_model');
    assert.equal(result.details.configPath, configPath);
  } finally {
    if (previousConfigPath === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
    else process.env.PI_WEB_SEARCH_CONFIG = previousConfigPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('url_context rejects non-Gemini providers with a clear error', async () => {
  const model = {
    id: 'gpt-test',
    provider: 'proxy-provider',
    api: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    headers: {},
  };

  const result = await urlContext(
    'tool-1',
    { query: 'Summarize this URL', urls: ['https://example.com'] },
    new AbortController().signal,
    undefined,
    mockCtx('test-key', model),
  );

  assert.match(result.content[0].text, /requires a Google Gemini-compatible model/i);
  assert.equal(result.details.error, 'unsupported_provider');
  assert.equal(result.details.providerKind, 'openai');
  assert.equal(result.details.grounded, false);
});

test('url_context warns when Gemini returns no verified URL context metadata', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => makeResponse([
    { data: { candidates: [{ content: { parts: [{ text: 'Plain summary without metadata' }] } }] } },
  ]);

  try {
    const model = {
      id: 'gemini-test',
      provider: 'proxy-provider',
      api: 'google-generative-ai',
      baseUrl: 'https://example.test/gemini/v1beta',
      headers: {},
    };

    const result = await urlContext(
      'tool-2',
      { query: 'Summarize this URL', urls: ['https://example.com'] },
      new AbortController().signal,
      undefined,
      mockCtx('test-key', model),
    );

    assert.match(result.content[0].text, /No verified URL context metadata/i);
    assert.equal(result.details.providerKind, 'google');
    assert.equal(result.details.grounded, false);
    assert.deepEqual(result.details.sources, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('web_search does not add visible verification warning when native metadata is absent', async () => {
  const previousFetch = globalThis.fetch;
  const previousConfigPath = process.env.PI_WEB_SEARCH_CONFIG;
  process.env.PI_WEB_SEARCH_CONFIG = join(tmpdir(), `pi-web-search-missing-${process.pid}.json`);
  globalThis.fetch = async () => makeResponse([
    { data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Ungrounded answer without metadata.' } } },
  ]);

  try {
    const model = {
      id: 'claude-test',
      provider: 'proxy-provider',
      api: 'anthropic-messages',
      baseUrl: 'https://example.test/anthropic',
      maxTokens: 4096,
      headers: {},
    };

    const result = await webSearch(
      'tool-3',
      { query: 'Search something' },
      new AbortController().signal,
      undefined,
      mockCtx('test-key', model),
    );

    assert.doesNotMatch(result.content[0].text, /Search Verification/i);
    assert.doesNotMatch(result.content[0].text, /No verified native search metadata/i);
    assert.equal(result.details.providerKind, 'anthropic');
    assert.equal(result.details.nativeSearchUsed, false);
    assert.equal(result.details.grounded, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousConfigPath === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
    else process.env.PI_WEB_SEARCH_CONFIG = previousConfigPath;
  }
});

test('model-scoped tool manager removes url_context for non-Gemini and restores it for Gemini', async () => {
  let activeTools = ['read', 'web_search', 'url_context'];
  const changes = [];
  const manager = createModelScopedToolManager({
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(toolNames) {
      activeTools = [...toolNames];
      changes.push([...toolNames]);
    },
  });

  manager.sync({ id: 'gpt-test', provider: 'proxy-provider', api: 'openai-responses' });
  assert.deepEqual(activeTools, ['read', 'web_search']);

  manager.sync({ id: 'gemini-test', provider: 'proxy-provider', api: 'google-generative-ai' });
  assert.deepEqual(activeTools, ['read', 'web_search', 'url_context']);
  assert.equal(changes.length >= 2, true);
});

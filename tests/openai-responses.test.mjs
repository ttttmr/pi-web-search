import test from 'node:test';
import assert from 'node:assert/strict';
import { callApiStream } from '../src/api.ts';
import { webSearch } from '../src/web_search.ts';
import { createMockCtx as mockCtx } from './helpers.mjs';
import { OPENAI_CODEX_TOKEN, makeResponse, makeCopilotResponsesModel, makeMinimalOpenAIResponse } from './fixtures.mjs';

for (const [provider, api, baseUrl, apiKey] of [
  ['openai', 'openai-responses', 'https://api.openai.com/v1', 'test-key'],
  ['openai-codex', 'openai-codex-responses', 'https://chatgpt.com/backend-api', OPENAI_CODEX_TOKEN],
  ['azure-openai', 'azure-openai-responses', 'https://example-resource.cognitiveservices.azure.com/openai/v1', 'test-key'],
  ['github-copilot', 'openai-responses', 'https://api.individual.githubcopilot.com', 'test-key'],
]) {
  test(`${provider} web search selects the minimum without sending unsupported none`, async (t) => {
    const bodies = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      assert.deepEqual(body.tools, [{ type: 'web_search' }]);
      return makeMinimalOpenAIResponse();
    });

    for (const [reasoning, thinkingLevelMap, thinking] of [
      [true, { off: 'none' }, undefined],
      [true, { off: null, minimal: null }, undefined],
      [false, {}, undefined],
      [true, { off: 'none' }, 'off'],
      [true, Object.fromEntries(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => [level, null])), undefined],
    ]) {
      await callApiStream(mockCtx(apiKey), {
        id: 'search-model', provider, api, baseUrl, reasoning, thinkingLevelMap, headers: {},
      }, { contents: [{ parts: [{ text: 'Search OpenAI docs' }] }] }, undefined, undefined, thinking);
    }
    assert.equal(bodies.length, 5);
    assert.deepEqual(bodies.map((body) => body.reasoning), [
      { effort: 'none' }, { effort: 'low' }, undefined, undefined, undefined,
    ]);
  });
}

for (const [label, provider, api, baseUrl, apiKey] of [
  ['OpenAI OAuth', 'openai', 'openai-responses', 'https://api.openai.com/v1', 'chatgpt-access-token'],
  ['OpenAI API key', 'openai', 'openai-responses', 'https://api.openai.com/v1', 'sk-proj-test'],
  ['Azure OpenAI', 'azure-openai', 'azure-openai-responses', 'https://example-resource.cognitiveservices.azure.com/openai/v1', 'entra-token'],
  ['GitHub Copilot', 'github-copilot', 'openai-responses', 'https://api.individual.githubcopilot.com', 'copilot-token'],
]) {
  test(`${label} Responses web search sends message-array input without Codex routing`, async (t) => {
    let requestCount = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      requestCount++;
      assert.equal(url, `${baseUrl}/responses`);
      assert.equal(init.headers.authorization, `Bearer ${apiKey}`);
      assert.equal(Object.hasOwn(init.headers, 'chatgpt-account-id'), false);
      assert.equal(Object.hasOwn(init.headers, 'originator'), false);

      const body = JSON.parse(init.body);
      assert.deepEqual(body.input, [{
        role: 'user',
        content: [{ type: 'input_text', text: 'Search OpenAI docs' }],
      }]);
      assert.deepEqual(body.tools, [{ type: 'web_search' }]);
      assert.deepEqual(body.include, ['web_search_call.action.sources', 'web_search_call.results']);
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(Object.hasOwn(body, 'instructions'), false);
      assert.equal(Object.hasOwn(body, 'tool_choice'), false);
      assert.equal(Object.hasOwn(body, 'parallel_tool_calls'), false);
      return makeResponse([
        { data: { type: 'response.output_text.delta', delta: 'OpenAI search answer' } },
        { data: { type: 'response.completed', response: { output: [
          { type: 'web_search_call', id: 'ws_responses', status: 'completed', action: { type: 'search', query: 'OpenAI docs' } },
        ] } } },
      ]);
    });

    const result = await callApiStream(mockCtx(apiKey), {
      id: 'gpt-test', provider, api, baseUrl, reasoning: false, headers: {},
    }, { contents: [{ parts: [{ text: 'Search OpenAI docs' }] }] });

    assert.equal(requestCount, 1);
    assert.equal(result.text, 'OpenAI search answer');
    assert.equal(result.providerKind, 'openai');
    assert.equal(result.nativeSearchUsed, true);
    assert.deepEqual(result.searchQueries, ['OpenAI docs']);
  });
}

test('GitHub Copilot Responses uses the credential-specific base URL exposed by pi', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.business.githubcopilot.com/responses');
    assert.equal(init.headers.authorization, 'Bearer copilot-token');
    assert.equal(JSON.parse(init.body).model, 'gpt-5.6-sol');
    return makeMinimalOpenAIResponse();
  });

  await callApiStream(
    mockCtx('copilot-token', undefined, undefined, 'https://api.business.githubcopilot.com'),
    makeCopilotResponsesModel(),
    { contents: [{ parts: [{ text: 'Search with Copilot' }] }] },
  );
});

test('GitHub Copilot Responses derives Business and Individual endpoints from older pi tokens', async (t) => {
  const expectedUrls = [
    'https://api.business.githubcopilot.com/responses',
    'https://api.individual.githubcopilot.com/responses',
  ];
  let requestIndex = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, expectedUrls[requestIndex++]);
    return makeMinimalOpenAIResponse();
  });

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
});

test('GitHub Copilot Responses rejects unsafe proxy endpoints and falls back to the model URL', async (t) => {
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
  t.mock.method(globalThis, 'fetch', async (url) => {
    requestCount++;
    assert.equal(url, 'https://api.individual.githubcopilot.com/responses');
    return makeMinimalOpenAIResponse();
  });

  for (const token of unsafeTokens) {
    await callApiStream(
      mockCtx(token),
      makeCopilotResponsesModel(),
      { contents: [{ parts: [{ text: 'Search with Copilot' }] }] },
    );
  }
  assert.equal(requestCount, unsafeTokens.length);
});

test('non-Copilot Responses ignores proxy endpoint text in its API key', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://example.test/v1/responses');
    return makeMinimalOpenAIResponse();
  });

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
});

test('Azure OpenAI Responses appends /responses to the configured Azure v1 base URL', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://example-resource.cognitiveservices.azure.com/openai/v1/responses');
    assert.equal(init.headers.authorization, 'Bearer entra-token');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-5.6-terra');
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    return makeMinimalOpenAIResponse();
  });

  const result = await callApiStream(mockCtx('entra-token'), {
    id: 'gpt-5.6-terra',
    provider: 'azure-openai',
    api: 'azure-openai-responses',
    baseUrl: 'https://example-resource.cognitiveservices.azure.com/openai/v1/',
    reasoning: false,
    headers: {},
  }, { contents: [{ parts: [{ text: 'Search with Azure OpenAI' }] }] });

  assert.equal(result.providerKind, 'openai');
});

test('OpenAI stream exposes native search calls, queries, URLs, and citations', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
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
  });

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
});

test('OpenCode Zen/Go Responses calls send the pi session headers the gateway requires', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, headers: init.headers });
    return makeResponse([
      { data: { type: 'response.web_search_call.completed', item_id: 'ws_go' } },
      { data: { type: 'response.output_item.done', item: {
        type: 'web_search_call',
        id: 'ws_go',
        status: 'completed',
        action: { type: 'search', query: 'capital of France', sources: [{ type: 'url', url: 'https://example.test/paris' }] },
      } } },
      { data: { type: 'response.output_text.delta', delta: 'Paris[[1]](https://example.test/paris)' } },
      { data: { type: 'response.completed', response: { output: [] } } },
    ]);
  });

  const ctx = mockCtx('opencode-go-key', undefined, undefined, undefined, { sessionId: 'session-abc' });

  const result = await callApiStream(ctx, {
    id: 'gpt-5.6-luna',
    provider: 'opencode-go',
    api: 'openai-responses',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    reasoning: true,
    headers: {},
  }, { contents: [{ parts: [{ text: 'capital of France' }] }] });

  assert.equal(requests[0].url, 'https://opencode.ai/zen/go/v1/responses');
  assert.equal(requests[0].headers['x-opencode-session'], 'session-abc');
  assert.equal(requests[0].headers['x-opencode-client'], 'pi');
  assert.equal(result.providerKind, 'openai');
  assert.equal(result.nativeSearchUsed, true);
  assert.equal(result.sources[0].url, 'https://example.test/paris');
});

test('session headers stay off non-OpenCode providers', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = { url, headers: init.headers };
    return makeMinimalOpenAIResponse();
  });

  const ctx = mockCtx('test-key', undefined, undefined, undefined, { sessionId: 'session-abc' });

  await callApiStream(ctx, {
    id: 'gpt-6-astra',
    provider: 'openai',
    api: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    headers: {},
  }, { contents: [{ parts: [{ text: 'Search OpenAI docs' }] }] });

  assert.equal(Object.hasOwn(request.headers, 'x-opencode-session'), false);
  assert.equal(Object.hasOwn(request.headers, 'x-opencode-client'), false);
});

test('xAI Responses uses Grok web search schema and inline citations', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.x.ai/v1/responses');
    assert.equal(init.headers.authorization, 'Bearer xai-test-key');

    const body = JSON.parse(init.body);
    assert.equal(body.model, 'grok-4.6');
    assert.deepEqual(body.input, [{ role: 'user', content: 'Search xAI docs' }]);
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.deepEqual(body.include, ['web_search_call.action.sources']);
    assert.equal(body.store, false);

    return makeResponse([
      { data: { type: 'response.web_search_call.searching', item_id: 'ws_xai' } },
      { data: { type: 'response.output_item.done', item: {
        type: 'web_search_call',
        id: 'ws_xai',
        status: 'completed',
        action: { type: 'search', query: 'Search xAI docs', sources: [{ type: 'url', url: 'https://docs.x.ai/' }] },
      } } },
      { data: { type: 'response.output_text.delta', delta: 'xAI docs answer[[1]](https://docs.x.ai/)' } },
      { data: { type: 'response.output_text.annotation.added', annotation: {
        type: 'url_citation',
        start_index: 0,
        end_index: 13,
        title: '1',
        url: 'https://docs.x.ai/',
      } } },
      { data: { type: 'response.completed', response: { output: [
        { type: 'web_search_call', id: 'ws_xai', status: 'completed', action: { type: 'search', query: 'Search xAI docs', sources: [{ type: 'url', url: 'https://docs.x.ai/' }] } },
        { type: 'message', content: [{ type: 'output_text', text: 'xAI docs answer[[1]](https://docs.x.ai/)', annotations: [{ type: 'url_citation', title: '1', url: 'https://docs.x.ai/' }] }] },
      ] } } },
    ]);
  });

  const result = await callApiStream(mockCtx('xai-test-key'), {
    id: 'grok-4.6',
    provider: 'xai',
    api: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    reasoning: true,
    headers: {},
  }, { contents: [{ parts: [{ text: 'Search xAI docs' }] }] });

  assert.equal(result.providerKind, 'xai');
  assert.equal(result.nativeSearchUsed, true);
  assert.deepEqual(result.searchQueries, ['Search xAI docs']);
  assert.equal(result.nativeSearchCalls[0].provider, 'xai');
  assert.equal(result.text, 'xAI docs answer[[1]](https://docs.x.ai/)');
  assert.equal(result.sources[0].title, '1');
  assert.equal(result.sources[0].url, 'https://docs.x.ai/');
});

test('Grok on an OpenAI-compatible gateway uses Grok web search schema', async (t) => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://gateway.example.com/v1/responses');
    bodies.push(JSON.parse(init.body));
    return makeResponse([
      { data: { type: 'response.output_text.delta', delta: 'Gateway answer[[1]](https://docs.x.ai/)' } },
      // Grok's annotation spans the inline [[1]](url) markup itself; the OpenAI
      // parser would append a duplicate "[1]" marker at end_index.
      { data: { type: 'response.output_text.annotation.added', annotation: {
        type: 'url_citation', start_index: 14, end_index: 39, title: '1', url: 'https://docs.x.ai/',
      } } },
      { data: { type: 'response.completed', response: { output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Gateway answer[[1]](https://docs.x.ai/)', annotations: [{ type: 'url_citation', title: '1', url: 'https://docs.x.ai/' }] }] },
      ] } } },
    ]);
  });

  const gateway = { provider: 'custom-gateway', api: 'openai-responses', baseUrl: 'https://gateway.example.com/v1', reasoning: false, headers: {} };
  const result = await callApiStream(mockCtx('test-key'), { ...gateway, id: 'grok-4.7' },
    { contents: [{ parts: [{ text: 'Search xAI docs' }] }] });
  // Same gateway, non-Grok model: keeps the OpenAI schema.
  const openaiResult = await callApiStream(mockCtx('test-key'), { ...gateway, id: 'gpt-6-astra' },
    { contents: [{ parts: [{ text: 'Search xAI docs' }] }] });

  assert.deepEqual(bodies[0].input, [{ role: 'user', content: 'Search xAI docs' }]);
  assert.deepEqual(bodies[0].include, ['web_search_call.action.sources']);
  // Inline citations are preserved as-is; no index marker is inserted.
  assert.equal(result.text, 'Gateway answer[[1]](https://docs.x.ai/)');
  assert.deepEqual(result.sources.map((s) => s.url), ['https://docs.x.ai/']);
  // Wire shape is Grok's, but provider identity stays with the gateway.
  assert.equal(result.providerKind, 'openai');

  assert.deepEqual(bodies[1].input, [{
    role: 'user',
    content: [{ type: 'input_text', text: 'Search xAI docs' }],
  }]);
  assert.deepEqual(bodies[1].include, ['web_search_call.action.sources', 'web_search_call.results']);
  // Control: the same stream through the OpenAI parser gets an index marker,
  // so the Grok assertion above actually distinguishes the two citation paths.
  assert.equal(openaiResult.text, 'Gateway answer[[1]](https://docs.x.ai/)[1]');
});

test('compat.webSearchDialect overrides the default Grok id detection', async (t) => {
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return makeMinimalOpenAIResponse();
  });

  const GROK = { input: [{ role: 'user', content: 'q' }], include: ['web_search_call.action.sources'] };
  const OPENAI = { input: [{ role: 'user', content: [{ type: 'input_text', text: 'q' }] }], include: ['web_search_call.action.sources', 'web_search_call.results'] };
  const base = { api: 'openai-responses', baseUrl: 'https://gateway.example.com/v1', reasoning: false, headers: {} };
  for (const [label, model, expected] of [
    ['gateway grok-4.6 opted out', { ...base, provider: 'custom-gateway', id: 'grok-4.6', compat: { webSearchDialect: 'openai' } }, OPENAI],
    ['native xai opted out', { ...base, provider: 'xai', id: 'grok-4.6', compat: { webSearchDialect: 'openai' } }, OPENAI],
    ['non-Grok id opted in', { ...base, provider: 'custom-gateway', id: 'gpt-6-astra', compat: { webSearchDialect: 'grok' } }, GROK],
    ['prefixed id opted in', { ...base, provider: 'custom-gateway', id: 'x-ai/grok-4', compat: { webSearchDialect: 'grok' } }, GROK],
    ['prefixed id is not matched by default', { ...base, provider: 'custom-gateway', id: 'x-ai/grok-4' }, OPENAI],
    ['grok substring is not matched by default', { ...base, provider: 'custom-gateway', id: 'grokking-model' }, OPENAI],
    ['unknown override value is ignored', { ...base, provider: 'custom-gateway', id: 'grok-4.6', compat: { webSearchDialect: 'bogus' } }, GROK],
  ]) {
    await callApiStream(mockCtx('test-key'), model, { contents: [{ parts: [{ text: 'q' }] }] });
    assert.deepEqual({ input: body.input, include: body.include }, expected, label);
  }
});

test('OpenCode Go Grok gets the Grok schema and keeps session headers', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    return makeMinimalOpenAIResponse();
  });

  const ctx = mockCtx('opencode-go-key', undefined, undefined, undefined, { sessionId: 'session-abc' });
  await callApiStream(ctx, {
    id: 'grok-4.6',
    provider: 'opencode-go',
    api: 'openai-responses',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    reasoning: false,
    headers: {},
  }, { contents: [{ parts: [{ text: 'q' }] }] });

  assert.deepEqual(request.body.include, ['web_search_call.action.sources']);
  assert.deepEqual(request.body.input, [{ role: 'user', content: 'q' }]);
  assert.equal(request.headers['x-opencode-session'], 'session-abc');
  assert.equal(request.headers['x-opencode-client'], 'pi');
});

test('web_search exposes all additional results without provider metadata', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => makeResponse([
    { data: { type: 'response.output_text.delta', delta: 'Search answer[[1]](https://primary.example/)' } },
    { data: { type: 'response.output_text.annotation.added', annotation: {
      type: 'url_citation',
      start_index: 0,
      end_index: 13,
      title: '1',
      url: 'https://primary.example/',
    } } },
    { data: { type: 'response.output_item.done', item: {
      type: 'web_search_call',
      id: 'ws_additional',
      status: 'completed',
      action: { type: 'search', query: 'additional results', sources: [
        { type: 'url', title: 'Primary', url: 'https://primary.example/' },
        { type: 'url', title: 'Secondary', url: 'https://secondary.example/' },
        { type: 'page', title: 'Secondary', url: 'https://secondary.example/' },
        { type: 'url', title: 'Tertiary', url: 'https://tertiary.example/' },
      ] },
    } } },
    { data: { type: 'response.completed', response: { output: [
      { type: 'web_search_call', id: 'ws_additional', status: 'completed', action: { type: 'search', sources: [
        { type: 'url', title: 'Primary', url: 'https://primary.example/' },
        { type: 'url', title: 'Secondary', url: 'https://secondary.example/' },
        { type: 'url', title: 'Tertiary', url: 'https://tertiary.example/' },
      ] } },
      { type: 'message', content: [{ type: 'output_text', text: 'Search answer[[1]](https://primary.example/)', annotations: [{ type: 'url_citation', title: '1', url: 'https://primary.example/' }] }] },
    ] } } },
  ]));

  const result = await webSearch(
    'web-search-test',
    { query: 'additional results' },
    new AbortController().signal,
    undefined,
    mockCtx('xai-test-key', {
      id: 'grok-4.6',
      provider: 'xai',
      api: 'openai-responses',
      baseUrl: 'https://api.x.ai/v1',
      reasoning: true,
      headers: {},
    }),
  );
  const text = result.content[0].text;

  assert.match(text, /## Additional Search Results/);
  assert.equal((text.match(/Secondary - https:\/\/secondary\.example\//g) || []).length, 1);
  assert.match(text, /Tertiary - https:\/\/tertiary\.example\//);
  assert.doesNotMatch(text, /xai\.web_search_call\.action\.sources/);
  assert.doesNotMatch(text, /more results in tool details/);
});

test('xAI stream falls back to env API key when resolved auth has no credential', async (t) => {
  const previousXaiApiKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'env-xai-key';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer env-xai-key');
    return makeResponse([
      { data: { type: 'response.output_text.delta', delta: 'xAI fallback auth accepted' } },
      { data: { type: 'response.done', response: { output: [] } } },
    ]);
  });

  try {
    const result = await callApiStream(mockCtx(undefined), {
      id: 'grok-4.6',
      provider: 'xai',
      api: 'openai-responses',
      baseUrl: 'https://api.x.ai/v1',
      reasoning: true,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with xAI fallback auth' }] }] });

    assert.equal(result.text, 'xAI fallback auth accepted');
  } finally {
    if (previousXaiApiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousXaiApiKey;
  }
});

test('OpenAI stream falls back to env API key when resolved auth has no credential', async (t) => {
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'env-openai-key';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer env-openai-key');
    return makeResponse([
      { data: { type: 'response.output_text.delta', delta: 'Fallback auth accepted' } },
      { data: { type: 'response.done', response: { output: [] } } },
    ]);
  });

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
    if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
  }
});

test('OpenAI stream preserves partial results from incomplete responses', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => makeResponse([
    { data: { type: 'response.web_search_call.in_progress', item_id: 'ws_partial' } },
    { data: { type: 'response.output_text.delta', delta: 'Partial OpenAI answer' } },
    { data: { type: 'response.incomplete', response: {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        { type: 'web_search_call', id: 'ws_partial', status: 'completed', action: { type: 'search', query: 'partial query' } },
      ],
    } } },
  ]));

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
});

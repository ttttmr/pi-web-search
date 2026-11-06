import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import registerExtension from '../src/index.ts';
import { callApiStream } from '../src/api.ts';
import { webSearch } from '../src/web_search.ts';
import { createMockCtx as mockCtx, withWebSearchConfig } from './helpers.mjs';

const model = {
  id: 'gpt-6-astra', provider: 'openai', api: 'openai-responses',
  baseUrl: 'https://example.com/v1', reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh' },
};
const ctx = mockCtx('test-key', model);
const prompt = { contents: [{ parts: [{ text: 'Search documentation' }] }] };
function response() {
  return new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

for (const api of ['openai-responses', 'azure-openai-responses', 'openai-codex-responses']) {
  test(`${api} inherits enabled effort and preserves safe defaults`, async (t) => {
    let body;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      body = JSON.parse(init.body);
      return response();
    });
    const selected = { ...model, api, headers: { 'chatgpt-account-id': 'test-account' } };
    for (const [level, expected] of [
      ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'],
      ['minimal', 'low'], ['off', undefined], [undefined, undefined],
    ]) {
      await callApiStream(ctx, selected, prompt, undefined, undefined, level);
      assert.deepEqual(body.reasoning, expected ? { effort: expected } : undefined);
      assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    }
    await callApiStream(ctx, { ...selected, reasoning: false }, prompt, undefined, undefined, 'high');
    assert.equal(Object.hasOwn(body, 'reasoning'), false);
    await callApiStream(ctx, {
      ...selected, thinkingLevelMap: { minimal: 'low', high: 'medium' },
    }, prompt, undefined, undefined, 'high');
    assert.deepEqual(body.reasoning, { effort: 'medium' });
  });
}

test('xAI does not receive OpenAI effort settings', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(Object.hasOwn(JSON.parse(init.body), 'reasoning'), false);
    return response();
  });
  await callApiStream(ctx, { ...model, provider: 'xai' }, prompt, undefined, undefined, 'medium');
});

test('gateway-hosted Grok keeps effort settings', async (t) => {
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return response();
  });
  await callApiStream(ctx, { ...model, provider: 'custom-gateway', id: 'grok-4.7' }, prompt, undefined, undefined, 'medium');
  assert.deepEqual(body.reasoning, { effort: 'medium' });
  assert.deepEqual(body.include, ['web_search_call.action.sources']);

  // Dialect override changes wire shape only; a non-xai provider still sends effort.
  await callApiStream(ctx, { ...model, provider: 'custom-gateway', compat: { webSearchDialect: 'grok' } }, prompt, undefined, undefined, 'medium');
  assert.deepEqual(body.reasoning, { effort: 'medium' });
  assert.deepEqual(body.include, ['web_search_call.action.sources']);
});

test('native xAI Grok omits effort regardless of dialect override', async (t) => {
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return response();
  });
  const xaiGrok = { ...model, provider: 'xai', id: 'grok-4.6' };
  await callApiStream(ctx, xaiGrok, prompt, undefined, undefined, 'medium');
  assert.equal(Object.hasOwn(body, 'reasoning'), false);
  await callApiStream(ctx, { ...xaiGrok, compat: { webSearchDialect: 'openai' } }, prompt, undefined, undefined, 'medium');
  assert.equal(Object.hasOwn(body, 'reasoning'), false);
});

test('registered tool reads the current agent thinking level on every invocation', async (t) => {
  let level = 'medium';
  let tool;
  const efforts = [];
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signals.push(init.signal);
    efforts.push(JSON.parse(init.body).reasoning?.effort);
    return response();
  });

  // No config file: web_search follows the current conversation model.
  await withWebSearchConfig(null, async (configPath) => {
    registerExtension({
      registerTool(value) { if (value.name === 'web_search') tool = value; },
      getThinkingLevel() { return level; },
      getActiveTools() { return []; }, setActiveTools() {}, on() {},
    });
    for (const next of ['medium', 'high', 'off']) {
      level = next;
      const signal = new AbortController().signal;
      const result = await tool.execute('test', { query: 'Search documentation' },
        signal, undefined, ctx);
      assert.equal(result.details.error, undefined);
      assert.equal(signals.at(-1), signal);
    }
    assert.deepEqual(efforts, ['medium', 'high', undefined]);

    // A dedicated model must use its own capabilities, not the caller's map.
    await writeFile(configPath,
      JSON.stringify({ provider: 'github-copilot', model: 'dedicated-search' }));
    const dedicated = {
      ...model, provider: 'github-copilot', id: 'dedicated-search',
      thinkingLevelMap: { high: 'medium' },
    };
    const dedicatedCtx = mockCtx('test-key', model, undefined, undefined, {
      find(provider, id) {
        assert.equal(provider, dedicated.provider);
        assert.equal(id, dedicated.id);
        return dedicated;
      },
    });
    level = 'high';
    const result = await tool.execute('dedicated', { query: 'Search documentation' },
      undefined, undefined, dedicatedCtx);
    assert.equal(result.details.error, undefined);
    assert.equal(result.details.model, 'dedicated-search');
    assert.equal(efforts.at(-1), 'medium');
    assert.ok(signals.at(-1) instanceof AbortSignal);
    assert.equal(signals.at(-1).aborted, false);
  });
});

test('configured search thinking overrides the session and uses the search model capabilities', async (t) => {
  let tool;
  const efforts = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    efforts.push(JSON.parse(init.body).reasoning?.effort);
    return response();
  });
  registerExtension({
    registerTool(value) { if (value.name === 'web_search') tool = value; },
    getThinkingLevel() { return 'high'; },
    getActiveTools() { return []; }, setActiveTools() {}, on() {},
  });
  const dedicated = {
    ...model, id: 'dedicated-search',
    thinkingLevelMap: { off: null, minimal: null, high: 'medium', xhigh: null, max: 'provider-max' },
  };
  const searchCtx = mockCtx('test-key', model, undefined, undefined, { models: [dedicated] });
  await withWebSearchConfig(null, async (configPath) => {
    for (const [thinking, expected] of [
      [undefined, 'medium'], ['low', 'low'], ['minimal', 'low'], ['medium', 'medium'],
      ['high', 'medium'], ['xhigh', 'provider-max'], ['max', 'provider-max'], ['off', undefined],
    ]) {
      await writeFile(configPath, JSON.stringify({ provider: dedicated.provider, model: dedicated.id, thinking }));
      const result = await tool.execute('test', { query: 'Search documentation' }, undefined, undefined, searchCtx);
      assert.equal(result.details.error, undefined, result.content[0].text);
      assert.equal(result.details.model, dedicated.id);
      assert.equal(efforts.at(-1), expected, `thinking=${thinking}`);
    }
    assert.equal(efforts.length, 8);
  });
});

test('configured search thinking clamps max to a supported level and preserves non-reasoning defaults', async (t) => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return response();
  });
  const selected = { ...model, thinkingLevelMap: { xhigh: null, max: null } };
  await withWebSearchConfig({ provider: model.provider, model: model.id, thinking: 'max' }, async () => {
    for (const reasoning of [true, false]) {
      const result = await webSearch('test', { query: 'query' }, new AbortController().signal,
        undefined, mockCtx('test-key', { ...selected, reasoning }), 'low');
      assert.equal(result.details.error, undefined, result.content[0].text);
    }
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].reasoning, { effort: 'high' });
  assert.equal(Object.hasOwn(bodies[1], 'reasoning'), false);
});

test('invalid search thinking returns a config error before making a request', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('invalid config must not send a request'));
  for (const thinking of ['fast', '', 'LOW', 'toString', '__proto__', null, 1, true, [], {}]) {
    await withWebSearchConfig({ provider: model.provider, model: model.id, thinking }, async () => {
      const result = await webSearch('test', { query: 'query' }, new AbortController().signal, undefined, ctx, 'high');
      assert.equal(result.details.error, 'invalid_config', `thinking=${JSON.stringify(thinking)}`);
      assert.match(result.content[0].text, /Invalid thinking level/);
    });
  }
});

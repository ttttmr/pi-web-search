import test from 'node:test';
import assert from 'node:assert/strict';
import { webSearch } from '../src/web_search.ts';
import { getWebSearchModel } from '../src/utils.ts';
import { createMockCtx as mockCtx, withWebSearchConfig } from './helpers.mjs';

const model = { id: 'auto', provider: 'google-generative-ai', api: 'pi-virtual' };
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function virtualCtx(run) {
  const ctx = mockCtx(undefined, model, undefined, undefined, { sessionId: 'test-session' });
  ctx.modelRegistry.streamSimple = (selected, context, options) => {
    assert.equal(selected, model);
    return { result: async () => run(context, options) };
  };
  return ctx;
}

for (const api of ['openai-responses', 'azure-openai-responses', 'openai-codex-responses', 'anthropic-messages', 'google-generative-ai']) {
  test(`virtual search configures ${api} after Pi resolves the model`, async () => {
    const signal = new AbortController().signal;
    const updates = [];
    const ctx = virtualCtx(async (context, options) => {
      assert.equal(options.signal, signal);
      assert.equal(options.reasoning, 'high');
      assert.equal(options.sessionId, 'test-session');
      assert.equal(options.transport, 'sse');
      assert.match(context.messages[0].content, /https:\/\/example.test\/source/);
      const target = { id: 'search-model', provider: 'test-provider', api };
      const payload = await options.onPayload({ config: {} }, target);
      if (api === 'google-generative-ai') {
        assert.deepEqual(payload.config.tools, [{ googleSearch: {} }, { urlContext: {} }]);
        await options.onProviderStreamEvent({ candidates: [{ content: { parts: [
          { thought: true, text: 'Reasoning summary' }, { text: 'Search answer' },
        ] } }] }, target);
      } else if (api === 'anthropic-messages') {
        assert.equal(payload.tools[0].type, 'web_search_20260209');
        await options.onProviderStreamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Search answer' } }, target);
      } else {
        assert.deepEqual(payload.tools, [{ type: 'web_search' }]);
        if (api === 'openai-codex-responses') assert.equal(payload.tool_choice, 'required');
        await options.onProviderStreamEvent({ type: 'response.output_text.delta', delta: 'Search answer' }, target);
      }
      return { stopReason: 'stop', usage };
    });
    const result = await webSearch('test', {
      query: 'Search documentation', urls: ['https://example.test/source'],
    }, signal, (update) => updates.push(update), ctx, 'high');
    assert.equal(result.details.error, undefined, result.content[0].text);
    assert.match(result.content[0].text, /Search answer/);
    assert.doesNotMatch(JSON.stringify([result.content, updates]), /Reasoning summary/);
    assert.deepEqual(result.usage, usage);
    assert.equal(ctx.model, model);

    await withWebSearchConfig({ provider: model.provider, model: model.id }, async () => {
      assert.equal(await getWebSearchModel({ ...ctx, model: undefined }), model);
    });
  });
}

test('virtual search discards results from a previous provider attempt', async () => {
  const ctx = virtualCtx(async (_context, options) => {
    const target = { id: 'search-model', provider: 'test-provider', api: 'openai-codex-responses' };
    for (const text of ['Discarded answer', 'Successful answer']) {
      await options.onPayload({}, target);
      await options.onProviderStreamEvent({ type: 'response.output_text.delta', delta: text }, target);
      await options.onProviderStreamEvent({ type: 'response.output_item.done', item: {
        type: 'web_search_call', id: text, status: 'completed', action: { type: 'search', query: text },
      } }, target);
    }
    return { stopReason: 'stop' };
  });
  const result = await webSearch('test', { query: 'query' }, new AbortController().signal, undefined, ctx);
  assert.match(result.content[0].text, /Successful answer/);
  assert.doesNotMatch(result.content[0].text, /Discarded answer/);
  assert.deepEqual(result.details.searchQueries, ['Successful answer']);
});

test('virtual search reports unsupported targets and provider failures', async () => {
  const ctx = virtualCtx(async (_context, options) => {
    await options.onPayload({}, { id: 'unsupported', provider: 'test-provider', api: 'openai-completions' });
    assert.fail('unsupported request was accepted');
  });
  const result = await webSearch('test', { query: 'query' }, new AbortController().signal, undefined, ctx);
  assert.equal(result.details.error, true);
  assert.match(result.content[0].text, /routed to an unsupported search model.*openai-completions/);

  for (const stopReason of ['error', 'aborted']) {
    const failed = virtualCtx(async () => ({ stopReason, errorMessage: 'Request stopped' }));
    const result = await webSearch('test', { query: 'query' }, new AbortController().signal, undefined, failed);
    assert.equal(result.details.error, true);
    assert.match(result.content[0].text, /Request stopped/);
  }
});

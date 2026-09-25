import test from 'node:test';
import assert from 'node:assert/strict';
import { callApiStream, getProviderKind } from '../src/api.ts';
import { createMockCtx as mockCtx } from './helpers.mjs';

const MODEL = {
  id: 'devin/grok-4-7',
  provider: 'opencodex',
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:10100/v1',
  headers: {},
  compat: { sendSessionAffinityHeaders: true },
};

test('OpenCodex sends the current model to alpha/search and normalizes results', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    return Response.json({
      encrypted_output: null,
      output: 'Current answer from native search.',
      results: [
        { title: 'Current docs', url: 'https://example.test/docs' },
        { title: 'Unsafe', url: 'javascript:alert(1)' },
      ],
    });
  });

  const result = await callApiStream(
    mockCtx('local-proxy-key', undefined, undefined, undefined, { sessionId: 'pi-session-1' }),
    MODEL,
    { contents: [{ parts: [{ text: 'latest docs' }] }] },
  );

  assert.equal(getProviderKind(MODEL), 'opencodex');
  assert.equal(request.url, 'http://127.0.0.1:10100/v1/alpha/search');
  assert.equal(request.headers['x-opencodex-api-key'], 'local-proxy-key');
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers.session_id, 'pi-session-1');
  assert.equal(request.headers['x-client-request-id'], 'pi-session-1');
  assert.equal(request.headers['x-session-affinity'], 'pi-session-1');
  assert.equal(request.body.model, 'devin/grok-4-7');
  assert.deepEqual(request.body.commands, { search_query: [{ q: 'latest docs' }] });
  assert.equal(result.text, 'Current answer from native search.');
  assert.equal(result.providerKind, 'opencodex');
  assert.equal(result.nativeSearchUsed, true);
  assert.deepEqual(result.searchQueries, ['latest docs']);
  assert.deepEqual(result.sources, [{ title: 'Current docs', url: 'https://example.test/docs' }]);
});

test('OpenCodex does not send its public loopback placeholder as admission auth', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers['x-opencodex-api-key'], undefined);
    assert.equal(init.headers.authorization, undefined);
    return Response.json({ output: 'loopback', results: [] });
  });

  await callApiStream(
    mockCtx('opencodex-loopback'),
    MODEL,
    { contents: [{ parts: [{ text: 'loopback search' }] }] },
  );
});

test('OpenCodex preserves caller headers when no API key is resolved', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer caller-chatgpt-token');
    assert.equal(init.headers['chatgpt-account-id'], 'account-1');
    return Response.json({ output: 'forwarded', results: [] });
  });

  await callApiStream(
    mockCtx(undefined, undefined, {
      Authorization: 'Bearer caller-chatgpt-token',
      'chatgpt-account-id': 'account-1',
    }),
    MODEL,
    { contents: [{ parts: [{ text: 'forward search' }] }] },
  );
});

test('OpenCodex preserves explicit admission and upstream auth headers together', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers['x-opencodex-api-key'], 'explicit-admission-key');
    assert.equal(init.headers.authorization, 'Bearer caller-chatgpt-token');
    return Response.json({ output: 'forwarded', results: [] });
  });

  await callApiStream(
    mockCtx('resolved-key-is-unused', undefined, {
      'x-opencodex-api-key': 'explicit-admission-key',
      Authorization: 'Bearer caller-chatgpt-token',
    }),
    MODEL,
    { contents: [{ parts: [{ text: 'forward search' }] }] },
  );
});

test('OpenCodex rejects oversized responses before reading their body', async (t) => {
  let canceled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { canceled = true; },
  }), { headers: { 'content-length': String(16 * 1024 * 1024 + 1) } }));

  await assert.rejects(
    callApiStream(
      mockCtx('local-proxy-key'),
      MODEL,
      { contents: [{ parts: [{ text: 'latest docs' }] }] },
    ),
    /response exceeded 16 MiB/,
  );
  assert.equal(canceled, true);
});

test('OpenCodex cancels a streamed response once it crosses the byte bound', async (t) => {
  let canceled = false;
  const chunk = new Uint8Array(8 * 1024 * 1024 + 1);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); },
    cancel() { canceled = true; },
  })));

  await assert.rejects(
    callApiStream(
      mockCtx('local-proxy-key'),
      MODEL,
      { contents: [{ parts: [{ text: 'latest docs' }] }] },
    ),
    /response exceeded 16 MiB/,
  );
  assert.equal(canceled, true);
});

test('OpenCodex surfaces bounded endpoint errors without changing models', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: { message: 'Devin login required' },
  }, { status: 502 }));

  await assert.rejects(
    callApiStream(
      mockCtx('local-proxy-key'),
      MODEL,
      { contents: [{ parts: [{ text: 'latest docs' }] }] },
    ),
    /OpenCodex search error \(502\): Devin login required/,
  );
});

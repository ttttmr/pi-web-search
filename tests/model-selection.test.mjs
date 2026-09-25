import test from 'node:test';
import assert from 'node:assert/strict';
import { getModel, getWebSearchModel, missingConfigResult, missingWebSearchConfigResult } from '../src/utils.ts';
import { createMockCtx as mockCtx, withAgentDir, withWebSearchConfig } from './helpers.mjs';

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

test('getModel accepts OpenCodex regardless of its pi wire API', async () => {
  const model = {
    id: 'devin/claude-sonnet-5',
    provider: 'opencodex',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:10100/v1',
    headers: {},
  };
  const ctx = {
    model,
    modelRegistry: { getAvailable: () => [model] },
  };

  assert.equal(await getModel(ctx), model);
});

test('getModel accepts xAI Responses models and rejects xAI Completions models', async () => {
  const model = {
    id: 'grok-4.6',
    provider: 'xai',
    api: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
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
  assert.equal(await getModel({
    ...ctx,
    model: { ...model, api: 'openai-completions' },
  }), undefined);
});

test('getWebSearchModel prefers explicit config over current conversation model', async () => {
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
  const ctx = mockCtx('test-key', currentModel, undefined, undefined, { models: [currentModel, configuredModel] });

  await withWebSearchConfig({ provider: 'proxy-provider', model: 'gpt-test' }, async () => {
    assert.equal(await getWebSearchModel(ctx), configuredModel);
  });
});

test('getWebSearchModel respects PI_CODING_AGENT_DIR for the default config path', async () => {
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
  const ctx = mockCtx('test-key', currentModel, undefined, undefined, { models: [currentModel, configuredModel] });

  await withAgentDir({ 'web-search.json': { provider: 'proxy-provider', model: 'gpt-test' } }, async () => {
    assert.equal(await getWebSearchModel(ctx), configuredModel);
  });
});

test('getWebSearchModel reports unsupported configured model instead of falling back', async () => {
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
  const ctx = mockCtx('test-key', currentModel, undefined, undefined, { models: [currentModel, unsupportedConfiguredModel] });

  await withWebSearchConfig({ provider: 'local-provider', model: 'local-test' }, async (configPath) => {
    assert.equal(await getWebSearchModel(ctx), undefined);
    const result = missingWebSearchConfigResult(ctx);
    assert.match(result.content[0].text, /Configured web search model local-test/i);
    assert.match(result.content[0].text, /does not support native web search/i);
    assert.equal(result.details.error, 'unsupported_model');
    assert.equal(result.details.configPath, configPath);
  });
});

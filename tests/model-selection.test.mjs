import test from 'node:test';
import assert from 'node:assert/strict';
import { getModel, getWebSearchModel, resolveWebSearchModel, missingConfigResult, missingWebSearchConfigResult } from '../src/utils.ts';
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
  assert.match(result.content[0].text, /no native web search/);
  assert.match(result.content[0].text, /openai-chat-completions/);
  assert.match(result.content[0].text, /web-search\.json/);
  assert.equal(result.details.error, 'unsupported_model');
  assert.equal(result.details.api, 'openai-chat-completions');
  assert.equal(result.details.currentModel, 'local-test (local-provider/openai-chat-completions)');
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
    assert.match(result.content[0].text, /no native web search/i);
    assert.match(result.content[0].text, /openai-chat-completions/);
    assert.equal(result.details.error, 'unsupported_model');
    assert.equal(result.details.configPath, configPath);
    assert.equal(result.details.api, 'openai-chat-completions');
  });
});

test('getWebSearchModel with preferCurrentModel keeps a supported conversation model', async () => {
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

  await withWebSearchConfig({ provider: 'proxy-provider', model: 'gpt-test', preferCurrentModel: true }, async () => {
    assert.equal(await getWebSearchModel(ctx), currentModel);
  });
});

test('getWebSearchModel with preferCurrentModel uses the configured model for chat-only models', async () => {
  const currentModel = {
    id: 'local-test',
    provider: 'local-provider',
    api: 'openai-chat-completions',
    baseUrl: 'https://example.test/local',
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

  await withWebSearchConfig({ provider: 'proxy-provider', model: 'gpt-test', preferCurrentModel: true }, async () => {
    assert.equal(await getWebSearchModel(ctx), configuredModel);
  });
});

test('getWebSearchModel keeps pinning every search when preferCurrentModel is false or omitted', async () => {
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

  await withWebSearchConfig({ provider: 'proxy-provider', model: 'gpt-test', preferCurrentModel: false }, async () => {
    assert.equal(await getWebSearchModel(ctx), configuredModel);
  });
  await withWebSearchConfig({ provider: 'proxy-provider', model: 'gpt-test' }, async () => {
    assert.equal(await getWebSearchModel(ctx), configuredModel);
  });
});

test('getWebSearchModel rejects a non-boolean preferCurrentModel', async () => {
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

  await withWebSearchConfig({ provider: 'proxy-provider', model: 'gpt-test', preferCurrentModel: 'yes' }, async (configPath) => {
    assert.equal(await getWebSearchModel(ctx), undefined);
    const result = missingWebSearchConfigResult(ctx);
    assert.match(result.content[0].text, /Invalid preferCurrentModel/);
    assert.equal(result.details.error, 'invalid_config');
    assert.equal(result.details.configPath, configPath);
  });
});

test('resolveWebSearchModel with preferCurrentModel keeps a supported conversation model', async () => {
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

  await withWebSearchConfig({ provider: 'proxy-provider', model: 'gpt-test', preferCurrentModel: true }, async () => {
    const resolved = await resolveWebSearchModel(ctx);
    assert.equal(resolved.status, 'ok');
    assert.equal(resolved.model, currentModel);
  });
});

test('resolveWebSearchModel with preferCurrentModel uses the configured model for chat-only models', async () => {
  const currentModel = {
    id: 'local-test',
    provider: 'local-provider',
    api: 'openai-chat-completions',
    baseUrl: 'https://example.test/local',
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

  await withWebSearchConfig({ provider: 'proxy-provider', model: 'gpt-test', preferCurrentModel: true, thinking: 'low' }, async () => {
    const resolved = await resolveWebSearchModel(ctx);
    assert.equal(resolved.status, 'ok');
    assert.equal(resolved.model, configuredModel);
    assert.equal(resolved.thinkingLevel, 'low');
  });
});

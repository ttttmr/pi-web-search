import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { getSearchDialect } from '../src/providers/config.ts';

// Canary for the models.json integration: compat.webSearchDialect is defined by this
// extension, not pi, so it must survive pi's loader. The ids are chosen so that a lost
// setting flips the result: search-alias only reads as Grok via provider-level compat,
// and grok-4.6 only reads as OpenAI via its model-level override.
test('compat.webSearchDialect survives the models.json loader with model-level precedence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-search-models-'));
  try {
    const modelsJsonPath = join(dir, 'models.json');
    await writeFile(modelsJsonPath, JSON.stringify({
      providers: {
        'dialect-gateway': {
          baseUrl: 'https://gateway.example.com/v1',
          api: 'openai-responses',
          compat: { webSearchDialect: 'grok' },
          models: [
            { id: 'search-alias' },
            { id: 'grok-4.6', compat: { webSearchDialect: 'openai' } },
          ],
        },
      },
    }));

    const registry = new ModelRegistry(await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: modelsJsonPath, allowModelNetwork: false,
    }));
    assert.equal(registry.getError(), undefined);

    const inherited = registry.find('dialect-gateway', 'search-alias');
    const overridden = registry.find('dialect-gateway', 'grok-4.6');
    assert.ok(inherited, 'search-alias should load from models.json');
    assert.ok(overridden, 'grok-4.6 should load from models.json');

    assert.equal(getSearchDialect(inherited), 'grok');
    assert.equal(getSearchDialect(overridden), 'openai');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

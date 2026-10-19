import { describe, expect, it } from 'vitest';
import { interpolate, loadConfig, parseConfig } from '../src/config.js';
import { buildRegistry } from '../src/registry.js';

describe('config', () => {
  it('fills ${VAR} and ${VAR:-default} from the environment', () => {
    const raw = { url: '${HOST:-http://localhost:11434}', key: '${KEY}', list: ['${KEY}-x'], n: 3 };

    expect(interpolate(raw, { KEY: 'abc' })).toEqual({
      url: 'http://localhost:11434',
      key: 'abc',
      list: ['abc-x'],
      n: 3,
    });
    expect(interpolate(raw, { HOST: 'http://ollama:11434' })).toMatchObject({ url: 'http://ollama:11434', key: '' });
  });

  it('rejects aliases that point at an undefined provider', () => {
    expect(() =>
      parseConfig({
        providers: { ollama: { type: 'ollama' } },
        aliases: { fast: ['groq/llama-3.3-70b'] },
      }),
    ).toThrow(/unknown provider "groq"/);
  });

  it('loads the shipped gateway.yaml', async () => {
    const config = await loadConfig('gateway.yaml', {});

    expect(Object.keys(config.aliases)).toEqual(['fast', 'smart', 'cheap', 'local']);
    expect(config.providers.ollama).toMatchObject({ baseUrl: 'http://localhost:11434', think: false });
    expect(config.retry).toEqual({ maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4000 });
  });
});

describe('registry', () => {
  const config = parseConfig({
    providers: {
      ollama: { type: 'ollama', baseUrl: 'http://localhost:11434/' },
      openai: { type: 'openai', apiKey: 'sk-1' },
      gemini: { type: 'gemini', apiKey: '' },
    },
    aliases: {
      fast: ['gemini/gemini-3.8-flash', 'openai/gpt-5.4-mini', 'ollama/qwen3.5-9b:iq4xs'],
      cloud: ['gemini/gemini-3.8-flash'],
    },
  });
  const registry = buildRegistry(config);

  it('skips providers without an API key', () => {
    expect(registry.disabledProviders()).toEqual(['gemini']);
    expect(registry.resolve('fast')?.map((t) => t.ref)).toEqual(['openai/gpt-5.4-mini', 'ollama/qwen3.5-9b:iq4xs']);
    expect(registry.resolve('cloud')).toEqual([]);
  });

  it('accepts a direct provider/model ref and splits on the first slash only', () => {
    const [target] = registry.resolve('ollama/hf.co/unsloth/Qwen3-8B-GGUF') ?? [];

    expect(target?.provider.name).toBe('ollama');
    expect(target?.model).toBe('hf.co/unsloth/Qwen3-8B-GGUF');
  });

  it('returns undefined for unknown models', () => {
    expect(registry.resolve('gpt-4')).toBeUndefined();
    expect(registry.resolve('mistral/large')).toBeUndefined();
  });
});

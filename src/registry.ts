import { isModelRef, splitRef, type GatewayConfig, type ProviderConfig } from './config.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GeminiProvider } from './providers/gemini.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAIProvider } from './providers/openai.js';
import type { Provider } from './providers/types.js';

export interface Target {
  /** "provider/model", the same string used in the config file. */
  ref: string;
  provider: Provider;
  model: string;
  timeoutMs: number;
}

export interface Registry {
  /** Fallback chain for an alias or a direct "provider/model" ref. Undefined if unknown. */
  resolve(model: string): Target[] | undefined;
  aliases(): { alias: string; targets: string[] }[];
  enabledProviders(): string[];
  disabledProviders(): string[];
}

function createProvider(name: string, config: ProviderConfig): Provider | undefined {
  switch (config.type) {
    case 'ollama':
      return new OllamaProvider(name, { baseUrl: config.baseUrl, think: config.think });
    case 'openai':
      return config.apiKey ? new OpenAIProvider(name, config) : undefined;
    case 'anthropic':
      return config.apiKey ? new AnthropicProvider(name, config) : undefined;
    case 'gemini':
      return config.apiKey ? new GeminiProvider(name, config) : undefined;
  }
}

export function buildRegistry(config: GatewayConfig): Registry {
  const providers = new Map<string, { provider: Provider; timeoutMs: number }>();
  const disabled: string[] = [];
  for (const [name, providerConfig] of Object.entries(config.providers)) {
    const provider = createProvider(name, providerConfig);
    if (provider) providers.set(name, { provider, timeoutMs: providerConfig.timeoutMs });
    else disabled.push(name);
  }

  // Providers without an API key are skipped, so a chain like
  // gemini -> openai -> ollama still works on a machine with no keys at all.
  const toTargets = (refs: string[]): Target[] =>
    refs.flatMap((ref) => {
      const { provider, model } = splitRef(ref);
      const entry = providers.get(provider);
      return entry ? [{ ref, provider: entry.provider, model, timeoutMs: entry.timeoutMs }] : [];
    });

  return {
    resolve(model) {
      const refs = config.aliases[model];
      if (refs) return toTargets(refs);
      if (isModelRef(model) && providers.has(splitRef(model).provider)) return toTargets([model]);
      return undefined;
    },
    aliases() {
      return Object.entries(config.aliases).map(([alias, refs]) => ({
        alias,
        targets: toTargets(refs).map((target) => target.ref),
      }));
    },
    enabledProviders: () => [...providers.keys()],
    disabledProviders: () => disabled,
  };
}

import type { GatewayConfig } from './config.js';
import type { Usage } from './openai.js';

/** Estimated cost in USD, or null when the model has no price in the config. */
export function estimateCost(pricing: GatewayConfig['pricing'], ref: string, usage: Usage): number | null {
  const price = pricing[ref];
  if (!price) return null;
  const cost = (usage.prompt_tokens * price.input + usage.completion_tokens * price.output) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

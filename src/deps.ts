import type { Logger } from 'pino';
import type { ResponseCache } from './cache.js';
import type { DemoConfig, GatewayConfig } from './config.js';
import type { ChatCompletion } from './openai.js';
import type { RateLimiter } from './rate-limit.js';
import type { Registry } from './registry.js';
import type { ApiKeyRecord, Store } from './store.js';

export interface CachedCompletion {
  ref: string;
  completion: ChatCompletion;
}

export interface AppDeps {
  registry: Registry;
  store: Store;
  limiter: RateLimiter;
  /** Undefined when caching is turned off in the config. */
  cache: ResponseCache<CachedCompletion> | undefined;
  retry: GatewayConfig['retry'];
  pricing: GatewayConfig['pricing'];
  adminToken: string;
  log: Logger;
  /** Set when the config has a demo block. Turns the gateway into the public demo. */
  demo?: DemoConfig;
  /** Hosts that freeze after the response (Vercel) use this to finish writes that outlast it. */
  background?: (work: Promise<unknown>) => void;
}

export interface GatewayEnv {
  Variables: { apiKey: ApiKeyRecord };
}

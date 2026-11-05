import { pino } from 'pino';
import { createApp } from './app.js';
import { ResponseCache } from './cache.js';
import { loadConfig } from './config.js';
import { connect, PgStore } from './db/pg-store.js';
import type { AppDeps, CachedCompletion } from './deps.js';
import { loadEnv } from './env.js';
import { RateLimiter } from './rate-limit.js';
import { buildRegistry } from './registry.js';

/** Everything except the server itself, so the Node entry and the Vercel function share it. */
export async function createGateway(background?: AppDeps['background']) {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL });
  const config = await loadConfig(env.GATEWAY_CONFIG);
  const registry = buildRegistry(config);

  log.info(
    { enabled: registry.enabledProviders(), disabled: registry.disabledProviders() },
    'providers loaded (disabled ones have no API key)',
  );

  const database = connect(env.DATABASE_URL);
  const app = createApp({
    registry,
    store: new PgStore(database.db),
    limiter: new RateLimiter(),
    cache: config.cache.enabled
      ? new ResponseCache<CachedCompletion>(config.cache.ttlSeconds * 1000, config.cache.maxEntries)
      : undefined,
    retry: config.retry,
    pricing: config.pricing,
    adminToken: env.ADMIN_TOKEN,
    log,
    demo: config.demo,
    background,
  });

  return { app, env, log, database };
}

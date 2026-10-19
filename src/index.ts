import { serve } from '@hono/node-server';
import { pino } from 'pino';
import { createApp } from './app.js';
import { ResponseCache } from './cache.js';
import { loadConfig } from './config.js';
import { connect, PgStore } from './db/pg-store.js';
import type { CachedCompletion } from './deps.js';
import { loadEnv } from './env.js';
import { RateLimiter } from './rate-limit.js';
import { buildRegistry } from './registry.js';

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
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info(`listening on http://localhost:${info.port}`);
});

const shutdown = (signal: string) => {
  log.info(`${signal} received, shutting down`);
  server.close(() => {
    void database.close().finally(() => process.exit(0));
  });
  // Open streams can keep the server alive, do not wait for them forever.
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

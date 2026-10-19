import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { apiError } from './api-error.js';
import type { AppDeps, GatewayEnv } from './deps.js';
import { InvalidRequestError } from './errors.js';
import { hashKey } from './keys.js';
import { AllProvidersFailedError } from './router.js';
import { chatCompletions } from './routes/chat.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function createApp(deps: AppDeps) {
  const { registry, store, limiter, log } = deps;
  const app = new Hono<GatewayEnv>();

  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    log.info(
      { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) },
      'request',
    );
  });

  app.get('/health', (c) => c.json({ ok: true }));

  const requireApiKey: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token) return apiError(c, 401, 'missing API key, send Authorization: Bearer <key>', 'authentication_error');
    const key = await store.findActiveKey(hashKey(token));
    if (!key) return apiError(c, 401, 'invalid API key', 'authentication_error', 'invalid_api_key');
    c.set('apiKey', key);
    await next();
  };

  const rateLimit: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const key = c.get('apiKey');
    const result = limiter.take(key.id, key.rateLimitPerMinute);
    c.header('x-ratelimit-limit-requests', String(key.rateLimitPerMinute));
    c.header('x-ratelimit-remaining-requests', String(result.remaining));
    if (!result.allowed) {
      c.header('retry-after', String(Math.ceil(result.retryAfterMs / 1000)));
      return apiError(
        c,
        429,
        `rate limit of ${key.rateLimitPerMinute} requests per minute reached`,
        'rate_limit_error',
        'rate_limit_exceeded',
      );
    }
    await next();
  };

  app.use('/v1/*', requireApiKey);

  app.get('/v1/models', (c) => {
    const data = registry
      .aliases()
      .filter((entry) => entry.targets.length > 0)
      .map((entry) => ({
        id: entry.alias,
        object: 'model',
        created: 0,
        owned_by: 'llm-gateway',
        targets: entry.targets,
      }));
    return c.json({ object: 'list', data });
  });

  app.post('/v1/chat/completions', rateLimit, chatCompletions(deps));

  const requireAdmin: MiddlewareHandler<GatewayEnv> = async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    if (!token || !sameSecret(token, deps.adminToken)) {
      return apiError(c, 401, 'admin token required', 'authentication_error');
    }
    await next();
  };

  app.use('/admin/*', requireAdmin);

  app.get('/admin/usage', async (c) => {
    const sinceParam = c.req.query('since');
    const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - DAY_MS);
    if (Number.isNaN(since.getTime())) {
      return apiError(c, 400, 'since must be an ISO date, e.g. 2026-10-01', 'invalid_request_error');
    }
    return c.json(await store.usageSummary(since));
  });

  app.notFound((c) => apiError(c, 404, `no route for ${c.req.method} ${c.req.path}`, 'invalid_request_error'));

  app.onError((err, c) => {
    if (err instanceof InvalidRequestError) return apiError(c, 400, err.message, 'invalid_request_error');
    if (err instanceof AllProvidersFailedError) return apiError(c, 502, err.publicMessage, 'upstream_error');
    if (c.req.raw.signal.aborted) {
      log.info({ path: c.req.path }, 'client closed the connection');
      return new Response(null, { status: 499 });
    }
    log.error({ err }, 'unhandled error');
    return apiError(c, 500, 'internal error', 'server_error');
  });

  return app;
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function sameSecret(a: string, b: string): boolean {
  // Hash first so both buffers have the same length for timingSafeEqual.
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

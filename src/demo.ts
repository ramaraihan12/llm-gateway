// The public demo. Anyone can reach it and it spends a real provider key, so a
// request has to get through all of this before it goes anywhere near a model.
import { createHmac } from 'node:crypto';
import { isIPv6 } from 'node:net';
import type { Context } from 'hono';
import { apiError } from './api-error.js';
import type { DemoConfig } from './config.js';
import type { AppDeps, GatewayEnv } from './deps.js';
import type { ChatRequest } from './openai.js';
import type { Admission } from './routes/chat.js';
import type { ApiKeyRecord } from './store.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_FULL_BUCKETS = 10_000;

export function demoAdmission(deps: AppDeps, demo: DemoConfig): Admission {
  const { store, limiter, adminToken, background, log } = deps;
  // A full bucket stays full until its window ends, and the window is part of
  // the name. Remembering them keeps a client that ignores its 429s from
  // holding the database awake.
  const fullBuckets = new Set<string>();
  let demoKey: Promise<ApiKeyRecord> | undefined;

  const keyForLogging = () => {
    if (!demoKey) {
      demoKey = store.demoKey();
      demoKey.catch(() => (demoKey = undefined));
      // Once per instance is often enough to keep the table small.
      const sweep = store.sweepQuota(new Date()).catch((err: unknown) => log.warn({ err }, 'quota sweep failed'));
      background?.(sweep);
    }
    return demoKey;
  };

  return async (c, req) => {
    // Everything that needs no database comes first, so junk never reaches it.
    // JSON needs a CORS preflight, and that gets a 404. text/plain would not, so
    // without this any website could spend the daily cap from its visitors' browsers.
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
      return apiError(c, 415, 'content-type must be application/json', 'invalid_request_error');
    }
    if (req.model !== demo.alias) {
      return apiError(
        c,
        403,
        `the public demo only serves the "${demo.alias}" alias`,
        'invalid_request_error',
        'model_not_allowed',
        'model',
      );
    }
    if (req.tools?.length) {
      return apiError(c, 400, 'tools are switched off in the public demo', 'invalid_request_error', null, 'tools');
    }
    if (Buffer.byteLength(JSON.stringify(req.messages)) > demo.maxInputBytes) {
      return apiError(
        c,
        413,
        `messages are over the demo's ${demo.maxInputBytes} byte limit`,
        'invalid_request_error',
        'input_too_long',
        'messages',
      );
    }

    const client = clientId(c.req.header(demo.ipHeader), adminToken);
    const burst = limiter.take(client, demo.perIpPerMinute);
    c.header('x-ratelimit-limit-requests', String(demo.perIpPerMinute));
    if (!burst.allowed) return tooMany(c, burst.retryAfterMs, `${demo.perIpPerMinute} requests a minute per IP`);

    const now = new Date();
    const stamp = now.toISOString();
    const day = stamp.slice(0, 10);
    const nextMinute = (Math.floor(now.getTime() / MINUTE_MS) + 1) * MINUTE_MS;
    const nextDay = Date.parse(day) + DAY_MS;

    // Per-IP windows first: a request they turn down must not use up the
    // daily cap everyone shares.
    const windows = [
      {
        bucket: `ip:${client}:${stamp.slice(0, 16)}`,
        limit: demo.perIpPerMinute,
        ends: nextMinute,
        per: 'a minute per IP',
      },
      { bucket: `ip:${client}:${day}`, limit: demo.perIpPerDay, ends: nextDay, per: 'a day per IP' },
      { bucket: `all:${day}`, limit: demo.dailyCap, ends: nextDay, per: 'a day across the whole demo' },
    ];

    const hits: number[] = [];
    for (const { bucket, limit, ends, per } of windows) {
      const taken = fullBuckets.has(bucket) ? undefined : await store.takeQuota(bucket, limit, new Date(ends));
      if (taken === undefined) {
        if (fullBuckets.size >= MAX_FULL_BUCKETS) fullBuckets.clear();
        fullBuckets.add(bucket);
        return tooMany(c, ends - now.getTime(), `${limit} requests ${per}`);
      }
      hits.push(taken);
    }
    c.header('x-ratelimit-remaining-requests', String(demo.perIpPerMinute - (hits[0] ?? 0)));
    c.header('x-demo-daily-remaining', String(demo.dailyCap - (hits[2] ?? 0)));

    c.set('apiKey', await keyForLogging());
    return capOutput(req, demo.maxOutputTokens);
  };
}

// The adapters read max_completion_tokens first, so capping max_tokens alone
// would leave a way around it. No value at all means the model's own maximum.
function capOutput(req: ChatRequest, cap: number): ChatRequest {
  const asked = req.max_completion_tokens ?? req.max_tokens ?? cap;
  return { ...req, max_tokens: Math.min(asked, cap), max_completion_tokens: undefined };
}

function tooMany(c: Context<GatewayEnv>, retryAfterMs: number, limit: string) {
  c.header('retry-after', String(Math.ceil(retryAfterMs / 1000)));
  return apiError(c, 429, `demo limit of ${limit} reached`, 'rate_limit_error', 'rate_limit_exceeded');
}

/**
 * Only the host's own header is trusted, and only its last entry, which is the
 * one its edge added. No header at all puts the caller in one shared bucket
 * rather than giving them a free pass. Stored as a keyed hash, so the quota
 * table holds no IP addresses.
 */
export function clientId(header: string | undefined, secret: string): string {
  const last = header
    ?.split(',')
    .at(-1)
    ?.trim()
    .toLowerCase()
    .replace(/^::ffff:/, '');
  return createHmac('sha256', secret)
    .update(networkOf(last || 'unknown'))
    .digest('base64url')
    .slice(0, 22);
}

// One IPv6 customer usually gets a whole /64 to pick addresses from, so
// counting single addresses would be no limit at all.
function networkOf(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const [left = '', right] = ip.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const zeros = right === undefined ? [] : Array<string>(8 - head.length - tail.length).fill('0');
  return [...head, ...zeros, ...tail]
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':');
}

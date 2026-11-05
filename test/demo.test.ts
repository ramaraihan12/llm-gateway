import { http, HttpResponse } from 'msw/http';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ResponseCache } from '../src/cache.js';
import { parseConfig } from '../src/config.js';
import type { AppDeps, CachedCompletion } from '../src/deps.js';
import { clientId } from '../src/demo.js';
import { hashKey } from '../src/keys.js';
import { RateLimiter } from '../src/rate-limit.js';
import { buildRegistry } from '../src/registry.js';
import { mockUpstreams, server, sseResponse } from './helpers.js';
import { MemoryStore } from './memory-store.js';

mockUpstreams();

const GEMINI = 'https://gemini.test/v1beta/models/*';
const ADMIN_TOKEN = 'admin-token-for-tests';
const limits = {
  alias: 'demo',
  maxInputBytes: 200,
  maxOutputTokens: 50,
  ipHeader: 'x-real-ip',
  perIpPerMinute: 3,
  perIpPerDay: 5,
  dailyCap: 8,
};

const config = parseConfig({
  providers: {
    gemini: { type: 'gemini', baseUrl: 'https://gemini.test/v1beta', apiKey: 'test-key' },
    ollama: { type: 'ollama', baseUrl: 'http://ollama.test' },
  },
  aliases: { demo: ['gemini/flash-lite'], other: ['ollama/llama'] },
  retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10 },
  demo: limits,
});

/** Each call is a fresh app with its own memory, the way a new serverless instance is. */
function instance(store: MemoryStore, overrides: Partial<AppDeps> = {}) {
  return createApp({
    registry: buildRegistry(config),
    store,
    limiter: new RateLimiter(),
    cache: undefined,
    retry: config.retry,
    pricing: {},
    adminToken: ADMIN_TOKEN,
    log: pino({ level: 'silent' }),
    demo: config.demo,
    ...overrides,
  });
}

type App = ReturnType<typeof instance>;

const hello = { model: 'demo', messages: [{ role: 'user', content: 'Say hello' }] };

function chat(app: App, body: object = hello, ip = '203.0.113.7', headers: Record<string, string> = {}) {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip, ...headers },
    body: JSON.stringify(body),
  });
}

interface GeminiBody {
  generationConfig: { maxOutputTokens?: number };
}

function geminiAnswers() {
  const bodies: GeminiBody[] = [];
  server.use(
    http.post(GEMINI, async ({ request }) => {
      bodies.push((await request.json()) as GeminiBody);
      const answer = {
        candidates: [{ content: { parts: [{ text: 'Hello there' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      };
      return request.url.includes('streamGenerateContent')
        ? sseResponse([{ data: answer }])
        : HttpResponse.json(answer);
    }),
  );
  return bodies;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-05T10:00:10Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('demo mode', () => {
  it('serves the page at / only when the config asks for it', async () => {
    const page = await instance(new MemoryStore()).request('/');
    const off = await instance(new MemoryStore(), { demo: undefined }).request('/');

    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('gemini/flash-lite');
    expect(off.status).toBe(404);
  });

  it('keeps asking for a key when it is off', async () => {
    const app = instance(new MemoryStore(), { demo: undefined });
    geminiAnswers();

    expect((await chat(app)).status).toBe(401);
  });

  it('needs no key and lists only the demo alias', async () => {
    const res = await instance(new MemoryStore()).request('/v1/models');

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    expect(data.map((model) => model.id)).toEqual(['demo']);
  });

  it('answers and shows which provider served it', async () => {
    const store = new MemoryStore();
    geminiAnswers();

    const res = await chat(instance(store));

    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-provider')).toBe('gemini/flash-lite');
    expect(res.headers.get('x-ratelimit-remaining-requests')).toBe('2');
    expect(res.headers.get('x-demo-daily-remaining')).toBe('7');
    expect(store.usage).toHaveLength(1);
    expect(store.usage[0]?.apiKeyId).toBe((await store.demoKey()).id);
  });

  it('streams through the same checks', async () => {
    const bodies = geminiAnswers();

    const res = await chat(instance(new MemoryStore()), { ...hello, stream: true, max_tokens: 9999 });

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-gateway-provider')).toBe('gemini/flash-lite');
    expect(await res.text()).toContain('Hello there');
    expect(bodies[0]?.generationConfig.maxOutputTokens).toBe(50);
  });

  it('hands the usage write to the host so a frozen instance cannot lose it', async () => {
    const background = vi.fn();
    geminiAnswers();
    const app = instance(new MemoryStore(), { background });
    // The first request of an instance also hands over the quota sweep.
    await chat(app);
    background.mockClear();

    await chat(app);

    expect(background).toHaveBeenCalledOnce();
    expect(background.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  });

  it('still needs the admin token', async () => {
    const app = instance(new MemoryStore());

    expect((await app.request('/admin/usage')).status).toBe(401);
    const wrong = await app.request('/admin/usage', { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    const right = await app.request('/admin/usage', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(right.status).toBe(200);
  });
});

describe('what the demo refuses', () => {
  it.each([
    'other',
    'fast',
    'DEMO',
    'demo ',
    'gemini/flash-lite', // the demo's own model, but not through the alias
    'gemini/gemini-3.8-flash',
    'ollama/llama',
    '__proto__',
  ])('refuses model %j without calling anything', async (model) => {
    const store = new MemoryStore();
    const bodies = geminiAnswers();

    const res = await chat(instance(store), { ...hello, model });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'model_not_allowed', param: 'model' } });
    expect(bodies).toHaveLength(0);
    expect(store.quota.size).toBe(0);
  });

  it('gives a real client key no way around the limits', async () => {
    const store = new MemoryStore();
    const key = 'gw-a-real-key';
    await store.createKey({ name: 'real', keyHash: hashKey(key), keyPrefix: 'gw-a', rateLimitPerMinute: 1000 });
    const app = instance(store);
    const bodies = geminiAnswers();
    const authorization = `Bearer ${key}`;

    const refused = await chat(app, { ...hello, model: 'other' }, undefined, { authorization });
    for (let i = 0; i < limits.perIpPerMinute; i++) await chat(app, hello, undefined, { authorization });
    const limited = await chat(app, hello, undefined, { authorization });

    expect(refused.status).toBe(403);
    expect(limited.status).toBe(429);
    expect(bodies).toHaveLength(limits.perIpPerMinute);
  });

  it('refuses tools', async () => {
    const bodies = geminiAnswers();

    const res = await chat(instance(new MemoryStore()), {
      ...hello,
      tools: [{ type: 'function', function: { name: 'x' } }],
    });

    expect(res.status).toBe(400);
    expect(bodies).toHaveLength(0);
  });

  it.each([
    ['one long message', [{ role: 'user', content: 'x'.repeat(300) }]],
    ['many short ones', Array.from({ length: 10 }, () => ({ role: 'user', content: 'x'.repeat(30) }))],
    ['a long system prompt', [{ role: 'system', content: 'x'.repeat(300) }, ...hello.messages]],
    ['multi-byte text', [{ role: 'user', content: '語'.repeat(100) }]],
  ])('refuses %s over the input cap', async (_, messages) => {
    const store = new MemoryStore();
    const bodies = geminiAnswers();

    const res = await chat(instance(store), { ...hello, messages });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'input_too_long' } });
    expect(bodies).toHaveLength(0);
    expect(store.quota.size).toBe(0);
  });

  it('refuses an oversized body whatever field it hides in', async () => {
    const bodies = geminiAnswers();

    const res = await chat(instance(new MemoryStore()), { ...hello, padding: 'x'.repeat(limits.maxInputBytes * 5) });

    expect(res.status).toBe(413);
    expect(bodies).toHaveLength(0);
  });
});

describe('cross-site requests', () => {
  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])(
    'refuses %s, which a browser can send from any site without a preflight',
    async (contentType) => {
      const store = new MemoryStore();
      const bodies = geminiAnswers();

      const res = await chat(instance(store), hello, undefined, { 'content-type': contentType });

      expect(res.status).toBe(415);
      expect(bodies).toHaveLength(0);
      expect(store.quota.size).toBe(0);
    },
  );

  it('accepts json with a charset', async () => {
    geminiAnswers();

    const res = await chat(instance(new MemoryStore()), hello, undefined, {
      'content-type': 'application/json; charset=utf-8',
    });

    expect(res.status).toBe(200);
  });

  it('gives a preflight nothing to work with', async () => {
    const res = await instance(new MemoryStore()).request('/v1/chat/completions', { method: 'OPTIONS' });

    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('output cap', () => {
  it.each([
    ['nothing', {}, 50],
    ['a smaller max_tokens', { max_tokens: 10 }, 10],
    ['a bigger max_tokens', { max_tokens: 9999 }, 50],
    ['a bigger max_completion_tokens', { max_completion_tokens: 9999 }, 50],
    ['both, with the bigger one where the adapter looks first', { max_tokens: 1, max_completion_tokens: 9999 }, 50],
  ])('sends the right limit upstream for %s', async (_, params, expected) => {
    const bodies = geminiAnswers();

    await chat(instance(new MemoryStore()), { ...hello, ...params });

    expect(bodies[0]?.generationConfig.maxOutputTokens).toBe(expected);
  });
});

describe('per-IP limits', () => {
  it('holds across instances that share nothing but the store', async () => {
    const store = new MemoryStore();
    const bodies = geminiAnswers();

    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await chat(instance(store))).status);

    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    expect(bodies).toHaveLength(3);
  });

  it('says when to come back and leaves other clients alone', async () => {
    const store = new MemoryStore();
    geminiAnswers();
    for (let i = 0; i < 3; i++) await chat(instance(store));

    const limited = await chat(instance(store));
    const other = await chat(instance(store), hello, '198.51.100.9');

    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('50');
    expect(await limited.json()).toMatchObject({ error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' } });
    expect(other.status).toBe(200);
  });

  it('cannot be dodged by sending other forwarding headers', async () => {
    const store = new MemoryStore();
    const bodies = geminiAnswers();

    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const spoofed = `10.0.0.${i}`;
      const headers = { 'x-forwarded-for': spoofed, 'x-vercel-forwarded-for': spoofed, forwarded: `for=${spoofed}` };
      statuses.push((await chat(instance(store), hello, undefined, headers)).status);
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(3);
    expect(bodies).toHaveLength(3);
  });

  it('puts requests without the header in one shared bucket instead of letting them through', async () => {
    const store = new MemoryStore();
    geminiAnswers();
    const noIp = (app: App) =>
      app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(hello),
      });

    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await noIp(instance(store))).status);

    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('counts a whole IPv6 /64 as one client', () => {
    const id = (ip: string) => clientId(ip, 'secret');

    expect(id('2001:db8:1:2:aaaa::1')).toBe(id('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    expect(id('2001:db8:1:2::1')).toBe(id('2001:0db8:0001:0002:0000:0000:0000:0002'));
    expect(id('2001:db8:1:2::1')).not.toBe(id('2001:db8:1:3::1'));
    expect(id('::ffff:203.0.113.7')).toBe(id('203.0.113.7'));
    expect(id('10.0.0.1, 203.0.113.7')).toBe(id('203.0.113.7'));
    expect(id('203.0.113.7')).not.toBe(id('203.0.113.8'));
  });

  it('does not keep plain addresses in the bucket names', async () => {
    const store = new MemoryStore();
    geminiAnswers();

    await chat(instance(store));

    expect([...store.quota.keys()].join()).not.toContain('203.0.113.7');
  });

  it('has a daily limit on top of the minute one', async () => {
    const store = new MemoryStore();
    const bodies = geminiAnswers();

    const statuses = [];
    for (let minute = 1; minute <= 3; minute++) {
      vi.setSystemTime(new Date(`2026-11-05T10:0${minute}:10Z`));
      for (let i = 0; i < 3; i++) statuses.push((await chat(instance(store))).status);
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(limits.perIpPerDay);
    expect(bodies).toHaveLength(limits.perIpPerDay);
  });

  it('stops asking the database about a client that keeps going after its 429', async () => {
    const store = new MemoryStore();
    const take = vi.spyOn(store, 'takeQuota');
    geminiAnswers();
    const app = instance(store, {
      limiter: { take: () => ({ allowed: true, remaining: 1, retryAfterMs: 0 }) } as never,
    });
    for (let i = 0; i < 4; i++) await chat(app);
    const callsAtLimit = take.mock.calls.length;

    for (let i = 0; i < 20; i++) expect((await chat(app)).status).toBe(429);

    expect(take.mock.calls.length).toBe(callsAtLimit);
  });
});

describe('global daily cap', () => {
  const ip = (i: number) => `198.51.100.${i}`;

  it('holds across instances and IPs, then opens again the next day', async () => {
    const store = new MemoryStore();
    const bodies = geminiAnswers();

    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await chat(instance(store), hello, ip(i))).status);
    const capped = await chat(instance(store), hello, ip(99));

    expect(statuses.filter((status) => status === 200)).toHaveLength(limits.dailyCap);
    expect(bodies).toHaveLength(limits.dailyCap);
    expect(capped.status).toBe(429);
    expect(capped.headers.get('retry-after')).toBe(String(14 * 3600 - 10));
    expect(await capped.text()).toContain('a day across the whole demo');

    vi.setSystemTime(new Date('2026-11-06T00:00:01Z'));
    expect((await chat(instance(store), hello, ip(100))).status).toBe(200);
  });

  it('is not used up by requests the other checks refuse', async () => {
    const store = new MemoryStore();
    geminiAnswers();

    for (let i = 0; i < 30; i++) await chat(instance(store), hello, ip(1));
    for (let i = 0; i < 10; i++) await chat(instance(store), { ...hello, model: 'other' }, ip(i));

    expect(store.quota.get('all:2026-11-05')?.hits).toBe(limits.perIpPerMinute);
  });
});

describe('when the quota store is down', () => {
  it('refuses the request and does not call the model', async () => {
    const store = new MemoryStore();
    vi.spyOn(store, 'takeQuota').mockRejectedValue(new Error('connection refused'));
    const bodies = geminiAnswers();

    const res = await chat(instance(store));

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('connection refused');
    expect(bodies).toHaveLength(0);
  });

  it('recovers once the store does, without a restart', async () => {
    const store = new MemoryStore();
    vi.spyOn(store, 'demoKey').mockRejectedValueOnce(new Error('connection refused'));
    geminiAnswers();
    const app = instance(store);

    expect((await chat(app)).status).toBe(500);
    expect((await chat(app)).status).toBe(200);
  });
});

describe('cache', () => {
  it('still counts a cached answer against the limits', async () => {
    const store = new MemoryStore();
    const bodies = geminiAnswers();
    const app = instance(store, { cache: new ResponseCache<CachedCompletion>(60_000, 10) });

    const first = await chat(app);
    const second = await chat(app);

    expect(first.headers.get('x-gateway-cache')).toBe('miss');
    expect(second.headers.get('x-gateway-cache')).toBe('hit');
    expect(bodies).toHaveLength(1);
    expect(second.headers.get('x-ratelimit-remaining-requests')).toBe('1');
  });
});

describe('stream errors', () => {
  it('keeps upstream wording out of the error event', async () => {
    server.use(
      http.post(GEMINI, () =>
        sseResponse([
          { data: { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] } },
          { data: { error: { code: 500, message: 'project 1234 is over quota' } } },
        ]),
      ),
    );

    const res = await chat(instance(new MemoryStore()), { ...hello, stream: true });
    const text = await res.text();

    expect(text).not.toContain('project 1234');
    expect(text).toContain('gemini/flash-lite failed mid-stream');
  });
});

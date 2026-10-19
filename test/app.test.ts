import { http, HttpResponse } from 'msw/http';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ResponseCache } from '../src/cache.js';
import { parseConfig } from '../src/config.js';
import type { CachedCompletion } from '../src/deps.js';
import { hashKey } from '../src/keys.js';
import type { ChatCompletion, ChatCompletionChunk } from '../src/openai.js';
import { RateLimiter } from '../src/rate-limit.js';
import { buildRegistry } from '../src/registry.js';
import { mockUpstreams, ndjsonResponse, server } from './helpers.js';
import { MemoryStore } from './memory-store.js';

mockUpstreams();

const OLLAMA = 'http://ollama.test/api/chat';
const OPENAI = 'https://openai.test/v1/chat/completions';
const API_KEY = 'gw-test-key';
const ADMIN_TOKEN = 'admin-token-for-tests';

const config = parseConfig({
  providers: {
    openai: { type: 'openai', baseUrl: 'https://openai.test/v1', apiKey: 'sk-test' },
    ollama: { type: 'ollama', baseUrl: 'http://ollama.test' },
    gemini: { type: 'gemini', apiKey: '' },
  },
  aliases: {
    fast: ['openai/gpt-5.4-mini', 'ollama/qwen3.5-9b:iq4xs'],
    local: ['ollama/qwen3.5-9b:iq4xs'],
    cloud: ['gemini/gemini-3.8-flash'],
  },
  retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 },
  pricing: {
    'openai/gpt-5.4-mini': { input: 0.75, output: 4.5 },
    'ollama/qwen3.5-9b:iq4xs': { input: 0, output: 0 },
  },
});

async function setup({ rpm = 100, cache = false } = {}) {
  const store = new MemoryStore();
  await store.createKey({ name: 'tester', keyHash: hashKey(API_KEY), keyPrefix: 'gw-test', rateLimitPerMinute: rpm });
  const app = createApp({
    registry: buildRegistry(config),
    store,
    limiter: new RateLimiter(),
    cache: cache ? new ResponseCache<CachedCompletion>(60_000, 10) : undefined,
    retry: config.retry,
    pricing: config.pricing,
    adminToken: ADMIN_TOKEN,
    log: pino({ level: 'silent' }),
  });
  const chat = (body: object, apiKey = API_KEY) =>
    app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, store, chat };
}

const hello = { model: 'local', messages: [{ role: 'user', content: 'Say hello' }] };

/** Ollama mock that answers JSON or NDJSON depending on the request. */
function ollamaSays(text: string, calls = { count: 0 }) {
  server.use(
    http.post(OLLAMA, async ({ request }) => {
      calls.count++;
      const body = (await request.json()) as { stream: boolean };
      const final = { done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 3 };
      if (!body.stream) return HttpResponse.json({ message: { role: 'assistant', content: text }, ...final });
      const [head, tail] = [text.slice(0, 3), text.slice(3)];
      return ndjsonResponse([
        { message: { role: 'assistant', content: head }, done: false },
        { message: { role: 'assistant', content: tail }, done: false },
        { message: { role: 'assistant', content: '' }, ...final },
      ]);
    }),
  );
  return calls;
}

function openaiFails(status: number, calls = { count: 0 }) {
  server.use(
    http.post(OPENAI, () => {
      calls.count++;
      return HttpResponse.json({ error: { message: 'upstream is sad' } }, { status });
    }),
  );
  return calls;
}

function parseSse(text: string): (ChatCompletionChunk | '[DONE]' | { error: { message: string } })[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => {
      const data = block.slice(6);
      return data === '[DONE]' ? '[DONE]' : (JSON.parse(data) as ChatCompletionChunk);
    });
}

describe('auth', () => {
  it('rejects requests without a key or with an unknown key', async () => {
    const { app, chat } = await setup();

    const missing = await app.request('/v1/models');
    const wrong = await chat(hello, 'gw-nope');

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: { type: 'authentication_error', code: 'invalid_api_key' } });
  });
});

describe('GET /v1/models', () => {
  it('lists aliases that have at least one usable provider', async () => {
    const { app } = await setup();

    const res = await app.request('/v1/models', { headers: { authorization: `Bearer ${API_KEY}` } });

    expect(await res.json()).toEqual({
      object: 'list',
      data: [
        {
          id: 'fast',
          object: 'model',
          created: 0,
          owned_by: 'llm-gateway',
          targets: ['openai/gpt-5.4-mini', 'ollama/qwen3.5-9b:iq4xs'],
        },
        { id: 'local', object: 'model', created: 0, owned_by: 'llm-gateway', targets: ['ollama/qwen3.5-9b:iq4xs'] },
      ],
    });
  });
});

describe('POST /v1/chat/completions', () => {
  it('validates the body and the model name', async () => {
    const { chat } = await setup();

    const invalid = await chat({ model: 'local' });
    const unknown = await chat({ ...hello, model: 'gpt-4' });
    const noProvider = await chat({ ...hello, model: 'cloud' });

    expect(invalid.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'model_not_found' } });
    expect(noProvider.status).toBe(503);
  });

  it('returns an OpenAI-shaped completion and logs usage with cost', async () => {
    const { chat, store } = await setup();
    server.use(
      http.post(OPENAI, () =>
        HttpResponse.json({
          choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }),
      ),
    );

    const res = await chat({ ...hello, model: 'fast' });
    const body = (await res.json()) as ChatCompletion;

    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-provider')).toBe('openai/gpt-5.4-mini');
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-5.4-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    });
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(store.usage).toEqual([
      expect.objectContaining({
        requestedModel: 'fast',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        status: 'ok',
        attempts: 1,
        promptTokens: 1000,
        completionTokens: 500,
        costUsd: 0.003,
      }),
    ]);
  });

  it('falls back to ollama when openai keeps failing', async () => {
    const { chat, store } = await setup();
    const openai = openaiFails(503);
    ollamaSays('Hello from Ollama');

    const res = await chat({ ...hello, model: 'fast' });

    expect(res.status).toBe(200);
    expect(openai.count).toBe(2);
    expect(res.headers.get('x-gateway-provider')).toBe('ollama/qwen3.5-9b:iq4xs');
    expect(res.headers.get('x-gateway-attempts')).toBe('3');
    expect(((await res.json()) as ChatCompletion).choices[0]?.message.content).toBe('Hello from Ollama');
    expect(store.usage[0]).toMatchObject({ provider: 'ollama', attempts: 3, costUsd: 0 });
  });

  it('answers 502 and logs an error when every provider fails', async () => {
    const { chat, store } = await setup();
    openaiFails(401);
    server.use(http.post(OLLAMA, () => HttpResponse.json({ error: 'model not found' }, { status: 404 })));

    const res = await chat({ ...hello, model: 'fast' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: {
        message:
          'all providers failed: openai/gpt-5.4-mini: 401 upstream is sad; ollama/qwen3.5-9b:iq4xs: 404 model not found',
        type: 'upstream_error',
        param: null,
        code: null,
      },
    });
    expect(store.usage[0]).toMatchObject({ status: 'error', provider: null, attempts: 2 });
  });
});

describe('streaming', () => {
  it('translates the upstream stream into OpenAI chunks', async () => {
    const { chat, store } = await setup();
    ollamaSays('Hello there');

    const res = await chat({ ...hello, stream: true, stream_options: { include_usage: true } });
    const events = parseSse(await res.text());
    const chunks = events.filter((e): e is ChatCompletionChunk => typeof e === 'object' && 'choices' in e);

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(events.at(-1)).toBe('[DONE]');
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    expect(chunks.every((c) => c.object === 'chat.completion.chunk' && c.model === 'qwen3.5-9b:iq4xs')).toBe(true);
    expect(chunks[0]?.choices[0]?.delta.role).toBe('assistant');
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Hello there');
    expect(chunks.at(-2)?.choices[0]?.finish_reason).toBe('stop');
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    });
    expect(store.usage[0]).toMatchObject({ stream: true, status: 'ok', promptTokens: 11, completionTokens: 3 });
  });

  it('only sends the usage chunk when the client asks for it', async () => {
    const { chat } = await setup();
    ollamaSays('Hi');

    const events = parseSse(await (await chat({ ...hello, stream: true })).text());

    expect(events.some((e) => typeof e === 'object' && 'usage' in e)).toBe(false);
  });

  it('can still fall back before the first byte is sent', async () => {
    const { chat } = await setup();
    openaiFails(500);
    ollamaSays('Recovered');

    const res = await chat({ ...hello, model: 'fast', stream: true });
    const chunks = parseSse(await res.text()).filter((e): e is ChatCompletionChunk => typeof e === 'object');

    expect(res.headers.get('x-gateway-provider')).toBe('ollama/qwen3.5-9b:iq4xs');
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Recovered');
  });

  it('ends with an error event when the upstream stream breaks off', async () => {
    const { chat, store } = await setup();
    server.use(
      http.post(OLLAMA, () =>
        ndjsonResponse([{ message: { role: 'assistant', content: 'Half an ans' }, done: false }]),
      ),
    );

    const events = parseSse(await (await chat({ ...hello, stream: true })).text());

    expect(events.at(-1)).toEqual({
      error: { message: 'upstream stream ended before it finished', type: 'upstream_error' },
    });
    expect(store.usage[0]).toMatchObject({ status: 'error', error: 'upstream stream ended before it finished' });
  });
});

describe('rate limiting', () => {
  it('returns 429 with Retry-After once the per-key budget is used up', async () => {
    const { chat } = await setup({ rpm: 2 });
    ollamaSays('ok');

    const first = await chat(hello);
    await chat(hello);
    const third = await chat(hello);

    expect(first.headers.get('x-ratelimit-limit-requests')).toBe('2');
    expect(first.headers.get('x-ratelimit-remaining-requests')).toBe('1');
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('30');
    expect(await third.json()).toMatchObject({ error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' } });
  });
});

describe('response cache', () => {
  it('serves an identical request from memory and skips the provider', async () => {
    const { chat, store } = await setup({ cache: true });
    const calls = ollamaSays('cached answer');

    const first = await chat(hello);
    const second = await chat(hello);
    const different = await chat({ ...hello, temperature: 0.5 });

    expect(first.headers.get('x-gateway-cache')).toBe('miss');
    expect(second.headers.get('x-gateway-cache')).toBe('hit');
    expect(((await second.json()) as ChatCompletion).choices[0]?.message.content).toBe('cached answer');
    expect(different.headers.get('x-gateway-cache')).toBe('miss');
    expect(calls.count).toBe(2);
    expect(store.usage[1]).toMatchObject({ cached: true, costUsd: 0, attempts: 0 });
  });
});

describe('GET /admin/usage', () => {
  it('needs the admin token', async () => {
    const { app } = await setup();

    const res = await app.request('/admin/usage', { headers: { authorization: `Bearer ${API_KEY}` } });

    expect(res.status).toBe(401);
  });

  it('summarises usage per model and per key', async () => {
    const { app, chat } = await setup();
    openaiFails(503);
    ollamaSays('hi');
    await chat(hello);
    await chat({ ...hello, model: 'fast' });

    const res = await app.request('/admin/usage', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    const summary = (await res.json()) as { totals: object; byModel: object[]; byKey: object[] };

    expect(res.status).toBe(200);
    expect(summary.totals).toEqual({
      requests: 2,
      errors: 0,
      cacheHits: 0,
      promptTokens: 22,
      completionTokens: 6,
      costUsd: 0,
    });
    expect(summary.byModel).toEqual([expect.objectContaining({ provider: 'ollama', requests: 2 })]);
    expect(summary.byKey).toEqual([expect.objectContaining({ key: 'tester', requests: 2 })]);
  });

  it('rejects a since value that is not a date', async () => {
    const { app } = await setup();

    const res = await app.request('/admin/usage?since=yesterday', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(res.status).toBe(400);
  });
});

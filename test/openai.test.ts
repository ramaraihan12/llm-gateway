import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/errors.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { chatRequest, collect, server, signal, sseResponse } from './helpers.js';

const URL = 'https://openai.test/v1/chat/completions';
const openai = new OpenAIProvider('openai', { baseUrl: 'https://openai.test/v1', apiKey: 'sk-test' });

describe('openai adapter', () => {
  it('sends max_completion_tokens and drops gemini-only fields', async () => {
    let sent: Record<string, unknown> = {};
    let auth: string | null = null;
    server.use(
      http.post(URL, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        auth = request.headers.get('authorization');
        return HttpResponse.json({
          choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 1 },
        });
      }),
    );

    const result = await openai.complete(
      chatRequest({
        max_tokens: 50,
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'f', arguments: '{}' },
                extra_content: { google: { thought_signature: 'sig' } },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        ],
      }),
      { model: 'gpt-5.4-mini', signal },
    );

    expect(auth).toBe('Bearer sk-test');
    expect(sent).toMatchObject({ model: 'gpt-5.4-mini', max_completion_tokens: 50, stream: false });
    expect(sent).not.toHaveProperty('max_tokens');
    expect(JSON.stringify(sent)).not.toContain('extra_content');
    expect(result).toEqual({
      message: { role: 'assistant', content: 'done' },
      finishReason: 'stop',
      usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 },
    });
  });

  it('streams tool call deltas and asks for usage', async () => {
    let sent: Record<string, unknown> = {};
    server.use(
      http.post(URL, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return sseResponse([
          { data: { choices: [{ delta: { role: 'assistant', content: null }, finish_reason: null }] } },
          {
            data: {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '' } },
                    ],
                  },
                },
              ],
            },
          },
          { data: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":1}' } }] } }] } },
          { data: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } },
          { data: { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } } },
          '[DONE]',
        ]);
      }),
    );

    const parts = await collect(await openai.stream(chatRequest(), { model: 'gpt-5.4-mini', signal }));

    expect(sent).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(parts).toEqual([
      { type: 'delta', delta: { role: 'assistant' } },
      {
        type: 'delta',
        delta: {
          tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '' } }],
        },
      },
      { type: 'delta', delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":1}' } }] } },
      { type: 'finish', reason: 'tool_calls' },
      { type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
    ]);
  });

  it('marks 429 as retryable and reads Retry-After', async () => {
    server.use(
      http.post(URL, () =>
        HttpResponse.json(
          { error: { message: 'Rate limit reached', type: 'requests' } },
          { status: 429, headers: { 'retry-after': '2' } },
        ),
      ),
    );

    const error = await openai.complete(chatRequest(), { model: 'm', signal }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 429, retryable: true, retryAfterMs: 2000 });
  });

  it('does not retry a bad API key', async () => {
    server.use(
      http.post(URL, () => HttpResponse.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 })),
    );

    const error = await openai.complete(chatRequest(), { model: 'm', signal }).catch((err: unknown) => err);

    expect(error).toMatchObject({ status: 401, retryable: false, message: '401 Incorrect API key provided' });
  });
});

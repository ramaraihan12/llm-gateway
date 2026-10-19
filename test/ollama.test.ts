import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/errors.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { chatRequest, collect, mockUpstreams, ndjsonResponse, server, signal } from './helpers.js';

mockUpstreams();

const URL = 'http://ollama.test/api/chat';
const ollama = new OllamaProvider('ollama', { baseUrl: 'http://ollama.test', think: false });

describe('ollama adapter', () => {
  it('translates a tool round trip into the native format', async () => {
    let sent: Record<string, unknown> = {};
    server.use(
      http.post(URL, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_9', function: { name: 'get_weather', arguments: { city: 'Salatiga' } } }],
          },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 40,
          eval_count: 12,
        });
      }),
    );

    const result = await ollama.complete(
      chatRequest({
        max_tokens: 64,
        stop: 'END',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'weather in Jakarta?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '31C, humid' },
        ],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      }),
      { model: 'qwen3.5-9b:iq4xs', signal },
    );

    expect(sent).toMatchObject({
      model: 'qwen3.5-9b:iq4xs',
      stream: false,
      think: false,
      options: { num_predict: 64, stop: ['END'] },
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather in Jakarta?' },
        { role: 'assistant', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Jakarta' } } }] },
        { role: 'tool', content: '31C, humid', tool_name: 'get_weather' },
      ],
    });
    expect(result.message.tool_calls).toEqual([
      { id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Salatiga"}' } },
    ]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({ prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 });
  });

  it('streams ndjson into deltas, a finish reason and usage', async () => {
    server.use(
      http.post(URL, () =>
        ndjsonResponse([
          { message: { role: 'assistant', content: 'Hel' }, done: false },
          { message: { role: 'assistant', content: 'lo' }, done: false },
          {
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'length',
            prompt_eval_count: 5,
            eval_count: 2,
          },
        ]),
      ),
    );

    const parts = await collect(await ollama.stream(chatRequest(), { model: 'm', signal }));

    expect(parts).toEqual([
      { type: 'delta', delta: { role: 'assistant', content: 'Hel' } },
      { type: 'delta', delta: { content: 'lo' } },
      { type: 'finish', reason: 'length' },
      { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ]);
  });

  it('leaves tools out when tool_choice is none', async () => {
    let sent: Record<string, unknown> = {};
    server.use(
      http.post(URL, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ message: { role: 'assistant', content: 'ok' }, done: true });
      }),
    );

    await ollama.complete(
      chatRequest({ tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'none' }),
      { model: 'm', signal },
    );

    expect(sent.tools).toBeUndefined();
  });

  it('reports a missing model as a non-retryable provider error', async () => {
    server.use(http.post(URL, () => HttpResponse.json({ error: "model 'nope' not found" }, { status: 404 })));

    const error = await ollama.complete(chatRequest(), { model: 'nope', signal }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 404, retryable: false, message: "404 model 'nope' not found" });
  });
});

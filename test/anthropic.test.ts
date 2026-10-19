import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/errors.js';
import { AnthropicProvider, toAnthropicMessages } from '../src/providers/anthropic.js';
import { chatRequest, collect, server, signal, sseResponse } from './helpers.js';

const URL = 'https://anthropic.test/v1/messages';
const anthropic = new AnthropicProvider('anthropic', { baseUrl: 'https://anthropic.test/v1', apiKey: 'ak-test' });

describe('anthropic message translation', () => {
  it('lifts system prompts out and merges parallel tool results into one user turn', () => {
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'You are terse.' },
      { role: 'developer', content: [{ type: 'text', text: 'Answer in English.' }] },
      { role: 'user', content: 'Compare Jakarta and Bandung weather' },
      {
        role: 'assistant',
        content: 'Checking both.',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'weather', arguments: '{"city":"Jakarta"}' } },
          { id: 't2', type: 'function', function: { name: 'weather', arguments: '{"city":"Bandung"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: '31C' },
      { role: 'tool', tool_call_id: 't2', content: '24C' },
    ]);

    expect(system).toBe('You are terse.\n\nAnswer in English.');
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Compare Jakarta and Bandung weather' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking both.' },
          { type: 'tool_use', id: 't1', name: 'weather', input: { city: 'Jakarta' } },
          { type: 'tool_use', id: 't2', name: 'weather', input: { city: 'Bandung' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '31C' },
          { type: 'tool_result', tool_use_id: 't2', content: '24C' },
        ],
      },
    ]);
  });
});

describe('anthropic adapter', () => {
  it('fills in the fields Anthropic requires and maps tool_use back to tool_calls', async () => {
    let sent: Record<string, unknown> = {};
    let headers = new Headers();
    server.use(
      http.post(URL, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        headers = request.headers;
        return HttpResponse.json({
          content: [
            { type: 'text', text: 'Let me look.' },
            { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'hono' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
        });
      }),
    );

    const result = await anthropic.complete(
      chatRequest({
        temperature: 1.5,
        top_p: 0.9,
        tools: [{ type: 'function', function: { name: 'search', description: 'web search' } }],
        tool_choice: 'required',
      }),
      { model: 'claude-haiku-4-5', signal },
    );

    expect(headers.get('x-api-key')).toBe('ak-test');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(sent).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      temperature: 1,
      tool_choice: { type: 'any' },
      tools: [{ name: 'search', description: 'web search', input_schema: { type: 'object', properties: {} } }],
    });
    expect(sent).not.toHaveProperty('top_p');
    expect(result).toEqual({
      message: {
        role: 'assistant',
        content: 'Let me look.',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'search', arguments: '{"q":"hono"}' } }],
      },
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 150, completion_tokens: 20, total_tokens: 170 },
    });
  });

  it('turns content block events into OpenAI-style deltas', async () => {
    server.use(
      http.post(URL, () =>
        sseResponse([
          {
            event: 'message_start',
            data: { type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 1 } } },
          },
          {
            event: 'content_block_start',
            data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          },
          { event: 'ping', data: { type: 'ping' } },
          {
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'On it.' } },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'toolu_x', name: 'search', input: {} },
            },
          },
          {
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '"sse"}' },
            },
          },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
          {
            event: 'message_delta',
            data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 17 } },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]),
      ),
    );

    const parts = await collect(await anthropic.stream(chatRequest(), { model: 'claude-haiku-4-5', signal }));

    expect(parts).toEqual([
      { type: 'delta', delta: { role: 'assistant' } },
      { type: 'delta', delta: { content: 'On it.' } },
      {
        type: 'delta',
        delta: {
          tool_calls: [{ index: 0, id: 'toolu_x', type: 'function', function: { name: 'search', arguments: '' } }],
        },
      },
      { type: 'delta', delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } },
      { type: 'delta', delta: { tool_calls: [{ index: 0, function: { arguments: '"sse"}' } }] } },
      { type: 'finish', reason: 'tool_calls' },
      { type: 'usage', usage: { prompt_tokens: 30, completion_tokens: 17, total_tokens: 47 } },
    ]);
  });

  it('treats an overloaded error inside the stream as retryable', async () => {
    server.use(
      http.post(URL, () =>
        sseResponse([
          { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
        ]),
      ),
    );

    const stream = await anthropic.stream(chatRequest(), { model: 'm', signal });
    const error = await collect(stream).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ retryable: true, message: 'overloaded_error: Overloaded' });
  });
});

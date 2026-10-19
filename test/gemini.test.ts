import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { InvalidRequestError } from '../src/errors.js';
import { GeminiProvider, SKIP_SIGNATURE, toGeminiContents } from '../src/providers/gemini.js';
import { chatRequest, collect, mockUpstreams, server, signal, sseResponse } from './helpers.js';

mockUpstreams();

const BASE = 'https://gemini.test/v1beta';
const gemini = new GeminiProvider('gemini', { baseUrl: BASE, apiKey: 'g-test' });

describe('gemini content translation', () => {
  it('maps roles, names function responses and keeps thought signatures', () => {
    const { system, contents } = toGeminiContents([
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Salatiga"}' },
            extra_content: { google: { thought_signature: 'real-sig' } },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"temp":24}' },
      { role: 'tool', tool_call_id: 'c1', content: 'plain text result' },
    ]);

    expect(system).toBe('Be helpful.');
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather?' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'weather', args: { city: 'Salatiga' } }, thoughtSignature: 'real-sig' }],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'weather', response: { temp: 24 } } },
          { functionResponse: { name: 'weather', response: { result: 'plain text result' } } },
        ],
      },
    ]);
  });

  it('puts the documented placeholder on the first call when the signature was lost', () => {
    const { contents } = toGeminiContents([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } },
        ],
      },
    ]);

    expect(contents[0]?.parts).toEqual([
      { functionCall: { name: 'f', args: {} }, thoughtSignature: SKIP_SIGNATURE },
      { functionCall: { name: 'g', args: {} } },
    ]);
  });

  it('rejects a tool result that points at no known call', () => {
    expect(() => toGeminiContents([{ role: 'tool', tool_call_id: 'missing', content: 'x' }])).toThrow(
      InvalidRequestError,
    );
  });
});

describe('gemini adapter', () => {
  it('builds a generateContent request and maps function calls back', async () => {
    let sent: Record<string, unknown> = {};
    let key: string | null = null;
    server.use(
      http.post(`${BASE}/models/gemini-3.8-flash:generateContent`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        key = request.headers.get('x-goog-api-key');
        return HttpResponse.json({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'thinking about it', thought: true },
                  { functionCall: { name: 'search', args: { q: 'drizzle' } }, thoughtSignature: 'sig-1' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 30 },
        });
      }),
    );

    const result = await gemini.complete(
      chatRequest({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'find drizzle docs' },
        ],
        temperature: 0.2,
        max_completion_tokens: 256,
        tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
        tool_choice: { type: 'function', function: { name: 'search' } },
      }),
      { model: 'gemini-3.8-flash', signal },
    );

    expect(key).toBe('g-test');
    expect(sent).toEqual({
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [{ role: 'user', parts: [{ text: 'find drizzle docs' }] }],
      tools: [{ functionDeclarations: [{ name: 'search', parametersJsonSchema: { type: 'object' } }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search'] } },
      generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
    });
    expect(result.message.content).toBeNull();
    expect(result.message.tool_calls).toEqual([
      {
        id: expect.stringMatching(/^call_/) as string,
        type: 'function',
        function: { name: 'search', arguments: '{"q":"drizzle"}' },
        extra_content: { google: { thought_signature: 'sig-1' } },
      },
    ]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 35, total_tokens: 47 });
  });

  it('streams sse chunks and reports the final usage', async () => {
    let url = '';
    server.use(
      http.post(`${BASE}/models/gemini-3.8-flash:streamGenerateContent`, ({ request }) => {
        url = request.url;
        return sseResponse([
          {
            data: { candidates: [{ content: { parts: [{ text: 'Sala' }] } }], usageMetadata: { promptTokenCount: 4 } },
          },
          {
            data: {
              candidates: [{ content: { parts: [{ text: 'tiga' }] }, finishReason: 'MAX_TOKENS' }],
              usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
            },
          },
        ]);
      }),
    );

    const parts = await collect(await gemini.stream(chatRequest(), { model: 'gemini-3.8-flash', signal }));

    expect(new URL(url).searchParams.get('alt')).toBe('sse');
    expect(parts).toEqual([
      { type: 'delta', delta: { role: 'assistant', content: 'Sala' } },
      { type: 'delta', delta: { content: 'tiga' } },
      { type: 'finish', reason: 'length' },
      { type: 'usage', usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
    ]);
  });

  it('treats a blocked prompt as a content filter stop', async () => {
    server.use(
      http.post(`${BASE}/models/m:generateContent`, () =>
        HttpResponse.json({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 3 } }),
      ),
    );

    const result = await gemini.complete(chatRequest(), { model: 'm', signal });

    expect(result.finishReason).toBe('content_filter');
    expect(result.message.content).toBeNull();
  });
});

import { HttpResponse } from 'msw/http';
import { setupServer } from 'msw/node';
import type { ChatRequest } from '../src/openai.js';
import type { StreamPart } from '../src/providers/types.js';

export const server = setupServer();

export const signal = new AbortController().signal;

export function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'test', messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

/**
 * Streams the body in small slices so the parsers have to deal with lines
 * and events that are split across network chunks.
 */
export function streamedResponse(text: string, contentType: string, sliceSize = 7): HttpResponse<ReadableStream> {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += sliceSize) controller.enqueue(bytes.slice(i, i + sliceSize));
      controller.close();
    },
  });
  return new HttpResponse(body, { headers: { 'content-type': contentType } });
}

export function sseResponse(events: ({ event?: string; data: unknown } | string)[]) {
  const text = events
    .map((e) => {
      if (typeof e === 'string') return `data: ${e}\n\n`;
      const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
      return `${e.event ? `event: ${e.event}\n` : ''}data: ${data}\n\n`;
    })
    .join('');
  return streamedResponse(text, 'text/event-stream');
}

export function ndjsonResponse(lines: unknown[]) {
  return streamedResponse(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'application/x-ndjson');
}

export async function collect(parts: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const out: StreamPart[] = [];
  for await (const part of parts) out.push(part);
  return out;
}

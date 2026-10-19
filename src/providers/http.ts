import { randomBytes } from 'node:crypto';
import { InvalidRequestError, ProviderError, errorFromResponse } from '../errors.js';
import type { ChatMessage, ChatRequest } from '../openai.js';

export async function postJson(
  provider: string,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Aborts are either our timeout or the client hanging up. The router
    // knows which one it was, so let it decide.
    if (signal.aborted) throw err;
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new ProviderError(provider, `network error: ${cause}`, undefined, true);
  }
  if (!res.ok) throw await errorFromResponse(provider, res);
  return res;
}

export function requireBody(provider: string, res: Response): ReadableStream<Uint8Array> {
  if (!res.body) throw new ProviderError(provider, 'empty response body', res.status, true);
  return res.body;
}

async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Minimal server-sent events reader: handles `event:`, multi-line `data:` and comments. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  for await (const line of readLines(body)) {
    if (line === '') {
      if (data.length > 0) yield { event, data: data.join('\n') };
      event = undefined;
      data = [];
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    }
  }
  if (data.length > 0) yield { event, data: data.join('\n') };
}

/** Newline-delimited JSON, which is what Ollama streams instead of SSE. */
export async function* readJsonLines<T>(provider: string, body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  for await (const line of readLines(body)) {
    if (line.trim()) yield parseJson<T>(provider, line);
  }
}

export function parseJson<T>(provider: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(provider, `invalid JSON from upstream: ${text.slice(0, 120)}`, undefined, false);
  }
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // reported below
  }
  throw new InvalidRequestError(`tool call arguments must be a JSON object, got: ${raw.slice(0, 80)}`);
}

export function newToolCallId(): string {
  return `call_${randomBytes(12).toString('base64url')}`;
}

export function maxTokens(req: ChatRequest): number | undefined {
  return req.max_completion_tokens ?? req.max_tokens ?? undefined;
}

export function stopSequences(req: ChatRequest): string[] | undefined {
  if (req.stop == null) return undefined;
  return typeof req.stop === 'string' ? [req.stop] : req.stop;
}

/** Tool messages only carry the call id, some providers also want the function name. */
export function toolNamesById(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const call of msg.tool_calls ?? []) names.set(call.id, call.function.name);
  }
  return names;
}

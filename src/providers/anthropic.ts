// Anthropic Messages API. The big differences from OpenAI: system prompt is a
// top-level field, tool results go back as user messages, and the stream is a
// sequence of typed content-block events.
import { ProviderError } from '../errors.js';
import { textOf, usage, type ChatMessage, type ChatRequest, type FinishReason, type ToolCall } from '../openai.js';
import { maxTokens, parseJson, parseToolArguments, postJson, readSse, requireBody, stopSequences } from './http.js';
import type { CallOptions, CompletionResult, Provider, StreamPart } from './types.js';

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
}

const API_VERSION = '2023-06-01';
// Anthropic requires max_tokens on every request, OpenAI clients often omit it.
const DEFAULT_MAX_TOKENS = 4096;

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponse {
  content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  stop_reason: string | null;
  usage: AnthropicUsage;
}

type StreamEvent =
  | { type: 'message_start'; message: { usage: AnthropicUsage } }
  | {
      type: 'content_block_start';
      index: number;
      content_block: { type: string; id?: string; name?: string };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta: { type: string; text?: string; partial_json?: string };
    }
  | { type: 'message_delta'; delta: { stop_reason?: string | null }; usage?: AnthropicUsage }
  | { type: 'message_stop' | 'content_block_stop' | 'ping' }
  | { type: 'error'; error: { type: string; message: string } };

export class AnthropicProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly opts: AnthropicOptions,
  ) {}

  async complete(req: ChatRequest, { model, signal }: CallOptions): Promise<CompletionResult> {
    const res = await this.post(req, model, false, signal);
    const data = (await res.json()) as AnthropicResponse;

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of data.content) {
      if (block.type === 'text') text += block.text ?? '';
      if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }

    return {
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      },
      finishReason: finishReason(data.stop_reason),
      usage: toUsage(data.usage),
    };
  }

  async stream(req: ChatRequest, { model, signal }: CallOptions): Promise<AsyncIterable<StreamPart>> {
    const res = await this.post(req, model, true, signal);
    return this.parseStream(requireBody(this.name, res));
  }

  private async *parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamPart> {
    let tokens: AnthropicUsage = {};
    let stopReason: string | null | undefined;
    // Anthropic numbers content blocks (text and tool_use mixed), OpenAI
    // numbers tool calls only.
    const toolIndexByBlock = new Map<number, number>();

    for await (const { data } of readSse(body)) {
      const event = parseJson<StreamEvent>(this.name, data);
      switch (event.type) {
        case 'message_start':
          tokens = { ...event.message.usage };
          yield { type: 'delta', delta: { role: 'assistant' } };
          break;
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            const index = toolIndexByBlock.size;
            toolIndexByBlock.set(event.index, index);
            yield {
              type: 'delta',
              delta: {
                tool_calls: [
                  {
                    index,
                    id: event.content_block.id,
                    type: 'function',
                    function: { name: event.content_block.name, arguments: '' },
                  },
                ],
              },
            };
          }
          break;
        case 'content_block_delta':
          if (event.delta.type === 'text_delta' && event.delta.text) {
            yield { type: 'delta', delta: { content: event.delta.text } };
          } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
            const index = toolIndexByBlock.get(event.index);
            if (index !== undefined) {
              yield {
                type: 'delta',
                delta: { tool_calls: [{ index, function: { arguments: event.delta.partial_json } }] },
              };
            }
          }
          break;
        case 'message_delta':
          stopReason = event.delta.stop_reason ?? stopReason;
          tokens = { ...tokens, ...event.usage };
          break;
        case 'message_stop':
          yield { type: 'finish', reason: finishReason(stopReason) };
          yield { type: 'usage', usage: toUsage(tokens) };
          return;
        case 'error':
          throw new ProviderError(
            this.name,
            `${event.error.type}: ${event.error.message}`,
            undefined,
            event.error.type === 'overloaded_error' || event.error.type === 'api_error',
          );
      }
    }
  }

  private post(req: ChatRequest, model: string, stream: boolean, signal: AbortSignal): Promise<Response> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const body = {
      model,
      stream,
      system: system || undefined,
      messages,
      max_tokens: maxTokens(req) ?? DEFAULT_MAX_TOKENS,
      // Anthropic's temperature goes up to 1, OpenAI's up to 2.
      temperature: req.temperature == null ? undefined : Math.min(req.temperature, 1),
      // Recent Claude models refuse temperature and top_p together, temperature wins.
      top_p: req.temperature == null ? (req.top_p ?? undefined) : undefined,
      stop_sequences: stopSequences(req),
      tools: req.tools?.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
      })),
      tool_choice: req.tools?.length ? toolChoice(req.tool_choice) : undefined,
    };
    return postJson(
      this.name,
      `${this.opts.baseUrl}/messages`,
      body,
      { 'x-api-key': this.opts.apiKey, 'anthropic-version': API_VERSION },
      signal,
    );
  }
}

export function toAnthropicMessages(input: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];

  // Consecutive messages with the same role are merged, which is also how
  // several tool results end up in one user turn.
  const push = (role: AnthropicMessage['role'], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const msg of input) {
    switch (msg.role) {
      case 'system':
      case 'developer':
        system.push(textOf(msg.content));
        break;
      case 'user': {
        const text = textOf(msg.content);
        push('user', text ? [{ type: 'text', text }] : []);
        break;
      }
      case 'assistant': {
        const text = textOf(msg.content);
        const blocks: Block[] = text ? [{ type: 'text', text }] : [];
        for (const call of msg.tool_calls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseToolArguments(call.function.arguments),
          });
        }
        push('assistant', blocks);
        break;
      }
      case 'tool':
        push('user', [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: textOf(msg.content) }]);
        break;
    }
  }

  return { system: system.join('\n\n'), messages };
}

function toolChoice(choice: ChatRequest['tool_choice']) {
  if (choice === undefined || choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.function.name };
}

function toUsage(u: AnthropicUsage) {
  // Cached prompt tokens are reported separately but still count as input.
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return usage(input, u.output_tokens ?? 0);
}

function finishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

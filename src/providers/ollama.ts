// Ollama's native /api/chat. It streams newline-delimited JSON instead of SSE
// and returns tool arguments as objects, not JSON strings.
import { ProviderError } from '../errors.js';
import { textOf, usage, type ChatMessage, type ChatRequest, type FinishReason, type ToolCall } from '../openai.js';
import {
  maxTokens,
  newToolCallId,
  parseToolArguments,
  postJson,
  readJsonLines,
  requireBody,
  stopSequences,
  toolNamesById,
} from './http.js';
import type { CallOptions, CompletionResult, Provider, StreamPart } from './types.js';

export interface OllamaOptions {
  baseUrl: string;
  /** Sent as `think`. Turning it off makes thinking models answer much faster. */
  think?: boolean;
}

interface OllamaToolCall {
  id?: string;
  function: { name: string; arguments?: Record<string, unknown> };
}

interface OllamaChatResponse {
  message?: { role: string; content?: string; tool_calls?: OllamaToolCall[] };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly opts: OllamaOptions,
  ) {}

  async complete(req: ChatRequest, { model, signal }: CallOptions): Promise<CompletionResult> {
    const res = await this.post(req, model, false, signal);
    const data = (await res.json()) as OllamaChatResponse;
    if (data.error) throw new ProviderError(this.name, data.error, undefined, false);

    const toolCalls = (data.message?.tool_calls ?? []).map(toOpenAIToolCall);
    return {
      message: {
        role: 'assistant',
        content: data.message?.content || null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      },
      finishReason: finishReason(data.done_reason, toolCalls.length > 0),
      usage: usage(data.prompt_eval_count ?? 0, data.eval_count ?? 0),
    };
  }

  async stream(req: ChatRequest, { model, signal }: CallOptions): Promise<AsyncIterable<StreamPart>> {
    const res = await this.post(req, model, true, signal);
    return this.parseStream(requireBody(this.name, res));
  }

  private async *parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamPart> {
    let toolIndex = 0;
    let first = true;
    for await (const line of readJsonLines<OllamaChatResponse>(this.name, body)) {
      if (line.error) throw new ProviderError(this.name, line.error, undefined, false);

      const content = line.message?.content;
      const calls = line.message?.tool_calls ?? [];
      if (content || calls.length > 0 || first) {
        yield {
          type: 'delta',
          delta: {
            ...(first && { role: 'assistant' as const }),
            ...(content && { content }),
            ...(calls.length > 0 && {
              tool_calls: calls.map((call) => ({ index: toolIndex++, ...toOpenAIToolCall(call) })),
            }),
          },
        };
        first = false;
      }

      if (line.done) {
        yield { type: 'finish', reason: finishReason(line.done_reason, toolIndex > 0) };
        yield { type: 'usage', usage: usage(line.prompt_eval_count ?? 0, line.eval_count ?? 0) };
      }
    }
  }

  private post(req: ChatRequest, model: string, stream: boolean, signal: AbortSignal): Promise<Response> {
    // Ollama has no tool_choice. "none" is honoured by not sending tools,
    // "required" and named choices cannot be enforced and are ignored.
    const tools = req.tool_choice === 'none' ? undefined : req.tools;
    const body = {
      model,
      stream,
      messages: toOllamaMessages(req.messages),
      tools,
      think: this.opts.think,
      options: {
        temperature: req.temperature ?? undefined,
        top_p: req.top_p ?? undefined,
        num_predict: maxTokens(req),
        stop: stopSequences(req),
      },
    };
    return postJson(this.name, `${this.opts.baseUrl}/api/chat`, body, {}, signal);
  }
}

function toOllamaMessages(messages: ChatMessage[]) {
  const toolNames = toolNamesById(messages);
  return messages.map((msg) => {
    switch (msg.role) {
      case 'system':
      case 'developer':
        return { role: 'system', content: textOf(msg.content) };
      case 'user':
        return { role: 'user', content: textOf(msg.content) };
      case 'assistant':
        return {
          role: 'assistant',
          content: textOf(msg.content),
          tool_calls: msg.tool_calls?.map((call) => ({
            function: { name: call.function.name, arguments: parseToolArguments(call.function.arguments) },
          })),
        };
      case 'tool':
        return { role: 'tool', content: textOf(msg.content), tool_name: toolNames.get(msg.tool_call_id) };
    }
  });
}

function toOpenAIToolCall(call: OllamaToolCall): ToolCall {
  return {
    id: call.id ?? newToolCallId(),
    type: 'function',
    function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments ?? {}) },
  };
}

function finishReason(doneReason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return 'tool_calls';
  return doneReason === 'length' ? 'length' : 'stop';
}

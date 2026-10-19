// OpenAI Chat Completions, and anything else that speaks the same API
// (Groq, OpenRouter, vLLM, LM Studio) by pointing baseUrl somewhere else.
import { ProviderError } from '../errors.js';
import {
  usage,
  type ChatMessage,
  type ChatRequest,
  type ChunkDelta,
  type FinishReason,
  type ToolCall,
  type ToolCallDelta,
} from '../openai.js';
import { maxTokens, parseJson, postJson, readSse, requireBody } from './http.js';
import type { CallOptions, CompletionResult, Provider, StreamPart } from './types.js';

export interface OpenAIOptions {
  baseUrl: string;
  apiKey: string;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface OpenAIResponse {
  choices?: {
    message: { content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIUsage;
}

interface OpenAIChunk {
  choices?: {
    delta?: { role?: string; content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIUsage | null;
  error?: { message?: string };
}

export class OpenAIProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly opts: OpenAIOptions,
  ) {}

  async complete(req: ChatRequest, { model, signal }: CallOptions): Promise<CompletionResult> {
    const res = await this.post(req, model, false, signal);
    const data = (await res.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    if (!choice) throw new ProviderError(this.name, 'response had no choices', res.status, false);

    const toolCalls = choice.message.tool_calls;
    return {
      message: {
        role: 'assistant',
        content: choice.message.content ?? null,
        ...(toolCalls && toolCalls.length > 0 && { tool_calls: toolCalls }),
      },
      finishReason: finishReason(choice.finish_reason),
      usage: usage(data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0),
    };
  }

  async stream(req: ChatRequest, { model, signal }: CallOptions): Promise<AsyncIterable<StreamPart>> {
    const res = await this.post(req, model, true, signal);
    return this.parseStream(requireBody(this.name, res));
  }

  private async *parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamPart> {
    for await (const event of readSse(body)) {
      if (event.data === '[DONE]') return;
      const chunk = parseJson<OpenAIChunk>(this.name, event.data);
      if (chunk.error) throw new ProviderError(this.name, chunk.error.message ?? 'stream error', undefined, false);

      const choice = chunk.choices?.[0];
      if (choice?.delta) {
        const delta: ChunkDelta = {};
        if (choice.delta.role === 'assistant') delta.role = 'assistant';
        if (choice.delta.content) delta.content = choice.delta.content;
        if (choice.delta.tool_calls?.length) delta.tool_calls = choice.delta.tool_calls;
        if (Object.keys(delta).length > 0) yield { type: 'delta', delta };
      }
      if (choice?.finish_reason) yield { type: 'finish', reason: finishReason(choice.finish_reason) };
      if (chunk.usage) {
        yield { type: 'usage', usage: usage(chunk.usage.prompt_tokens ?? 0, chunk.usage.completion_tokens ?? 0) };
      }
    }
  }

  private post(req: ChatRequest, model: string, stream: boolean, signal: AbortSignal): Promise<Response> {
    const body = {
      model,
      messages: req.messages.map(stripExtras),
      stream,
      // Without this the stream carries no token counts at all.
      ...(stream && { stream_options: { include_usage: true } }),
      temperature: req.temperature ?? undefined,
      top_p: req.top_p ?? undefined,
      // Newer OpenAI models reject max_tokens.
      max_completion_tokens: maxTokens(req),
      stop: req.stop ?? undefined,
      tools: req.tools,
      tool_choice: req.tool_choice,
    };
    return postJson(
      this.name,
      `${this.opts.baseUrl}/chat/completions`,
      body,
      {
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      signal,
    );
  }
}

// extra_content belongs to Gemini, OpenAI rejects unknown message fields.
function stripExtras(msg: ChatMessage): ChatMessage {
  if (msg.role !== 'assistant' || !msg.tool_calls) return msg;
  return {
    ...msg,
    tool_calls: msg.tool_calls.map(({ id, type, function: fn }) => ({ id, type, function: fn })),
  };
}

function finishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

// Gemini generateContent / streamGenerateContent. Roles are "user" and
// "model", messages are lists of parts, and tool calls are functionCall parts.
import { InvalidRequestError, ProviderError } from '../errors.js';
import { textOf, usage, type ChatMessage, type ChatRequest, type FinishReason, type ToolCall } from '../openai.js';
import {
  maxTokens,
  newToolCallId,
  parseJson,
  parseToolArguments,
  postJson,
  readSse,
  requireBody,
  stopSequences,
  toolNamesById,
} from './http.js';
import type { CallOptions, CompletionResult, Provider, StreamPart } from './types.js';

export interface GeminiOptions {
  baseUrl: string;
  apiKey: string;
}

// Gemini 3 models reject replayed function calls without a thought signature.
// When the client did not keep the real one (most OpenAI clients drop unknown
// fields), Google documents this value as the escape hatch.
export const SKIP_SIGNATURE = 'skip_thought_signature_validator';

interface FunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: FunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: UsageMetadata;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; code?: number };
}

export class GeminiProvider implements Provider {
  constructor(
    readonly name: string,
    private readonly opts: GeminiOptions,
  ) {}

  async complete(req: ChatRequest, { model, signal }: CallOptions): Promise<CompletionResult> {
    const res = await this.post(req, model, false, signal);
    const data = (await res.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const text = parts
      .filter((part) => part.text && !part.thought)
      .map((part) => part.text)
      .join('');
    const toolCalls = parts.flatMap((part) =>
      part.functionCall ? [toOpenAIToolCall(part.functionCall, part.thoughtSignature)] : [],
    );

    let reason = finishReason(candidate?.finishReason, toolCalls.length > 0);
    if (!candidate && data.promptFeedback?.blockReason) reason = 'content_filter';

    return {
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      },
      finishReason: reason,
      usage: toUsage(data.usageMetadata),
    };
  }

  async stream(req: ChatRequest, { model, signal }: CallOptions): Promise<AsyncIterable<StreamPart>> {
    const res = await this.post(req, model, true, signal);
    return this.parseStream(requireBody(this.name, res));
  }

  private async *parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamPart> {
    let first = true;
    let toolIndex = 0;
    let rawFinish: string | undefined;
    let blocked = false;
    let meta: UsageMetadata | undefined;

    for await (const { data } of readSse(body)) {
      const chunk = parseJson<GeminiResponse>(this.name, data);
      if (chunk.error) {
        throw new ProviderError(this.name, chunk.error.message ?? 'stream error', chunk.error.code, false);
      }
      // usageMetadata is cumulative, the last one wins.
      meta = chunk.usageMetadata ?? meta;
      if (chunk.promptFeedback?.blockReason) blocked = true;

      const candidate = chunk.candidates?.[0];
      rawFinish = candidate?.finishReason ?? rawFinish;

      for (const part of candidate?.content?.parts ?? []) {
        const role = first ? { role: 'assistant' as const } : {};
        if (part.functionCall) {
          yield {
            type: 'delta',
            delta: {
              ...role,
              tool_calls: [{ index: toolIndex++, ...toOpenAIToolCall(part.functionCall, part.thoughtSignature) }],
            },
          };
          first = false;
        } else if (part.text && !part.thought) {
          yield { type: 'delta', delta: { ...role, content: part.text } };
          first = false;
        }
      }
    }

    if (rawFinish || blocked) {
      yield {
        type: 'finish',
        reason: blocked && !rawFinish ? 'content_filter' : finishReason(rawFinish, toolIndex > 0),
      };
      yield { type: 'usage', usage: toUsage(meta) };
    }
  }

  private post(req: ChatRequest, model: string, stream: boolean, signal: AbortSignal): Promise<Response> {
    const { system, contents } = toGeminiContents(req.messages);
    const hasTools = req.tools !== undefined && req.tools.length > 0;
    const body = {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      tools: hasTools
        ? [
            {
              functionDeclarations: req.tools?.map((tool) => ({
                name: tool.function.name,
                description: tool.function.description,
                // parametersJsonSchema takes plain JSON Schema, the older
                // `parameters` field only accepts an OpenAPI subset.
                parametersJsonSchema: tool.function.parameters,
              })),
            },
          ]
        : undefined,
      toolConfig: hasTools && req.tool_choice ? { functionCallingConfig: toolConfig(req.tool_choice) } : undefined,
      generationConfig: {
        temperature: req.temperature ?? undefined,
        topP: req.top_p ?? undefined,
        maxOutputTokens: maxTokens(req),
        stopSequences: stopSequences(req),
      },
    };
    const url = stream
      ? `${this.opts.baseUrl}/models/${model}:streamGenerateContent?alt=sse`
      : `${this.opts.baseUrl}/models/${model}:generateContent`;
    return postJson(this.name, url, body, { 'x-goog-api-key': this.opts.apiKey }, signal);
  }
}

export function toGeminiContents(input: ChatMessage[]): { system: string; contents: GeminiContent[] } {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  const toolNames = toolNamesById(input);

  // Parallel function responses have to arrive together in one user turn.
  const push = (role: GeminiContent['role'], parts: GeminiPart[]) => {
    if (parts.length === 0) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const msg of input) {
    switch (msg.role) {
      case 'system':
      case 'developer':
        system.push(textOf(msg.content));
        break;
      case 'user': {
        const text = textOf(msg.content);
        push('user', text ? [{ text }] : []);
        break;
      }
      case 'assistant': {
        const text = textOf(msg.content);
        const parts: GeminiPart[] = text ? [{ text }] : [];
        parts.push(...functionCallParts(msg.tool_calls ?? []));
        push('model', parts);
        break;
      }
      case 'tool': {
        const name = toolNames.get(msg.tool_call_id);
        if (!name) throw new InvalidRequestError(`tool message refers to unknown tool_call_id ${msg.tool_call_id}`);
        push('user', [{ functionResponse: { name, response: toResponseObject(textOf(msg.content)) } }]);
        break;
      }
    }
  }

  return { system: system.join('\n\n'), contents };
}

function functionCallParts(calls: ToolCall[]): GeminiPart[] {
  // With parallel calls Gemini only signs the first part, so the placeholder
  // goes on the first call only, and only when nothing was signed at all.
  const anySigned = calls.some((call) => call.extra_content?.google?.thought_signature);
  return calls.map((call, i) => {
    const signature =
      call.extra_content?.google?.thought_signature ?? (!anySigned && i === 0 ? SKIP_SIGNATURE : undefined);
    return {
      functionCall: { name: call.function.name, args: parseToolArguments(call.function.arguments) },
      ...(signature && { thoughtSignature: signature }),
    };
  });
}

// functionResponse.response must be an object. Tools usually return JSON,
// anything else is wrapped.
function toResponseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // plain text result
  }
  return { result: text };
}

function toOpenAIToolCall(call: FunctionCall, signature: string | undefined): ToolCall {
  return {
    id: call.id ?? newToolCallId(),
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    ...(signature && { extra_content: { google: { thought_signature: signature } } }),
  };
}

function toolConfig(choice: NonNullable<ChatRequest['tool_choice']>) {
  if (choice === 'auto') return { mode: 'AUTO' };
  if (choice === 'none') return { mode: 'NONE' };
  if (choice === 'required') return { mode: 'ANY' };
  return { mode: 'ANY', allowedFunctionNames: [choice.function.name] };
}

function toUsage(meta: UsageMetadata | undefined) {
  // Thinking tokens are billed as output.
  const output = (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
  return usage(meta?.promptTokenCount ?? 0, output);
}

function finishReason(reason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'stop';
  }
}

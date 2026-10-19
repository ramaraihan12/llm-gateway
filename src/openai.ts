// The gateway speaks the OpenAI Chat Completions format on both sides of the
// router. Provider adapters translate from and to these shapes.
import { z } from 'zod';

const textPart = z.object({ type: z.literal('text'), text: z.string() });

// Only text content is supported for now. Image parts are rejected by the
// schema instead of being silently dropped.
const content = z.union([z.string(), z.array(textPart)]);

const toolCall = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
  // Gemini's own OpenAI layer uses this field to carry thought signatures.
  extra_content: z.object({ google: z.object({ thought_signature: z.string().optional() }).optional() }).optional(),
});

const message = z.discriminatedUnion('role', [
  z.object({ role: z.enum(['system', 'developer']), content }),
  z.object({ role: z.literal('user'), content }),
  z.object({
    role: z.literal('assistant'),
    content: content.nullish(),
    tool_calls: z.array(toolCall).optional(),
  }),
  z.object({ role: z.literal('tool'), tool_call_id: z.string(), content }),
]);

const tool = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

const toolChoice = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
]);

export const chatRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  max_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  stop: z.union([z.string(), z.array(z.string())]).nullish(),
  tools: z.array(tool).optional(),
  tool_choice: toolChoice.optional(),
  n: z.literal(1, { error: 'only n=1 is supported' }).nullish(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatMessage = ChatRequest['messages'][number];
export type MessageContent = z.infer<typeof content>;
export type ToolCall = z.infer<typeof toolCall>;
export type ToolChoice = z.infer<typeof toolChoice>;

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: { index: number; message: AssistantMessage; finish_reason: FinishReason }[];
  usage: Usage;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
  extra_content?: ToolCall['extra_content'];
}

export interface ChunkDelta {
  role?: 'assistant';
  content?: string;
  tool_calls?: ToolCallDelta[];
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: { index: number; delta: ChunkDelta; finish_reason: FinishReason | null }[];
  usage?: Usage | null;
}

export function textOf(value: MessageContent | null | undefined): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return value.map((part) => part.text).join('');
}

export function usage(prompt: number, completion: number): Usage {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

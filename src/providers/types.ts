import type { AssistantMessage, ChatRequest, ChunkDelta, FinishReason, Usage } from '../openai.js';

export interface CompletionResult {
  message: AssistantMessage;
  finishReason: FinishReason;
  usage: Usage;
}

/** Provider-neutral stream events. The chat route turns them into OpenAI chunks. */
export type StreamPart =
  { type: 'delta'; delta: ChunkDelta } | { type: 'finish'; reason: FinishReason } | { type: 'usage'; usage: Usage };

export interface CallOptions {
  model: string;
  signal: AbortSignal;
}

export interface Provider {
  readonly name: string;
  complete(req: ChatRequest, opts: CallOptions): Promise<CompletionResult>;
  /**
   * Resolves once the upstream answered with a 2xx status. Connection and
   * HTTP errors therefore reject here, before anything reaches the client.
   */
  stream(req: ChatRequest, opts: CallOptions): Promise<AsyncIterable<StreamPart>>;
}

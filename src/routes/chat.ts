import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { apiError } from '../api-error.js';
import { cacheKey } from '../cache.js';
import { splitRef } from '../config.js';
import type { AppDeps, GatewayEnv } from '../deps.js';
import { InvalidRequestError } from '../errors.js';
import {
  chatRequestSchema,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChunkDelta,
  type FinishReason,
  type Usage,
} from '../openai.js';
import { estimateCost } from '../pricing.js';
import type { CompletionResult, StreamPart } from '../providers/types.js';
import type { Target } from '../registry.js';
import { AllProvidersFailedError, callWithFallback } from '../router.js';
import type { UsageEntry } from '../store.js';

type UsageFields = Omit<UsageEntry, 'apiKeyId' | 'requestedModel' | 'stream' | 'latencyMs'>;

export function chatCompletions(deps: AppDeps) {
  const { registry, store, cache, retry, pricing, log } = deps;

  return async (c: Context<GatewayEnv>) => {
    const startedAt = performance.now();
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(c, 400, z.prettifyError(parsed.error), 'invalid_request_error');
    }
    const req = parsed.data;

    const chain = registry.resolve(req.model);
    if (!chain) {
      return apiError(
        c,
        404,
        `model "${req.model}" does not exist, GET /v1/models lists the aliases`,
        'invalid_request_error',
        'model_not_found',
      );
    }
    if (chain.length === 0) {
      return apiError(c, 503, `no provider behind "${req.model}" has credentials configured`, 'upstream_error');
    }

    const apiKey = c.get('apiKey');
    const record = (fields: UsageFields) => {
      const entry: UsageEntry = {
        apiKeyId: apiKey.id,
        requestedModel: req.model,
        stream: req.stream === true,
        latencyMs: Math.round(performance.now() - startedAt),
        ...fields,
      };
      // Logging usage must never fail or slow down the response.
      store.recordUsage(entry).catch((err: unknown) => log.error({ err }, 'could not record usage'));
    };
    const recordFailure = (err: unknown) => {
      if (err instanceof InvalidRequestError) return;
      record({
        provider: null,
        model: null,
        status: 'error',
        cached: false,
        attempts: err instanceof AllProvidersFailedError ? err.attempts : 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: null,
        error: err instanceof Error ? err.message : String(err),
      });
    };
    const fallbackOptions = { retry, signal: c.req.raw.signal, log };

    if (req.stream) {
      let connected;
      try {
        // Pull the first event before answering. Until then nothing has been
        // sent, so a failing provider can still fall back to the next one.
        connected = await callWithFallback(
          chain,
          async (target, deadline) => {
            const parts = await target.provider.stream(req, { model: target.model, signal: deadline.signal });
            const iterator = parts[Symbol.asyncIterator]();
            return { iterator, first: await iterator.next() };
          },
          fallbackOptions,
        );
      } catch (err) {
        recordFailure(err);
        throw err;
      }

      const { value, target, attempts, deadline } = connected;
      c.header('x-gateway-provider', target.ref);
      c.header('x-gateway-attempts', String(attempts));

      return streamSSE(c, async (stream) => {
        stream.onAbort(() => deadline.abort(new Error('client closed the connection')));

        const id = completionId();
        const created = nowSeconds();
        const chunk = (delta: ChunkDelta, finishReason: FinishReason | null): ChatCompletionChunk => ({
          id,
          object: 'chat.completion.chunk',
          created,
          model: target.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        const send = (data: object) => stream.writeSSE({ data: JSON.stringify(data) });

        let usage: Usage | undefined;
        let finish: FinishReason | undefined;
        let failure: string | undefined;
        try {
          for (let next = value.first; !next.done; next = await value.iterator.next()) {
            deadline.touch();
            const part: StreamPart = next.value;
            if (part.type === 'delta') await send(chunk(part.delta, null));
            else if (part.type === 'finish') {
              finish = part.reason;
              await send(chunk({}, part.reason));
            } else usage = part.usage;
          }
          if (!finish) throw new Error('upstream stream ended before it finished');

          if (req.stream_options?.include_usage && usage) {
            await send({ id, object: 'chat.completion.chunk', created, model: target.model, choices: [], usage });
          }
          await stream.writeSSE({ data: '[DONE]' });
        } catch (err) {
          failure = deadline.timedOut
            ? `no data from upstream for ${target.timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : String(err);
          log.warn({ target: target.ref, err: failure }, 'stream failed after it started');
          await value.iterator.return?.();
          if (!stream.aborted) await send({ error: { message: failure, type: 'upstream_error' } });
        } finally {
          deadline.clear();
          record({
            ...servedBy(target, usage, pricing),
            status: failure ? 'error' : 'ok',
            cached: false,
            attempts,
            error: failure ?? null,
          });
        }
      });
    }

    const key = cache ? cacheKey(apiKey.id, req) : undefined;
    const hit = key ? cache?.get(key) : undefined;
    if (hit) {
      record({
        provider: splitRef(hit.ref).provider,
        model: hit.completion.model,
        status: 'ok',
        cached: true,
        attempts: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        error: null,
      });
      c.header('x-gateway-cache', 'hit');
      c.header('x-gateway-provider', hit.ref);
      return c.json({ ...hit.completion, id: completionId(), created: nowSeconds() });
    }

    let result;
    try {
      result = await callWithFallback(
        chain,
        (target, deadline) => target.provider.complete(req, { model: target.model, signal: deadline.signal }),
        fallbackOptions,
      );
    } catch (err) {
      recordFailure(err);
      throw err;
    }
    result.deadline.clear();

    const { target, attempts } = result;
    const completion = toCompletion(result.value, target);
    if (key) cache?.set(key, { ref: target.ref, completion });

    record({ ...servedBy(target, completion.usage, pricing), status: 'ok', cached: false, attempts, error: null });
    c.header('x-gateway-provider', target.ref);
    c.header('x-gateway-attempts', String(attempts));
    if (cache) c.header('x-gateway-cache', 'miss');
    return c.json(completion);
  };
}

function toCompletion(result: CompletionResult, target: Target): ChatCompletion {
  return {
    id: completionId(),
    object: 'chat.completion',
    created: nowSeconds(),
    model: target.model,
    choices: [{ index: 0, message: result.message, finish_reason: result.finishReason }],
    usage: result.usage,
  };
}

function servedBy(target: Target, usage: Usage | undefined, pricing: AppDeps['pricing']) {
  return {
    provider: target.provider.name,
    model: target.model,
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    costUsd: usage ? estimateCost(pricing, target.ref, usage) : null,
  };
}

function completionId(): string {
  return `chatcmpl-${randomBytes(12).toString('base64url')}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

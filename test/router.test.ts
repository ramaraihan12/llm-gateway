import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { InvalidRequestError, ProviderError } from '../src/errors.js';
import { usage } from '../src/openai.js';
import type { CompletionResult, Provider } from '../src/providers/types.js';
import type { Target } from '../src/registry.js';
import { AllProvidersFailedError, backoffDelay, callWithFallback } from '../src/router.js';

const log = pino({ level: 'silent' });
const retry = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 20 };
const ok: CompletionResult = {
  message: { role: 'assistant', content: 'ok' },
  finishReason: 'stop',
  usage: usage(1, 1),
};

/** A provider whose complete() runs the given steps in order, one per call. */
function fakeTarget(name: string, steps: (() => Promise<CompletionResult>)[], timeoutMs = 1000) {
  let call = 0;
  const complete = vi.fn((_req: unknown, opts: { signal: AbortSignal }) => {
    const step = steps[Math.min(call++, steps.length - 1)];
    if (!step) throw new Error('no steps');
    return Promise.race([
      step(),
      new Promise<never>((_, reject) =>
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason as Error)),
      ),
    ]);
  });
  const provider = { name, complete, stream: vi.fn() } as unknown as Provider;
  const target: Target = { ref: `${name}/model`, provider, model: 'model', timeoutMs };
  return { target, complete };
}

const fail = (status: number | undefined, retryable: boolean, retryAfterMs?: number) => () =>
  Promise.reject(new ProviderError('p', `failed with ${status}`, status, retryable, retryAfterMs));
const succeed = () => Promise.resolve(ok);
const hang = () => new Promise<CompletionResult>(() => {});

function run(chain: Target[], signal = new AbortController().signal) {
  return callWithFallback(
    chain,
    (target, deadline) =>
      target.provider.complete({ model: 'x', messages: [] }, { model: target.model, signal: deadline.signal }),
    { retry, signal, log },
  ).then((result) => {
    result.deadline.clear();
    return result;
  });
}

describe('backoffDelay', () => {
  const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };

  it('grows exponentially and stays under the cap', () => {
    const max = () => 0.9999;
    expect(backoffDelay(1, policy, max)).toBe(99);
    expect(backoffDelay(2, policy, max)).toBe(199);
    expect(backoffDelay(3, policy, max)).toBe(399);
    expect(backoffDelay(6, policy, max)).toBe(999);
  });

  it('uses full jitter, so the delay can be anywhere from zero up', () => {
    expect(backoffDelay(4, policy, () => 0)).toBe(0);
    expect(backoffDelay(4, policy, () => 0.5)).toBe(400);
  });
});

describe('callWithFallback', () => {
  it('retries a 503 on the same provider', async () => {
    const primary = fakeTarget('primary', [fail(503, true), succeed]);

    const result = await run([primary.target]);

    expect(result.attempts).toBe(2);
    expect(result.target.ref).toBe('primary/model');
    expect(primary.complete).toHaveBeenCalledTimes(2);
  });

  it('falls back right away on a non-retryable error', async () => {
    const primary = fakeTarget('primary', [fail(401, false)]);
    const backup = fakeTarget('backup', [succeed]);

    const result = await run([primary.target, backup.target]);

    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(result.target.ref).toBe('backup/model');
    expect(result.attempts).toBe(2);
  });

  it('falls back after retries run out', async () => {
    const primary = fakeTarget('primary', [fail(429, true)]);
    const backup = fakeTarget('backup', [succeed]);

    const result = await run([primary.target, backup.target]);

    expect(primary.complete).toHaveBeenCalledTimes(3);
    expect(result.attempts).toBe(4);
  });

  it('does not sit out a Retry-After longer than the backoff cap', async () => {
    const primary = fakeTarget('primary', [fail(429, true, 60_000)]);
    const backup = fakeTarget('backup', [succeed]);

    await run([primary.target, backup.target]);

    expect(primary.complete).toHaveBeenCalledTimes(1);
  });

  it('moves on to the next provider after a timeout instead of waiting again', async () => {
    const slow = fakeTarget('slow', [hang, succeed], 20);
    const backup = fakeTarget('backup', [succeed]);

    const result = await run([slow.target, backup.target]);

    expect(slow.complete).toHaveBeenCalledTimes(1);
    expect(result.target.ref).toBe('backup/model');
    expect(result.attempts).toBe(2);
  });

  it('reports every failure when the whole chain is down', async () => {
    const a = fakeTarget('a', [fail(500, true)]);
    const b = fakeTarget('b', [fail(400, false)]);

    const error = await run([a.target, b.target]).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AllProvidersFailedError);
    expect((error as AllProvidersFailedError).attempts).toBe(4);
    expect((error as AllProvidersFailedError).message).toBe(
      'all providers failed: a/model: failed with 500; b/model: failed with 400',
    );
  });

  it('stops on an invalid request instead of trying the next provider', async () => {
    const a = fakeTarget('a', [() => Promise.reject(new InvalidRequestError('bad tool arguments'))]);
    const b = fakeTarget('b', [succeed]);

    await expect(run([a.target, b.target])).rejects.toBeInstanceOf(InvalidRequestError);
    expect(b.complete).not.toHaveBeenCalled();
  });

  it('gives up when the client disconnects', async () => {
    const client = new AbortController();
    const a = fakeTarget('a', [hang]);
    const b = fakeTarget('b', [succeed]);

    const pending = run([a.target, b.target], client.signal);
    client.abort(new Error('client went away'));

    await expect(pending).rejects.toThrow('client went away');
    expect(b.complete).not.toHaveBeenCalled();
  });
});

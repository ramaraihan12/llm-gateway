import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { RetryPolicy } from './config.js';
import { InvalidRequestError, ProviderError } from './errors.js';
import type { Target } from './registry.js';

export class AllProvidersFailedError extends Error {
  constructor(
    readonly failures: { ref: string; error: ProviderError }[],
    readonly attempts: number,
  ) {
    super(
      failures.length === 0
        ? 'no provider is configured for this model'
        : `all providers failed: ${failures.map((f) => `${f.ref}: ${f.error.message}`).join('; ')}`,
    );
    this.name = 'AllProvidersFailedError';
  }

  /**
   * What the client gets back. Upstream messages can say things like "invalid
   * x-api-key", which is the gateway's business, so they stay in the log and
   * in usage_logs.error.
   */
  get publicMessage(): string {
    if (this.failures.length === 0) return this.message;
    const tried = this.failures.map((f) => `${f.ref} (${f.error.status ?? 'no response'})`);
    return `all providers failed: ${tried.join(', ')}`;
  }
}

/**
 * Per-attempt timeout that can be pushed back. Plain requests use it as a
 * total timeout, streams call touch() on every chunk so it becomes an idle
 * timeout and long answers are not cut off.
 */
export class Deadline {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private readonly onParentAbort = () => this.controller.abort(this.parent.reason);
  timedOut = false;

  constructor(
    private readonly ms: number,
    private readonly parent: AbortSignal,
  ) {
    if (parent.aborted) this.controller.abort(parent.reason);
    else parent.addEventListener('abort', this.onParentAbort, { once: true });
    this.touch();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort(new Error(`timed out after ${this.ms}ms`));
    }, this.ms);
  }

  clear(): void {
    clearTimeout(this.timer);
    this.parent.removeEventListener('abort', this.onParentAbort);
  }

  abort(reason: unknown): void {
    this.controller.abort(reason);
  }
}

/** Exponential backoff with full jitter: a random delay between 0 and the capped exponential step. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export interface FallbackOptions {
  retry: RetryPolicy;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
  log: Logger;
}

export interface FallbackResult<T> {
  value: T;
  target: Target;
  /** Upstream calls made in total, across retries and fallbacks. */
  attempts: number;
  /** Still running. The caller clears it when done (streams keep using it). */
  deadline: Deadline;
}

/**
 * Tries each target in order. Transient failures (429, 5xx, network) are
 * retried on the same target with backoff, anything else moves straight to
 * the next target.
 */
export async function callWithFallback<T>(
  chain: Target[],
  call: (target: Target, deadline: Deadline) => Promise<T>,
  { retry, signal, log }: FallbackOptions,
): Promise<FallbackResult<T>> {
  const failures: { ref: string; error: ProviderError }[] = [];
  let attempts = 0;

  for (const target of chain) {
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      attempts++;
      const deadline = new Deadline(target.timeoutMs, signal);
      try {
        const value = await call(target, deadline);
        return { value, target, attempts, deadline };
      } catch (err) {
        deadline.clear();
        if (signal.aborted || err instanceof InvalidRequestError) throw err;

        const error = toProviderError(err, target, deadline);
        log.warn({ target: target.ref, attempt, status: error.status, err: error.message }, 'provider call failed');

        const waitHint = error.retryAfterMs ?? 0;
        // A long Retry-After is better spent on the next provider than waiting.
        const retryHere = error.retryable && attempt < retry.maxAttempts && waitHint <= retry.maxDelayMs;
        if (!retryHere) {
          failures.push({ ref: target.ref, error });
          break;
        }
        await sleep(Math.max(backoffDelay(attempt, retry), waitHint), undefined, { signal });
      }
    }
  }

  throw new AllProvidersFailedError(failures, attempts);
}

function toProviderError(err: unknown, target: Target, deadline: Deadline): ProviderError {
  // A provider that hung for the whole timeout will most likely hang again,
  // and three tries would cost three full timeouts before any fallback.
  if (deadline.timedOut) {
    return new ProviderError(target.provider.name, `timed out after ${target.timeoutMs}ms`, undefined, false);
  }
  if (err instanceof ProviderError) return err;
  // Anything else is a bug or a response shape we did not expect. Retrying
  // the same provider would hit it again, the next one might not.
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError(target.provider.name, message, undefined, false);
}

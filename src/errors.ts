/** A provider call failed. `retryable` decides whether the same provider gets another try. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** The request itself is unusable, so trying another provider would not help. */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export async function errorFromResponse(provider: string, res: Response): Promise<ProviderError> {
  const body = await res.text().catch(() => '');
  const detail = extractMessage(body) ?? res.statusText;
  return new ProviderError(
    provider,
    `${res.status} ${detail}`.trim(),
    res.status,
    isRetryableStatus(res.status),
    parseRetryAfter(res.headers.get('retry-after')),
  );
}

// OpenAI, Anthropic and Gemini nest the message under error.message, Ollama
// sends error as a plain string.
function extractMessage(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string } };
    const err = parsed.error;
    if (typeof err === 'string') return truncate(err);
    if (err?.message) return truncate(err.message);
  } catch {
    // not JSON, fall through to the raw body
  }
  return truncate(body);
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

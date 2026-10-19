import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorType =
  'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'upstream_error' | 'server_error';

/** Errors use the OpenAI shape so existing client libraries can read them. */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  type: ErrorType,
  code: string | null = null,
  param: string | null = null,
) {
  return c.json({ error: { message, type, param, code } }, status);
}

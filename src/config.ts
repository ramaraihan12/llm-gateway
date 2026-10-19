import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const timeoutMs = z.number().int().positive().default(60_000);
const baseUrl = (fallback: string) =>
  z
    .url()
    .transform((url) => url.replace(/\/+$/, ''))
    .default(fallback);

const providerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ollama'),
    baseUrl: baseUrl('http://localhost:11434'),
    think: z.boolean().optional(),
    timeoutMs,
  }),
  z.object({
    type: z.literal('openai'),
    baseUrl: baseUrl('https://api.openai.com/v1'),
    apiKey: z.string().default(''),
    timeoutMs,
  }),
  z.object({
    type: z.literal('anthropic'),
    baseUrl: baseUrl('https://api.anthropic.com/v1'),
    apiKey: z.string().default(''),
    timeoutMs,
  }),
  z.object({
    type: z.literal('gemini'),
    baseUrl: baseUrl('https://generativelanguage.googleapis.com/v1beta'),
    apiKey: z.string().default(''),
    timeoutMs,
  }),
]);

// The model part can have its own slashes (hf.co/org/repo:Q4_K_M on Ollama),
// but no dot segments, query strings or whitespace. Clients can send a direct
// ref, and the Gemini adapter puts the model name into the upstream URL.
const REF_PATTERN = /^[\w.-]+(?:\/[\w.:@-]+)+$/;

export function isModelRef(value: string): boolean {
  return REF_PATTERN.test(value) && !value.split('/').some((segment) => segment === '.' || segment === '..');
}

const modelRef = z.string().refine(isModelRef, 'expected "provider/model"');

const configSchema = z
  .object({
    providers: z.record(z.string(), providerSchema),
    aliases: z.record(z.string(), z.array(modelRef).min(1)),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(10).default(3),
        baseDelayMs: z.number().int().min(0).default(250),
        maxDelayMs: z.number().int().min(0).default(4000),
      })
      .prefault({}),
    cache: z
      .object({
        enabled: z.boolean().default(false),
        ttlSeconds: z.number().int().positive().default(300),
        maxEntries: z.number().int().positive().default(1000),
      })
      .prefault({}),
    // USD per million tokens, keyed by "provider/model".
    pricing: z.record(modelRef, z.object({ input: z.number().min(0), output: z.number().min(0) })).default({}),
  })
  .superRefine((config, ctx) => {
    for (const [alias, refs] of Object.entries(config.aliases)) {
      for (const ref of refs) {
        const provider = splitRef(ref).provider;
        if (!(provider in config.providers)) {
          ctx.addIssue({
            code: 'custom',
            path: ['aliases', alias],
            message: `unknown provider "${provider}" in ${ref}`,
          });
        }
      }
    }
  });

export type GatewayConfig = z.infer<typeof configSchema>;
export type ProviderConfig = GatewayConfig['providers'][string];
export type RetryPolicy = GatewayConfig['retry'];

export function splitRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf('/');
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<GatewayConfig> {
  const raw: unknown = parse(await readFile(path, 'utf8'));
  return parseConfig(interpolate(raw, env));
}

export function parseConfig(raw: unknown): GatewayConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`invalid gateway config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Replaces ${VAR} and ${VAR:-default} in every string value of the parsed YAML. */
export function interpolate(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
      const found = env[name];
      return found !== undefined && found !== '' ? found : (fallback ?? '');
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
  }
  return value;
}

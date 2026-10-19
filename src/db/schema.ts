import { bigserial, boolean, index, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // sha256 of the key. Keys are 32 random bytes, so a slow password hash buys nothing.
  keyHash: text('key_hash').notNull().unique(),
  // First few characters, so a key can be recognised in logs without storing it.
  keyPrefix: text('key_prefix').notNull(),
  rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(60),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const usageLogs = pgTable(
  'usage_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id),
    requestedModel: text('requested_model').notNull(),
    // Null when every provider in the chain failed.
    provider: text('provider'),
    model: text('model'),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    stream: boolean('stream').notNull(),
    cached: boolean('cached').notNull().default(false),
    attempts: integer('attempts').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull(),
    // Null when there is no price for the model in the config.
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('usage_logs_created_at_idx').on(t.createdAt), index('usage_logs_api_key_idx').on(t.apiKeyId)],
);

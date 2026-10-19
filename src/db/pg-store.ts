import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  sumTotals,
  type ApiKeyRecord,
  type KeySummary,
  type NewApiKey,
  type Store,
  type UsageEntry,
  type UsageSummary,
} from '../store.js';
import { apiKeys, usageLogs } from './schema.js';

export function connect(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 10, onnotice: () => {} });
  return { db: drizzle({ client }), close: () => client.end({ timeout: 5 }) };
}

export type Database = ReturnType<typeof connect>['db'];

const keyColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  rateLimitPerMinute: apiKeys.rateLimitPerMinute,
};

const summaryColumns = {
  prefix: apiKeys.keyPrefix,
  name: apiKeys.name,
  rateLimitPerMinute: apiKeys.rateLimitPerMinute,
  createdAt: apiKeys.createdAt,
  revokedAt: apiKeys.revokedAt,
};

const totals = {
  requests: sql<number>`count(*)`.mapWith(Number),
  errors: sql<number>`count(*) filter (where ${usageLogs.status} = 'error')`.mapWith(Number),
  cacheHits: sql<number>`count(*) filter (where ${usageLogs.cached})`.mapWith(Number),
  promptTokens: sql<number>`coalesce(sum(${usageLogs.promptTokens}), 0)`.mapWith(Number),
  completionTokens: sql<number>`coalesce(sum(${usageLogs.completionTokens}), 0)`.mapWith(Number),
  costUsd: sql<number>`coalesce(sum(${usageLogs.costUsd}), 0)`.mapWith(Number),
};

export class PgStore implements Store {
  constructor(private readonly db: Database) {}

  async findActiveKey(keyHash: string): Promise<ApiKeyRecord | undefined> {
    const [row] = await this.db
      .select(keyColumns)
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
      .limit(1);
    return row;
  }

  async createKey(key: NewApiKey): Promise<ApiKeyRecord> {
    const [row] = await this.db.insert(apiKeys).values(key).returning(keyColumns);
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async listKeys(): Promise<KeySummary[]> {
    return this.db.select(summaryColumns).from(apiKeys).orderBy(apiKeys.createdAt);
  }

  /**
   * Revokes the active key with this prefix. Two keys sharing a prefix is very
   * unlikely, but if it happens nothing is revoked rather than both.
   */
  async revokeKey(prefix: string): Promise<KeySummary> {
    return this.db.transaction(async (tx) => {
      const active = and(eq(apiKeys.keyPrefix, prefix), isNull(apiKeys.revokedAt));
      const matches = await tx.select({ id: apiKeys.id }).from(apiKeys).where(active);
      if (matches.length === 0) throw new Error(`no active key with prefix ${prefix}`);
      if (matches.length > 1) throw new Error(`${matches.length} active keys share prefix ${prefix}, nothing revoked`);

      const [row] = await tx.update(apiKeys).set({ revokedAt: new Date() }).where(active).returning(summaryColumns);
      if (!row) throw new Error('update returned no row');
      return row;
    });
  }

  async recordUsage(entry: UsageEntry): Promise<void> {
    await this.db.insert(usageLogs).values(entry);
  }

  async usageSummary(since: Date): Promise<UsageSummary> {
    const byModel = await this.db
      .select({
        provider: usageLogs.provider,
        model: usageLogs.model,
        ...totals,
        avgLatencyMs: sql<number>`round(avg(${usageLogs.latencyMs}))`.mapWith(Number),
      })
      .from(usageLogs)
      .where(gte(usageLogs.createdAt, since))
      .groupBy(usageLogs.provider, usageLogs.model)
      .orderBy(sql`count(*) desc`);

    const byKey = await this.db
      .select({ key: apiKeys.name, ...totals })
      .from(usageLogs)
      .innerJoin(apiKeys, eq(apiKeys.id, usageLogs.apiKeyId))
      .where(gte(usageLogs.createdAt, since))
      .groupBy(apiKeys.id, apiKeys.name)
      .orderBy(sql`count(*) desc`);

    return { since: since.toISOString(), totals: sumTotals(byModel), byModel, byKey };
  }
}

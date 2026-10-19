// Runs against a real Postgres when TEST_DATABASE_URL is set (CI does this),
// skipped otherwise. It only touches rows it created itself.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/db/pg-store.js';
import { apiKeys, usageLogs } from '../src/db/schema.js';
import { hashKey } from '../src/keys.js';
import type { UsageEntry } from '../src/store.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PgStore (postgres)', () => {
  const client = postgres(url ?? '', { max: 2, onnotice: () => {} });
  const db = drizzle({ client });
  const store = new PgStore(db);
  const runId = randomUUID().slice(0, 8);
  const startedAt = new Date(Date.now() - 1000);
  let keyId = '';

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: 'drizzle' });
  });

  afterAll(async () => {
    if (keyId) {
      await db.delete(usageLogs).where(eq(usageLogs.apiKeyId, keyId));
      await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
    }
    await client.end();
  });

  it('creates a key and finds it by hash only while active', async () => {
    const created = await store.createKey({
      name: `test-${runId}`,
      keyHash: hashKey(`secret-${runId}`),
      keyPrefix: 'gw-test',
      rateLimitPerMinute: 5,
    });
    keyId = created.id;

    expect(await store.findActiveKey(hashKey(`secret-${runId}`))).toEqual(created);
    expect(await store.findActiveKey(hashKey('something else'))).toBeUndefined();

    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, keyId));
    expect(await store.findActiveKey(hashKey(`secret-${runId}`))).toBeUndefined();
  });

  it('sums usage per model and per key', async () => {
    const model = `model-${runId}`;
    const base: UsageEntry = {
      apiKeyId: keyId,
      requestedModel: 'fast',
      provider: 'ollama',
      model,
      status: 'ok',
      stream: false,
      cached: false,
      attempts: 1,
      promptTokens: 100,
      completionTokens: 50,
      latencyMs: 200,
      costUsd: 0.0012,
      error: null,
    };
    await store.recordUsage(base);
    await store.recordUsage({ ...base, latencyMs: 400, costUsd: 0.0008 });
    await store.recordUsage({ ...base, cached: true, promptTokens: 0, completionTokens: 0, costUsd: 0 });
    await store.recordUsage({ ...base, status: 'error', error: 'boom', promptTokens: 0, completionTokens: 0 });

    const summary = await store.usageSummary(startedAt);
    const row = summary.byModel.find((r) => r.model === model);
    const key = summary.byKey.find((r) => r.key === `test-${runId}`);

    expect(row).toMatchObject({
      provider: 'ollama',
      requests: 4,
      errors: 1,
      cacheHits: 1,
      promptTokens: 200,
      completionTokens: 100,
      costUsd: 0.0032,
      avgLatencyMs: 250,
    });
    expect(key).toMatchObject({ requests: 4, errors: 1, promptTokens: 200 });
    expect(summary.totals.requests).toBeGreaterThanOrEqual(4);
  });
});

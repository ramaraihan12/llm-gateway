// Runs against a real Postgres when TEST_DATABASE_URL is set (CI does this),
// skipped otherwise. It only touches rows it created itself.
import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, PgStore } from '../src/db/pg-store.js';
import { apiKeys, demoQuota, usageLogs } from '../src/db/schema.js';
import { hashKey } from '../src/keys.js';
import type { UsageEntry } from '../src/store.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PgStore (postgres)', () => {
  const client = postgres(url ?? '', { max: 2, onnotice: () => {} });
  const db = drizzle({ client });
  const store = new PgStore(db);
  const runId = randomUUID().slice(0, 8);
  const prefix = `gw-${runId}`;
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
    await db.delete(demoQuota).where(like(demoQuota.bucket, `${runId}:%`));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, 'public-demo'));
    await client.end();
  });

  it('creates a key and finds it by hash only while active', async () => {
    const created = await store.createKey({
      name: `test-${runId}`,
      keyHash: hashKey(`secret-${runId}`),
      keyPrefix: prefix,
      rateLimitPerMinute: 5,
    });
    keyId = created.id;
    const listed = async () => (await store.listKeys()).find((key) => key.prefix === prefix);

    expect(await store.findActiveKey(hashKey(`secret-${runId}`))).toEqual(created);
    expect(await store.findActiveKey(hashKey('something else'))).toBeUndefined();
    expect(await listed()).toMatchObject({ name: `test-${runId}`, rateLimitPerMinute: 5, revokedAt: null });

    await store.revokeKey(prefix);

    expect(await store.findActiveKey(hashKey(`secret-${runId}`))).toBeUndefined();
    expect((await listed())?.revokedAt).toBeInstanceOf(Date);
    await expect(store.revokeKey(prefix)).rejects.toThrow(`no active key with prefix ${prefix}`);
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

  it('lets exactly the limit through when many connections race for a bucket', async () => {
    const { db: racing, close } = connect(url ?? '');
    const racer = new PgStore(racing);
    const bucket = `${runId}:race`;
    const later = new Date(Date.now() + 60_000);
    try {
      const results = await Promise.all(Array.from({ length: 40 }, () => racer.takeQuota(bucket, 7, later)));

      expect(results.filter((hits) => hits !== undefined).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]);
      expect(await racer.takeQuota(bucket, 7, later)).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('sweeps only the buckets that have expired', async () => {
    const now = new Date();
    await store.takeQuota(`${runId}:old`, 5, new Date(now.getTime() - 1000));
    await store.takeQuota(`${runId}:new`, 5, new Date(now.getTime() + 60_000));

    await store.sweepQuota(now);

    const left = await db
      .select()
      .from(demoQuota)
      .where(like(demoQuota.bucket, `${runId}:%`));
    expect(left.map((row) => row.bucket)).not.toContain(`${runId}:old`);
    expect(left.map((row) => row.bucket)).toContain(`${runId}:new`);
  });

  it('gives demo traffic one key row that no bearer token can match', async () => {
    const [first, second] = await Promise.all([store.demoKey(), store.demoKey()]);

    expect(first.id).toBe(second.id);
    expect(await store.findActiveKey(hashKey('public-demo'))).toBeUndefined();
  });
});

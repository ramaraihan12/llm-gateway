import { randomUUID } from 'node:crypto';
import {
  sumTotals,
  type ApiKeyRecord,
  type ModelUsage,
  type NewApiKey,
  type Store,
  type UsageEntry,
  type UsageSummary,
} from '../src/store.js';

/** Store for HTTP-level tests. PgStore has its own test against Postgres. */
export class MemoryStore implements Store {
  readonly keys: (ApiKeyRecord & { keyHash: string })[] = [];
  readonly usage: (UsageEntry & { createdAt: Date })[] = [];

  findActiveKey(keyHash: string): Promise<ApiKeyRecord | undefined> {
    const key = this.keys.find((k) => k.keyHash === keyHash);
    return Promise.resolve(key && { id: key.id, name: key.name, rateLimitPerMinute: key.rateLimitPerMinute });
  }

  createKey(key: NewApiKey): Promise<ApiKeyRecord> {
    const record = { id: randomUUID(), name: key.name, rateLimitPerMinute: key.rateLimitPerMinute };
    this.keys.push({ ...record, keyHash: key.keyHash });
    return Promise.resolve(record);
  }

  recordUsage(entry: UsageEntry): Promise<void> {
    this.usage.push({ ...entry, createdAt: new Date() });
    return Promise.resolve();
  }

  usageSummary(since: Date): Promise<UsageSummary> {
    const rows = this.usage.filter((u) => u.createdAt >= since);
    const totalsOf = (group: typeof rows) => ({
      ...sumTotals(
        group.map((u) => ({
          requests: 1,
          errors: u.status === 'error' ? 1 : 0,
          cacheHits: u.cached ? 1 : 0,
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          costUsd: u.costUsd ?? 0,
        })),
      ),
    });

    const byModel = new Map<string, typeof rows>();
    const byKey = new Map<string, typeof rows>();
    for (const row of rows) {
      const modelKey = `${row.provider}|${row.model}`;
      byModel.set(modelKey, [...(byModel.get(modelKey) ?? []), row]);
      const keyName = this.keys.find((k) => k.id === row.apiKeyId)?.name ?? row.apiKeyId;
      byKey.set(keyName, [...(byKey.get(keyName) ?? []), row]);
    }

    const models: ModelUsage[] = [...byModel.values()].map((group) => ({
      provider: group[0]?.provider ?? null,
      model: group[0]?.model ?? null,
      ...totalsOf(group),
      avgLatencyMs: Math.round(group.reduce((sum, u) => sum + u.latencyMs, 0) / group.length),
    }));

    return Promise.resolve({
      since: since.toISOString(),
      totals: sumTotals(models),
      byModel: models,
      byKey: [...byKey.entries()].map(([key, group]) => ({ key, ...totalsOf(group) })),
    });
  }
}

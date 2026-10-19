export interface ApiKeyRecord {
  id: string;
  name: string;
  rateLimitPerMinute: number;
}

export interface NewApiKey {
  name: string;
  keyHash: string;
  keyPrefix: string;
  rateLimitPerMinute: number;
}

/** What key:list shows. The hash never leaves the database. */
export interface KeySummary {
  prefix: string;
  name: string;
  rateLimitPerMinute: number;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface UsageEntry {
  apiKeyId: string;
  requestedModel: string;
  provider: string | null;
  model: string | null;
  status: 'ok' | 'error';
  stream: boolean;
  cached: boolean;
  attempts: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: number | null;
  error: string | null;
}

export interface UsageTotals {
  requests: number;
  errors: number;
  cacheHits: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ModelUsage extends UsageTotals {
  provider: string | null;
  model: string | null;
  avgLatencyMs: number;
}

export interface KeyUsage extends UsageTotals {
  key: string;
}

export interface UsageSummary {
  since: string;
  totals: UsageTotals;
  byModel: ModelUsage[];
  byKey: KeyUsage[];
}

export interface Store {
  findActiveKey(keyHash: string): Promise<ApiKeyRecord | undefined>;
  createKey(key: NewApiKey): Promise<ApiKeyRecord>;
  recordUsage(entry: UsageEntry): Promise<void>;
  usageSummary(since: Date): Promise<UsageSummary>;
}

export function sumTotals(rows: UsageTotals[]): UsageTotals {
  const totals: UsageTotals = {
    requests: 0,
    errors: 0,
    cacheHits: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
  };
  for (const row of rows) {
    totals.requests += row.requests;
    totals.errors += row.errors;
    totals.cacheHits += row.cacheHits;
    totals.promptTokens += row.promptTokens;
    totals.completionTokens += row.completionTokens;
    totals.costUsd += row.costUsd;
  }
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  return totals;
}

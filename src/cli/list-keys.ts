import { PgStore } from '../db/pg-store.js';
import { connectFromEnv } from './db.js';

const { db, close } = connectFromEnv();
try {
  const keys = await new PgStore(db).listKeys();
  if (keys.length === 0) {
    console.log('no keys yet, create one with: pnpm key:create --name <name>');
  } else {
    const day = (date: Date) => date.toISOString().slice(0, 10);
    printTable(
      ['prefix', 'name', 'rpm', 'created', 'status'],
      keys.map((key) => [
        key.prefix,
        key.name,
        String(key.rateLimitPerMinute),
        day(key.createdAt),
        key.revokedAt ? `revoked ${day(key.revokedAt)}` : 'active',
      ]),
    );
  }
} finally {
  await close();
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i]?.length ?? 0)));
  for (const row of [header, ...rows]) {
    console.log(
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    );
  }
}

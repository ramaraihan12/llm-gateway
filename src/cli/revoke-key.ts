import { parseArgs } from 'node:util';
import { PgStore } from '../db/pg-store.js';
import { connectFromEnv } from './db.js';

const { positionals } = parseArgs({ allowPositionals: true });
const prefix = positionals[0];
if (!prefix || positionals.length > 1) {
  console.error('usage: revoke-key <prefix>   (the prefix column from key:list)');
  process.exit(1);
}

const { db, close } = connectFromEnv();
try {
  const key = await new PgStore(db).revokeKey(prefix);
  console.log(`revoked "${key.name}" (${key.prefix}), requests with it now get a 401`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await close();
}

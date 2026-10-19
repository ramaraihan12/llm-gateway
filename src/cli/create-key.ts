import { parseArgs } from 'node:util';
import { connect, PgStore } from '../db/pg-store.js';
import { generateKey, hashKey } from '../keys.js';

const usage = 'usage: create-key --name <name> [--rpm 60]';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    rpm: { type: 'string', default: '60' },
  },
});

const rpm = Number(values.rpm);
if (!values.name || !Number.isInteger(rpm) || rpm < 1) {
  console.error(usage);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const { db, close } = connect(databaseUrl);
try {
  const key = generateKey();
  const record = await new PgStore(db).createKey({
    name: values.name,
    keyHash: hashKey(key),
    keyPrefix: key.slice(0, 10),
    rateLimitPerMinute: rpm,
  });
  console.log(`created key "${record.name}" (${record.rateLimitPerMinute} requests/min)`);
  console.log(key);
  console.log('Save it now, only the hash is stored.');
} finally {
  await close();
}

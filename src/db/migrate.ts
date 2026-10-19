import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connect } from './pg-store.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

// Same relative path from src/db and dist/db.
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

const { db, close } = connect(databaseUrl);
try {
  await migrate(db, { migrationsFolder });
  console.log('migrations applied');
} finally {
  await close();
}

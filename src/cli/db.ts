import { connect } from '../db/pg-store.js';

/** For the key scripts: connect with DATABASE_URL or exit with a message. */
export function connectFromEnv(): ReturnType<typeof connect> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  return connect(databaseUrl);
}

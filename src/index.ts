import { serve } from '@hono/node-server';
import { createGateway } from './gateway.js';

const { app, env, log, database } = await createGateway();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info(`listening on http://localhost:${info.port}`);
});

const shutdown = (signal: string) => {
  log.info(`${signal} received, shutting down`);
  server.close(() => {
    void database.close().finally(() => process.exit(0));
  });
  // Open streams can keep the server alive, do not wait for them forever.
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

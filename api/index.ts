// Vercel entry. Top level, so an instance loads the config and connects once.
import { waitUntil } from '@vercel/functions';
import { createGateway } from '../src/gateway.js';

const { app } = await createGateway(waitUntil);

export default { fetch: (request: Request) => app.fetch(request) };

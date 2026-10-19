import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './helpers.js';

// Any request without a handler fails the test, so nothing can reach a real API.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

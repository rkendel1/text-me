import { createServer, type Server } from 'node:http';
import type { Express } from 'express';

// Vercel's Express preset serves the entry file that imports express; this is
// the entry (the HTTP server with the media-stream WebSocket), so say so. Erased at build.
import type {} from 'express';

import { buildServer } from './bootstrap.js';
import { startupFailureApp } from './startup-failure.js';

// On Vercel one instance serves many requests at once: a stray rejection or error in one
// request's background work must be logged, not take every in-flight request down with it.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[process] uncaught exception:', error);
});

let app: Express;
let server: Server;
try {
  ({ app, server } = buildServer());
} catch (error) {
  // A crash here would surface only as INTERNAL_FUNCTION_INVOCATION_FAILED; say what's wrong instead.
  console.error('[startup] failed', error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error);
  app = startupFailureApp(error);
  server = createServer(app);
}

const port = Number(process.env.PORT ?? '3000');
if (!process.env.VERCEL) {
  server.on('error', (error) => {
    console.error('[server] listen/runtime error', { port, error });
  });
  server.listen(port, () => {
    console.info('[server] listening', { port, vercel: false, environment: process.env.NODE_ENV ?? 'development' });
  });
}

export default app;

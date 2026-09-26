import type { Server } from 'node:http';

// Vercel's Express preset serves the entry file that imports express; this is
// the entry (the HTTP server with the media-stream WebSocket), so say so. Erased at build.
import type {} from 'express';

import { buildServer } from './bootstrap.js';
import { startupFailureServer } from './startup-failure.js';

// On Vercel one instance serves many requests at once: a stray rejection or error in one
// request's background work must be logged, not take every in-flight request down with it.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[process] uncaught exception:', error);
});

let server: Server;
try {
  ({ server } = buildServer());
} catch (error) {
  // A crash here would surface only as INTERNAL_FUNCTION_INVOCATION_FAILED; say what's wrong instead.
  console.error('Startup failed:', error);
  server = startupFailureServer(error);
}

// Always listen: on Vercel the Node runtime intercepts listen() to capture this
// server (Express app + media-stream WebSocket); everywhere else it binds the port.
const port = Number(process.env.PORT ?? '3000');
server.listen(port, () => {
  if (!process.env.VERCEL) console.log(`text-me listening on port ${port}`);
});

export default server;

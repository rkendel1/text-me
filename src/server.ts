// Vercel's Express preset serves the entry file that imports express; this is
// the entry (the HTTP server with the media-stream WebSocket), so say so. Erased at build.
import type {} from 'express';

import { buildServer } from './bootstrap.js';

const { server } = buildServer();

// Always listen: on Vercel the Node runtime intercepts listen() to capture this
// server (Express app + media-stream WebSocket); everywhere else it binds the port.
const port = Number(process.env.PORT ?? '3000');
server.listen(port, () => {
  if (!process.env.VERCEL) console.log(`text-me listening on port ${port}`);
});

export default server;

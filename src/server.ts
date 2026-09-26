import { buildServer } from './bootstrap.js';

const { server } = buildServer();

// Vercel serves the exported server; everywhere else we listen ourselves.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? '3000');
  server.listen(port, () => {
    console.log(`text-me listening on port ${port}`);
  });
}

export default server;

import { createServer, type Server } from 'node:http';

import { ConfigurationError } from './config.js';

/**
 * When the deployment can't start (usually a missing environment variable), it
 * still answers: a setup page for people, JSON for /health/ready and API
 * clients, so the problem is visible instead of an opaque function crash.
 * Only configuration problems are shown; other errors go to the function logs.
 */
export function startupFailureServer(error: unknown): Server {
  const problems = error instanceof ConfigurationError
    ? error.problems
    : ['The server failed to start. Open the deployment’s function logs in Vercel for details.'];
  const escape = (value: string) => value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!));
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Text Me · Setup needed</title><style>
body{margin:0;font:17px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;background:#f2f2f7;color:#1d1d1f;padding:48px 20px}
main{max-width:560px;margin:auto}h1{font-size:28px;margin:0 0 8px}p{color:#6e6e73;margin:0 0 20px}
ul{background:#fff;border-radius:12px;padding:6px 0;margin:0;list-style:none}li{padding:12px 16px}li+li{border-top:.5px solid #d1d1d6}
@media (prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}ul{background:#1c1c1e}li+li{border-color:#38383a}p{color:#98989d}}
</style></head><body><main><h1>Almost there</h1>
<p>This deployment needs a few settings before it can answer calls. Add them in Vercel → Project → Settings → Environment Variables, then redeploy.</p>
<ul>${problems.map((problem) => `<li>${escape(problem)}</li>`).join('')}</ul>
<p style="margin-top:20px">Where to get each value: docs/release-audit.md, section 6.</p></main></body></html>`;

  return createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const requestId = request.headers['x-vercel-id'] ?? request.headers['x-request-id'] ?? null;
    console.warn('[startup] serving failure response', {
      requestId,
      method: request.method,
      path,
      status: path === '/health' ? 200 : 503,
    });
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (path === '/health') return json(200, { status: 'ok', ready: false });
    if (path === '/health/ready') return json(503, { status: 'not_configured', problems });
    if ((request.headers.accept ?? '').includes('text/html')) {
      response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(page);
      return;
    }
    json(503, { error: 'This deployment isn’t configured yet.', code: 'not_configured', problems });
  });
}

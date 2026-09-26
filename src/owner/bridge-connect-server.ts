import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import type { BridgeStatus } from './bridge-agent.js';

export interface ConnectPageAgent {
  status(): BridgeStatus;
  connect(payload: string): Promise<BridgeStatus>;
}

export interface ConnectServer {
  /** The page to open, including the per-launch key. */
  url: string;
  close(): Promise<void>;
}

/**
 * The local "Connect this Mac" page. It listens on loopback only, and every
 * request must carry a key minted at launch, so no website can pair this Mac
 * with someone else's account.
 */
export async function startConnectServer(agent: ConnectPageAgent, port = 0): Promise<ConnectServer> {
  const key = randomBytes(24).toString('base64url');
  const jsqrPath = createRequire(import.meta.url).resolve('jsqr');
  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => send(response, 500, 'text/plain', 'Something went wrong'));
  });

  const hostOk = (request: IncomingMessage) => {
    const { port: bound } = server.address() as AddressInfo;
    return request.headers.host === `127.0.0.1:${bound}` || request.headers.host === `localhost:${bound}`;
  };
  const keyOk = (value: string | null | undefined) => {
    if (!value) return false;
    const given = Buffer.from(value);
    const expected = Buffer.from(key);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Rejecting unknown Host headers defeats DNS rebinding.
    if (!hostOk(request)) return send(response, 403, 'text/plain', 'Forbidden');
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/') {
      if (!keyOk(url.searchParams.get('key'))) return send(response, 403, 'text/plain', 'Open this page from the bridge.');
      return send(response, 200, 'text/html; charset=utf-8', connectPage(key));
    }
    if (request.method === 'GET' && url.pathname === '/jsQR.js') {
      return send(response, 200, 'text/javascript', await readFile(jsqrPath, 'utf8'));
    }
    if (!keyOk(request.headers['x-bridge-key'] as string | undefined)) return send(response, 403, 'text/plain', 'Forbidden');
    if (request.method === 'GET' && url.pathname === '/api/status') {
      return send(response, 200, 'application/json', JSON.stringify(agent.status()));
    }
    if (request.method === 'POST' && url.pathname === '/api/connect') {
      const body = await readBody(request);
      const payload = typeof body.payload === 'string' ? body.payload.slice(0, 2000) : '';
      return send(response, 200, 'application/json', JSON.stringify(await agent.connect(payload)));
    }
    send(response, 404, 'text/plain', 'Not found');
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}/?key=${key}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 10_000) break;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; frame-ancestors 'none'",
  });
  response.end(body);
}

function connectPage(key: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect this Mac</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f5f7; --card:#fff; --text:#1d1d1f; --secondary:#6e6e73; --sep:rgba(60,60,67,.18);
    --blue:#007aff; --green:#34c759; --red:#ff3b30; }
  @media (prefers-color-scheme: dark) { :root { --bg:#000; --card:#1c1c1e; --text:#f5f5f7; --secondary:#98989d; --sep:rgba(84,84,88,.6);
    --blue:#0a84ff; --green:#30d158; --red:#ff453a; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
    font: 15px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; -webkit-font-smoothing: antialiased; }
  main { width:min(440px, calc(100vw - 32px)); text-align:center; padding:40px 0; }
  .mark { width:64px; height:64px; margin:0 auto 18px; border-radius:16px; background:linear-gradient(180deg,#5ac8fa,#007aff);
    display:grid; place-items:center; box-shadow:0 8px 24px rgba(0,122,255,.25); }
  .mark svg { width:36px; height:36px; }
  h1 { font-size:28px; letter-spacing:-.02em; margin:0 0 8px; font-weight:700; }
  p.lead { color:var(--secondary); margin:0 auto 24px; max-width:340px; }
  .viewfinder { position:relative; width:280px; height:280px; margin:0 auto; border-radius:28px; overflow:hidden; background:#1c1c1e; }
  .viewfinder video { width:100%; height:100%; object-fit:cover; transform:scaleX(-1); }
  .corners { position:absolute; inset:36px; border-radius:18px; pointer-events:none;
    box-shadow:0 0 0 9999px rgba(0,0,0,.28); outline:3px solid rgba(255,255,255,.9); outline-offset:0; }
  .hint { color:var(--secondary); font-size:13px; margin-top:14px; }
  .error { color:var(--red); font-size:14px; margin:16px auto 0; max-width:340px; min-height:20px; }
  .spinner { width:36px; height:36px; margin:40px auto 16px; border-radius:50%; border:3px solid var(--sep); border-top-color:var(--blue); animation:spin .8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .check { width:84px; height:84px; margin:8px auto 18px; border-radius:50%; background:var(--green); display:grid; place-items:center;
    animation:pop .35s cubic-bezier(.2,1.4,.4,1); }
  @keyframes pop { from { transform:scale(.6); opacity:0; } }
  .list { background:var(--card); border-radius:12px; text-align:left; margin-top:24px; overflow:hidden; }
  .row { display:flex; justify-content:space-between; padding:12px 16px; gap:12px; }
  .row + .row { border-top:.5px solid var(--sep); }
  .row span:last-child { color:var(--secondary); }
  .ok { color:var(--green) !important; }
  button.link { background:none; border:0; color:var(--blue); font:inherit; cursor:pointer; padding:8px; margin-top:10px; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <section id="scan">
    <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg></div>
    <h1>Connect this Mac</h1>
    <p class="lead">On your iPhone, open <b>Settings → Connected Devices → Connect a Mac</b>, then hold the code up to this camera.</p>
    <div class="viewfinder"><video id="video" playsinline muted></video><div class="corners"></div></div>
    <div class="hint" id="hint">Looking for a code…</div>
    <div class="error" id="error" role="alert"></div>
    <button class="link" id="choose">Use a screenshot of the code instead</button>
    <input type="file" id="file" accept="image/*" hidden>
  </section>
  <section id="connecting" hidden>
    <div class="spinner"></div>
    <h1>Connecting…</h1>
    <p class="lead">Linking this Mac to your account.</p>
  </section>
  <section id="connected" hidden>
    <div class="check"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
    <h1>Mac connected</h1>
    <p class="lead" id="next">Finish setup on your iPhone. You can close this window; the bridge keeps running.</p>
    <div class="list">
      <div class="row"><span>Account</span><span id="server">—</span></div>
      <div class="row"><span>Apple Messages</span><span id="enabled">—</span></div>
      <div class="row"><span>Assistant chat</span><span id="chat">—</span></div>
      <div class="row"><span>Watching Messages</span><span id="watcher">—</span></div>
    </div>
    <div class="error" id="syncError"></div>
  </section>
</main>
<script src="/jsQR.js"></script>
<script>
const KEY = ${JSON.stringify(key)};
const $ = (id) => document.getElementById(id);
let phase = null, stream = null, scanning = false, submitting = false, lastPayload = '', lastAt = 0;
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });

async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'X-Bridge-Key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  return response.json();
}

function render(status) {
  if (status.phase !== phase) {
    phase = status.phase;
    $('scan').hidden = phase !== 'waiting_for_qr';
    $('connecting').hidden = phase !== 'connecting';
    $('connected').hidden = phase !== 'connected';
    if (phase === 'waiting_for_qr') startCamera(); else stopCamera();
  }
  $('error').textContent = phase === 'waiting_for_qr' ? (status.error || '') : '';
  $('syncError').textContent = phase === 'connected' ? (status.error || '') : '';
  $('server').textContent = status.server || '—';
  $('enabled').textContent = status.messagesEnabled ? 'On' : 'Off';
  $('enabled').className = status.messagesEnabled ? 'ok' : '';
  $('chat').textContent = status.assistantChat ? 'Chosen' : 'Choose on iPhone';
  $('chat').className = status.assistantChat ? 'ok' : '';
  $('watcher').textContent = status.watcher ? 'Yes' : 'No';
  $('watcher').className = status.watcher ? 'ok' : '';
}

async function submit(payload) {
  // A rejected code stays in front of the camera; don't resubmit it on every frame.
  if (submitting || (payload === lastPayload && Date.now() - lastAt < 10000)) return;
  submitting = true; lastPayload = payload; lastAt = Date.now();
  render({ ...(await api('/api/status')), phase: 'connecting' });
  try { render(await api('/api/connect', { payload })); } finally { submitting = false; }
}

async function startCamera() {
  if (stream) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    $('video').srcObject = stream;
    await $('video').play();
    $('hint').textContent = 'Looking for a code…';
    scanning = true;
    requestAnimationFrame(scan);
  } catch {
    $('hint').textContent = 'Camera unavailable. Use a screenshot of the code instead.';
  }
}

function stopCamera() {
  scanning = false;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
}

function decode(source, width, height) {
  canvas.width = width; canvas.height = height;
  context.drawImage(source, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  const code = jsQR(image.data, width, height, { inversionAttempts: 'attemptBoth' });
  return code && code.data.startsWith('attn://pair/') ? code.data : null;
}

function scan() {
  if (!scanning) return;
  const video = $('video');
  if (video.readyState >= 2 && !submitting) {
    const found = decode(video, video.videoWidth, video.videoHeight);
    if (found) { submit(found); }
  }
  setTimeout(() => requestAnimationFrame(scan), 150);
}

$('choose').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0];
  if (!file) return;
  const bitmap = await createImageBitmap(file);
  const found = decode(bitmap, bitmap.width, bitmap.height);
  $('file').value = '';
  if (found) submit(found); else $('error').textContent = 'No pairing code found in that image.';
};

async function poll() {
  try { if (!submitting) render(await api('/api/status')); } catch {}
  setTimeout(poll, 2000);
}
poll();
</script>
</body>
</html>`;
}

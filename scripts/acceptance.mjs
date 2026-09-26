#!/usr/bin/env node
/**
 * Browser acceptance journey for a deployed control plane (docs/release-audit.md §6).
 *
 *   npm run acceptance -- --url https://<project>.vercel.app --key <OWNER_AUTH_TOKEN>
 *
 * It signs in through the real UI, watches a live call, issues a command,
 * receives and resolves an attention item, refreshes, and proves the state is
 * server-side with a second browser session and the API. It needs a real call:
 * pass --place-call "<command>" to run one (local harness), or call the number
 * yourself when the script asks.
 *
 * Options: --out <dir> for screenshots, --browser <chromium path>, --timeout <seconds>.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : 'true']);
  return pairs;
}, []));
const BASE = (args.url ?? process.env.ACCEPTANCE_URL ?? '').replace(/\/+$/, '');
const KEY = args.key ?? process.env.ACCEPTANCE_KEY;
const OUT = args.out ?? 'acceptance-output';
const TIMEOUT = Number(args.timeout ?? 180) * 1000;
if (!BASE || !KEY) {
  console.error('Usage: npm run acceptance -- --url <deployment URL> --key <owner access key> [--place-call "<command>"]');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const results = [];
const step = async (name, run) => {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: error.message });
    console.log(`FAIL  ${name} — ${error.message}`);
    throw error;
  }
};
const api = async (path, init = {}) => {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...init.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${body?.error ?? ''}`);
  return body;
};
const until = async (check, what, timeout = TIMEOUT) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });

const browser = await chromium.launch({
  executablePath: args.browser ?? process.env.CHROMIUM_PATH ?? undefined,
});
const pageErrors = [];
const signIn = async (context, name) => {
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`${name}: ${error.message}`));
  await page.goto(BASE);
  await page.waitForSelector('#signin:not([hidden]) #tokenInput');
  await page.fill('#tokenInput', KEY);
  await page.click('#signinButton');
  await page.waitForSelector('#app:not([hidden]) #planeStatus:not([hidden])');
  const onboarding = page.locator('#onboard:not([hidden])');
  if (await onboarding.count()) await page.evaluate(() => document.querySelector('#onboard').hidden = true);
  return page;
};

let call;
let exitCode = 0;
try {
  await step('Deployment is production-ready', async () => {
    const response = await fetch(`${BASE}/health/ready`);
    const body = await response.json();
    const failing = Object.entries(body.checks).filter(([, check]) => !check.ok).map(([name, check]) => `${name}: ${check.detail ?? 'failed'}`);
    if (failing.length) throw new Error(failing.join('; '));
    return `${body.environment}, database ok`;
  });

  const desk = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  let page;
  await step('Authenticate (access key → session; the key is not stored)', async () => {
    page = await signIn(desk, 'browser A');
    const stored = await page.evaluate(() => ({ session: localStorage.getItem('ownerSession'), key: localStorage.getItem('ownerToken') }));
    if (!stored.session?.startsWith('ses_') || stored.key) throw new Error('expected only a session in browser storage');
    return 'session stored, access key not stored';
  });

  let plane;
  await step('Load control plane and identify the live plane', async () => {
    plane = await api('/owner/control-plane');
    await shot(page, '01-control-plane');
    return `${plane.plane.id}: ${await page.textContent('#planeText')}`;
  });

  const before = new Set((await api('/conversations')).map((conversation) => conversation.id));
  await step('Receive a state transition (a call starts)', async () => {
    if (args['place-call']) {
      call = spawn(args['place-call'], { shell: true, stdio: 'ignore' });
    } else {
      console.log('\n  → Call your number now. When the assistant answers, say you need to reschedule,');
      console.log('    then ask whether Friday at 2 works. Stay on the line.\n');
    }
    const conversation = await until(async () => (await api('/conversations')).find((item) => !before.has(item.id)), 'a new call');
    await page.waitForSelector(`[data-open="${conversation.id}"]`, { timeout: TIMEOUT });
    await until(async () => ['working', 'awaiting_attention'].includes(await page.getAttribute('#planeStatus', 'data-status')), 'plane status working');
    plane = { conversationId: conversation.id };
    await shot(page, '02-live-call');
    return `conversation ${conversation.id}, plane "${await page.textContent('#planeText')}"`;
  });
  const conversationId = plane.conversationId;

  await step('Issue a command and observe acknowledgement and resulting state', async () => {
    await page.click(`[data-open="${conversationId}"]`);
    await page.waitForSelector('#strip .chips');
    await page.click('#strip .chips');
    await page.click('.sheet [data-choice="verbosity"][data-value="detailed"]');
    await page.waitForSelector('.sheet .temp-banner');
    await shot(page, '03-command-acknowledged');
    await page.click('.sheet [data-close]');
    const detail = await api(`/conversations/${conversationId}`);
    if (!detail.runtime.overriddenFields.includes('verbosity')) throw new Error('verbosity not applied');
    const commands = await api(`/conversations/${conversationId}/runtime/commands`);
    const adjust = commands.find((command) => command.type === 'adjust_interaction');
    return `command ${adjust.id} ${adjust.status}`;
  });

  const phoneContext = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  let phone;
  await step('Second session (another device) signs in independently', async () => {
    phone = await signIn(phoneContext, 'browser B');
    const sessions = await api('/auth/sessions');
    return `${sessions.length} signed-in sessions`;
  });

  let attention;
  await step('Receive attention on both sessions', async () => {
    attention = await until(async () => (await api('/owner/attention?open=true')).find((item) =>
      item.conversationId === conversationId && item.type === 'assistant_needs_owner'), 'the assistant to need you');
    await page.waitForSelector('#ownerCard:not([hidden]) [data-reply]', { timeout: TIMEOUT });
    await phone.waitForSelector('.card.needs', { timeout: TIMEOUT });
    await shot(page, '04-attention-browser-a');
    await shot(phone, '05-attention-browser-b');
    return `"${attention.body}"`;
  });

  await step('Open the attention context from its deep link (session B)', async () => {
    await phone.goto(`${BASE}${attention.url}`);
    await phone.waitForSelector('#liveTab.pushed #ownerCard:not([hidden]) [data-reply]', { timeout: 20000 });
    await shot(phone, '06-attention-context');
    return attention.url;
  });

  await step('Resolve it on B; A updates live without a refresh', async () => {
    await phone.click('#ownerCard [data-reply] >> nth=0');
    await page.waitForSelector('#ownerCard[hidden]', { state: 'attached', timeout: 20000 });
    const item = await api(`/owner/attention/${attention.id}`);
    if (item.status !== 'acted' && item.status !== 'resolved') throw new Error(`attention is ${item.status}`);
    await shot(page, '07-resolved-seen-on-a');
    return `attention ${item.status}`;
  });

  await step('A stale notification tap does nothing but show the state', async () => {
    await page.goto(`${BASE}${attention.url}&intent=take_over`);
    await page.waitForSelector('#liveTab #transcript');
    await page.waitForTimeout(1500);
    const detail = await api(`/conversations/${conversationId}`);
    if (detail.runtime.status === 'takeover') throw new Error('stale tap took over');
    return `runtime still ${detail.runtime.status}`;
  });

  await step('Refresh: state is durable and identical across sessions and the API', async () => {
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.click(`[data-open="${conversationId}"]`);
    await page.waitForSelector('#transcript .bubble');
    const hasReply = await page.locator('#transcript').innerText();
    if (!/Friday at 2/i.test(hasReply)) throw new Error('reply missing after refresh');
    if (await page.locator('#ownerCard:not([hidden])').count()) throw new Error('attention came back after refresh');
    const fromApi = await api('/owner/control-plane');
    const fromA = await page.evaluate(async () => (await fetch('/owner/control-plane', { headers: { Authorization: `Bearer ${localStorage.getItem('ownerSession')}` } })).json());
    const fromB = await phone.evaluate(async () => (await fetch('/owner/control-plane', { headers: { Authorization: `Bearer ${localStorage.getItem('ownerSession')}` } })).json());
    const strip = (snapshot) => JSON.stringify({ ...snapshot, session: null, serverTime: null, live: snapshot.live.map(({ id, runtime }) => ({ id, status: runtime.status, revision: runtime.revision })) });
    if (strip(fromA) !== strip(fromB) || strip(fromA) !== strip(fromApi)) throw new Error('surfaces disagree');
    await shot(page, '08-after-refresh');
    return `plane ${fromApi.plane.status}; A, B and API agree`;
  });

  await step('Sign session B out from A; B is out immediately', async () => {
    const sessions = await api('/auth/sessions');
    const bToken = await phone.evaluate(() => localStorage.getItem('ownerSession'));
    const mine = await fetch(`${BASE}/auth/session`, { headers: { Authorization: `Bearer ${bToken}` } }).then((response) => response.json());
    if (!sessions.some((session) => session.id === mine.session.id)) throw new Error('session B not listed');
    await page.evaluate(async (id) => fetch(`/auth/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('ownerSession')}` } }), mine.session.id);
    await phone.reload();
    await phone.waitForSelector('#signin:not([hidden])', { timeout: 20000 });
    const reason = await phone.textContent('#signinError');
    if (!/signed out/i.test(reason ?? '')) throw new Error(`expected a signed-out reason, got "${reason}"`);
    await shot(phone, '09-signed-out');
    return reason;
  });
} catch {
  exitCode = 1;
} finally {
  call?.kill();
  await browser.close();
  if (pageErrors.length) { console.log(`\nPage errors:\n${pageErrors.join('\n')}`); exitCode = 1; }
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${passed}/${results.length} steps passed. Screenshots: ${OUT}`);
  process.exit(exitCode);
}

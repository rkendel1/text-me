/**
 * Two customers, two browsers, one deployment — through the real web UI:
 * sign up → setup checklist → name → claim a line → verify a number →
 * forwarding → assistant → notifications → control plane. Then calls to each
 * line, isolation between the browsers, and one browser switching accounts.
 *
 *   npm run journey:saas [-- <screenshot dir>]      (CHROMIUM_PATH to override the browser)
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';
import { createApp } from '../src/http-app.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { InMemoryConversationRepository } from '../test/support/in-memory-repository.js';

const OUT = process.argv[2] ?? 'journey-output';
mkdirSync(OUT, { recursive: true });
const messaging = new FakeMessagingProvider();
const repository = new InMemoryConversationRepository();
const app = createApp({ repository, messagingProvider: messaging });
const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const errors: string[] = [];
const code = (to: string) => [...messaging.sentMessages].reverse().find((m) => m.to === to)!.body.match(/(\d{6})/)![1];

async function signUpAndSetup(page: Page, name: string, email: string, personal: string, prefix: string) {
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
  await page.goto(BASE);
  await page.waitForSelector('#signin:not([hidden])');
  await page.click('#signinSwitch');
  await page.fill('#nameInput', name);
  await page.fill('#emailInput', email);
  await page.fill('#passwordInput', 'correct horse battery staple');
  await page.screenshot({ path: `${OUT}/${prefix}-01-sign-up.png` });
  await page.click('#signinButton');
  await page.waitForSelector('#onboard:not([hidden]) .checklist');
  await page.screenshot({ path: `${OUT}/${prefix}-02-welcome-checklist.png` });
  await page.click('#obNext');
  await page.waitForSelector('#obName');
  await page.click('#obSave');
  await page.waitForSelector('#obClaim');
  await page.screenshot({ path: `${OUT}/${prefix}-03-your-number.png` });
  await page.click('#obClaim');
  await page.waitForSelector('#obNumber:not([disabled])');
  await page.fill('#obNumber', personal);
  await page.click('#obSend');
  await page.waitForSelector('#obCode:not([hidden])');
  await page.fill('#obCode', code(personal));
  await page.screenshot({ path: `${OUT}/${prefix}-04-verify.png` });
  await page.click('#obVerify');
  await page.waitForSelector('#obForwarding');
  await page.screenshot({ path: `${OUT}/${prefix}-05-forwarding.png` });
  await page.click('#obNext');
  await page.waitForSelector('[data-behavior="automatic"]');
  await page.screenshot({ path: `${OUT}/${prefix}-06-assistant.png` });
  await page.click('[data-behavior="automatic"]');
  await page.waitForSelector('#obSms');
  await page.screenshot({ path: `${OUT}/${prefix}-07-notifications.png` });
  await page.click('#obSms');
  await page.waitForSelector('#app:not([hidden]) #planeStatus:not([hidden])');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${prefix}-08-control-plane.png` });
  return page.evaluate(async () => (await fetch('/owner/control-plane', { headers: { Authorization: `Bearer ${localStorage.getItem('ownerSession')}` } })).json());
}

try {
  const phone = { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  const a = await browser.newContext(phone);
  const b = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  const planeA = await signUpAndSetup(pageA, 'Avery Stone', 'avery@example.test', '+15551110001', 'a');
  const planeB = await signUpAndSetup(pageB, 'Blake Rivers', 'blake@example.test', '+15552220002', 'b');
  assert.deepEqual([planeA.onboarding.state, planeA.owner.name], ['ready', 'Avery']);
  assert.deepEqual([planeB.onboarding.state, planeB.owner.name], ['ready', 'Blake']);
  assert.notEqual(planeA.account.id, planeB.account.id);
  assert.notEqual(planeA.plane.assistantLine, planeB.plane.assistantLine);
  // Calls to each line
  await fetch(`${BASE}/webhooks/fake/voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: 'c-a', callerPhone: '+15553334444', to: planeA.plane.assistantLine }) });
  await fetch(`${BASE}/webhooks/fake/voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: 'c-b', callerPhone: '+15557778888', to: planeB.plane.assistantLine }) });
  await pageA.reload(); await pageB.reload();
  await pageA.waitForSelector('#app:not([hidden])'); await pageB.waitForSelector('#app:not([hidden])');
  await pageA.waitForTimeout(500); await pageB.waitForTimeout(500);
  const listA = await pageA.locator('#liveTab').innerText();
  const listB = await pageB.locator('#liveTab').innerText();
  assert.ok(/333.?4444/.test(listA) && !/777.?8888/.test(listA), 'browser A shows only A’s caller');
  assert.ok(/777.?8888/.test(listB) && !/333.?4444/.test(listB), 'browser B shows only B’s caller');
  await pageA.screenshot({ path: `${OUT}/a-09-inbox.png` });
  await pageB.screenshot({ path: `${OUT}/b-09-inbox.png` });
  // Settings shows account
  await pageB.click('[data-go="settings"]');
  await pageB.waitForSelector('#newAccount');
  await pageB.screenshot({ path: `${OUT}/b-10-settings-account.png`, fullPage: true });
  // Sign out A, sign in as B in the same browser
  await pageA.evaluate(async () => { await fetch('/auth/session', { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('ownerSession')}` } }); });
  await pageA.reload();
  await pageA.waitForSelector('#signin:not([hidden])');
  await pageA.fill('#emailInput', 'blake@example.test');
  await pageA.fill('#passwordInput', 'correct horse battery staple');
  await pageA.click('#signinButton');
  await pageA.waitForSelector('#app:not([hidden]) #planeStatus:not([hidden])');
  await pageA.waitForTimeout(500);
  const after = await pageA.locator('body').innerText();
  assert.ok(/777.?8888/.test(after) && !/333.?4444/.test(after) && !/Avery/.test(after), 'after signing in as B, nothing of A is left');
  await pageA.screenshot({ path: `${OUT}/a-11-same-phone-now-b.png` });
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`PASS  two accounts, two browsers, one deployment — screenshots in ${OUT}`);
} finally {
  await browser.close();
  server.close();
}

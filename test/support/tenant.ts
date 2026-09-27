import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

import type { Express } from 'express';
import request from 'supertest';

import type { FakeMessagingProvider } from '../../src/messaging/fake-provider.js';

export const PASSWORD = 'correct horse battery staple';

export interface Tenant {
  token: string;
  headers: { Authorization: string };
  userId: string;
  accountId: string;
  email: string;
  /** The account's assistant line: calls and texts to it belong to this account. */
  line: string;
  /** The owner's verified personal number. */
  personal: string;
}

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function signUp(app: Express, input: { email?: string; name?: string; platform?: 'web' | 'ios'; password?: string } = {}) {
  const email = input.email ?? `owner-${unique()}@example.test`;
  const response = await request(app).post('/auth/signup')
    .send({ email, password: input.password ?? PASSWORD, name: input.name, platform: input.platform ?? 'web' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return {
    email,
    token: response.body.token as string,
    headers: { Authorization: `Bearer ${response.body.token}` },
    userId: response.body.user.id as string,
    accountId: response.body.account.id as string,
    body: response.body,
  };
}

export async function signIn(app: Express, email: string, platform: 'web' | 'ios' = 'web', password = PASSWORD) {
  const response = await request(app).post('/auth/sessions').send({ email, password, platform });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { token: response.body.token as string, headers: { Authorization: `Bearer ${response.body.token}` }, body: response.body };
}

/** The verification code texted to `to` (read from the fake SMS provider, as a phone would receive it). */
export function lastCode(messaging: FakeMessagingProvider, to: string): string {
  const message = [...messaging.sentMessages].reverse().find((sent) => sent.to === to && /code is \d{6}/.test(sent.body));
  assert.ok(message, `no verification code was texted to ${to}`);
  return message.body.match(/code is (\d{6})/)![1];
}

/**
 * A new customer, through the same onboarding every customer uses: sign up,
 * name, claim an assistant line, verify their number, create the plane, and
 * turn on a notification channel (texts to their number unless told otherwise).
 */
export async function onboardTenant(app: Express, messaging: FakeMessagingProvider, input: {
  email?: string;
  name?: string;
  personal?: string;
  behavior?: string;
  sms?: boolean;
  platform?: 'web' | 'ios';
} = {}): Promise<Tenant> {
  const account = await signUp(app, { email: input.email, name: input.name ?? 'Randy', platform: input.platform });
  const { headers } = account;
  const identity = await request(app).post('/account/onboarding/identity').set(headers).send({ name: input.name ?? 'Randy' });
  assert.equal(identity.status, 200, JSON.stringify(identity.body));
  const line = await request(app).post('/account/phone/line').set(headers);
  assert.equal(line.status, 200, JSON.stringify(line.body));
  // Random by default: tests against Postgres share one database, where a verified number belongs to one account.
  const personal = input.personal ?? `+1555${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
  const started = await request(app).post('/account/phone/personal').set(headers).send({ number: personal });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const verified = await request(app).post('/account/phone/personal/verify').set(headers).send({ code: lastCode(messaging, personal) });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const plane = await request(app).post('/account/plane').set(headers).send({ name: 'Assistant', behavior: input.behavior ?? 'automatic' });
  assert.equal(plane.status, 200, JSON.stringify(plane.body));
  if (input.sms !== false) {
    const sms = await request(app).post('/account/notifications/sms').set(headers).send({ enabled: true });
    assert.equal(sms.status, 200, JSON.stringify(sms.body));
  }
  return {
    token: account.token, headers, userId: account.userId, accountId: account.accountId, email: account.email,
    line: line.body.assistantLine as string, personal,
  };
}

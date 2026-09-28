import assert from 'node:assert/strict';
import test from 'node:test';

import request from 'supertest';

import { createApp } from '../src/http-app.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { FakePhoneNumberClient, MAX_VERIFICATION_ATTEMPTS, PhoneNumberService, VERIFICATION_TTL_MS } from '../src/telephony/phone-number.js';
import { can, type TenantAction } from '../src/tenancy/authorization.js';
import { InMemoryTenancyStore, PhoneNumberTakenError } from '../src/tenancy/store.js';
import { verifyPassword } from '../src/tenancy/passwords.js';
import { InMemoryConversationRepository } from './support/in-memory-repository.js';
import { lastCode, onboardTenant, PASSWORD, signIn, signUp } from './support/tenant.js';

function saas(options: { pool?: string[]; purchasable?: boolean } = {}) {
  const messaging = new FakeMessagingProvider();
  const tenancyStore = new InMemoryTenancyStore();
  const numbers = new FakePhoneNumberClient(options.pool ?? [], options.purchasable ?? true);
  const app = createApp({
    repository: new InMemoryConversationRepository(), messagingProvider: messaging, tenancyStore, phoneNumberClient: numbers,
    publicBaseUrl: 'https://text-me.vercel.app',
  });
  return { app, messaging, tenancyStore, numbers };
}

test('anyone can sign up: a user, an account with an opaque id, an owner membership, and a session', async () => {
  const { app, tenancyStore } = saas();
  const created = await request(app).post('/auth/signup')
    .send({ email: '  Jordan@Example.TEST ', password: PASSWORD, name: 'Jordan Lee', platform: 'web' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.token, /^ses_/);
  assert.match(created.body.user.id, /^usr_[0-9a-f]{24}$/);
  assert.match(created.body.account.id, /^acct_[0-9a-f]{24}$/);
  assert.equal(created.body.user.email, 'jordan@example.test', 'emails are normalized, and never the account key');
  assert.ok(!created.body.account.id.includes('jordan'));
  assert.equal(created.body.account.role, 'owner');
  assert.equal(created.body.activeAccountId, created.body.account.id);
  assert.deepEqual(created.body.memberships, [{ accountId: created.body.account.id, accountName: 'Jordan Lee', role: 'owner' }]);
  assert.equal(created.body.onboarding.state, 'account_created');
  assert.equal(created.body.onboarding.next, 'identity');
  assert.equal((await tenancyStore.getSubscription(created.body.account.id))!.entitlements.maxAssistantLines, 1);
  const stored = await tenancyStore.findUserByEmail('jordan@example.test');
  assert.ok(stored && stored.passwordHash.startsWith('scrypt$') && !stored.passwordHash.includes(PASSWORD), 'passwords are hashed');
  assert.equal(await verifyPassword(PASSWORD, stored!.passwordHash), true);

  const duplicate = await request(app).post('/auth/signup').send({ email: 'jordan@example.test', password: PASSWORD });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'email_taken');
  assert.equal((await request(app).post('/auth/signup').send({ email: 'not-an-email', password: PASSWORD })).body.code, 'invalid_email');
  assert.equal((await request(app).post('/auth/signup').send({ email: 'short@example.test', password: 'short' })).body.code, 'weak_password');

  const again = await signIn(app, ' JORDAN@example.test ');
  assert.equal(again.body.account.id, created.body.account.id, 'signing in resumes the same account');
});

test('rate-limited auth accepts Vercel forwarded client addresses', async () => {
  const { app } = saas();
  const response = await request(app)
    .post('/auth/signup')
    .set('X-Forwarded-For', '203.0.113.10')
    .send({ email: 'forwarded@example.test', password: PASSWORD });
  assert.equal(response.status, 201, JSON.stringify(response.body));
});

test('a verified Neon social identity creates or resumes one app account and session', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/get-session(?:\?|$)/);
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';
    assert.equal(method, 'GET', 'Neon get-session must never inherit the browser handoff POST');
    return Response.json({
      user: {
        id: 'neon-user-1', email: 'Social@Example.test', name: 'Social Owner', emailVerified: true,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      session: {
        id: 'neon-session-1', userId: 'neon-user-1', token: 'verified',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }, { headers: { 'Set-Cookie': '__Secure-neon-auth.session_token=verified; Path=/; HttpOnly; Secure; SameSite=Lax' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const messaging = new FakeMessagingProvider();
  const tenancyStore = new InMemoryTenancyStore();
  const app = createApp({
    repository: new InMemoryConversationRepository(), messagingProvider: messaging, tenancyStore,
    neonAuth: { baseUrl: 'https://auth.example.test', cookieSecret: 'x'.repeat(32) },
    publicBaseUrl: 'https://text-me.vercel.app',
  });

  const callback = await request(app).get('/auth/callback?neon_auth_session_verifier=proof')
    .set('Cookie', '__Secure-neon-auth.session_challenge=challenge');
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, '/?auth=complete');
  assert.match(String(callback.headers['set-cookie']), /__Secure-neon-auth\.session_token=verified/);

  const first = await request(app).post('/auth/neon/session').send({});
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.match(first.body.token, /^ses_/);
  const me = await request(app).get('/me').set('Authorization', `Bearer ${first.body.token}`);
  assert.equal(me.body.user.email, 'social@example.test');
  assert.equal(me.body.memberships.length, 1);

  const second = await request(app).post('/auth/neon/session').send({});
  const resumed = await request(app).get('/me').set('Authorization', `Bearer ${second.body.token}`);
  assert.equal(resumed.body.activeAccountId, me.body.activeAccountId, 'the provider callback never creates duplicate accounts');
});

test('account-scoped billing bypass activates only the named test account without contacting Stripe', async () => {
  const tenancyStore = new InMemoryTenancyStore();
  const options = {
    repository: new InMemoryConversationRepository(), tenancyStore,
    messagingProvider: new FakeMessagingProvider(),
    billingBypassAccountId: undefined as string | undefined,
    publicBaseUrl: 'https://text-me.example.test',
  };
  const app = createApp(options);
  const created = await signUp(app, { name: 'Test Owner' });
  const denied = await request(app).post('/billing/checkout').set(created.headers).send({});
  assert.equal(denied.status, 503, 'other accounts still require Stripe');
  options.billingBypassAccountId = created.accountId;
  const checkout = await request(app).post('/billing/checkout').set(created.headers).send({});
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  assert.deepEqual(checkout.body, { url: 'https://text-me.example.test/?checkout=bypassed', status: 'active' });
  const me = await request(app).get('/me').set(created.headers);
  assert.equal(me.body.account.subscription, 'active');
});

test('onboarding is a state machine derived from durable facts, and the UI can show what is left', async () => {
  const { app, messaging } = saas();
  const { headers } = await signUp(app, { name: 'Sam' });
  const state = async () => (await request(app).get('/account/onboarding').set(headers)).body;
  assert.deepEqual((await state()).steps.map((step: { id: string; done: boolean }) => [step.id, step.done]),
    [['account', true], ['identity', false], ['phone', false], ['application', false], ['notifications', false]]);

  // Out of order is fine; the state only advances past a step once it is actually done.
  assert.equal((await request(app).post('/account/plane').set(headers).send({ name: 'Ava', behavior: 'ask_when_unsure' })).status, 200);
  assert.equal((await state()).state, 'account_created');

  const identity = await request(app).post('/account/onboarding/identity').set(headers).send({ name: 'Sam Rivera' });
  assert.equal(identity.body.state, 'identity_configured');
  const config = (await request(app).get('/owner/configuration').set(headers)).body;
  assert.equal(config.assistant.ownerName, 'Sam', 'the assistant introduces the account owner by first name');
  assert.equal(config.assistant.greeting, "Hi, this is Sam's assistant. How can I help?");
  assert.equal(config.assistant.assistantName, 'Ava');
  assert.equal(config.assistant.behavior, 'ask_when_unsure');

  // Phone: claim a line, then verify the owner's number by a code texted from that line.
  const line = await request(app).post('/account/phone/line').set(headers);
  assert.equal(line.status, 200);
  assert.equal(line.body.numbers.assistantLine.status, 'active');
  assert.equal(line.body.numbers.assistantLine.verificationStatus, 'provider_verified');
  assert.equal((await state()).state, 'identity_configured', 'a line alone is not a configured phone');
  const started = await request(app).post('/account/phone/personal').set(headers).send({ number: '+1 (555) 222-3344' });
  assert.equal(started.status, 202);
  assert.deepEqual([started.body.personal.status, started.body.personal.verificationStatus], ['pending_verification', 'code_sent']);
  const code = lastCode(messaging, '+15552223344');
  assert.equal(messaging.sentMessages.at(-1)!.from, line.body.assistantLine, 'the code comes from the account’s own line');
  const verified = await request(app).post('/account/phone/personal/verify').set(headers).send({ code });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.numbers.personal.status, 'active');
  assert.equal((await state()).state, 'application_configured', 'the plane was already there');

  // Notifications: nothing is on until a channel actually works.
  assert.equal((await state()).next, 'notifications');
  await request(app).post('/owner/push/devices').set(headers)
    .send({ subscription: { endpoint: 'https://web.push.apple.com/sam', keys: { p256dh: 'k', auth: 'a' } } });
  const ready = await state();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.next, null);
  // Ready is sticky: removing the only device later doesn't lock the account out of its control plane.
  const [device] = (await request(app).get('/owner/push/devices').set(headers)).body;
  await request(app).delete(`/owner/push/devices/${device.id}`).set(headers);
  const after = await state();
  assert.equal(after.state, 'ready');
  assert.equal(after.steps.find((step: { id: string }) => step.id === 'notifications').done, false, 'but the step shows what is missing');
});

test('onboarding offers existing number, new number, and calling-later paths', async () => {
  const deferred = saas();
  const later = await signUp(deferred.app, { name: 'Later' });
  await request(deferred.app).post('/account/onboarding/identity').set(later.headers).send({ name: 'Later' });
  const invalid = await request(deferred.app).post('/account/onboarding/phone-choice').set(later.headers).send({ choice: 'magic' });
  assert.equal(invalid.status, 400);
  const skipped = await request(deferred.app).post('/account/onboarding/phone-choice').set(later.headers).send({ choice: 'later' });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.phoneChoice, 'later');
  assert.equal(skipped.body.steps.find((step: { id: string }) => step.id === 'phone').done, true);
  assert.equal(skipped.body.next, 'application');

  const dedicated = saas();
  const fresh = await signUp(dedicated.app, { name: 'Dedicated' });
  await request(dedicated.app).post('/account/onboarding/identity').set(fresh.headers).send({ name: 'Dedicated' });
  const selected = await request(dedicated.app).post('/account/onboarding/phone-choice').set(fresh.headers).send({ choice: 'new' });
  assert.equal(selected.body.phoneChoice, 'new');
  assert.equal(selected.body.steps.find((step: { id: string }) => step.id === 'phone').done, false);
  await request(dedicated.app).post('/account/phone/line').set(fresh.headers);
  const withLine = await request(dedicated.app).get('/account/onboarding').set(fresh.headers);
  assert.equal(withLine.body.steps.find((step: { id: string }) => step.id === 'phone').done, true);
  assert.equal(withLine.body.next, 'application');
});

test('existing-number onboarding can verify by voice call and accepts friendly formatting', async () => {
  const { app, numbers } = saas({ pool: ['+15550000000'], purchasable: false });
  const owner = await signUp(app, { name: 'Voice' });
  await request(app).post('/account/onboarding/identity').set(owner.headers).send({ name: 'Voice' });
  await request(app).post('/account/onboarding/phone-choice').set(owner.headers).send({ choice: 'existing' });
  await request(app).post('/account/phone/line').set(owner.headers);
  const started = await request(app).post('/account/phone/personal').set(owner.headers)
    .send({ number: '  +1 (401) 484-2831  ', channel: 'call' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.deepEqual(numbers.verificationCalls.map(({ from, to }) => ({ from, to })),
    [{ from: '+15550000000', to: '+14014842831' }]);
  const code = numbers.verificationCalls[0].code;
  const verified = await request(app).post('/account/phone/personal/verify').set(owner.headers).send({ code });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.ownerNumber, '+14014842831');
});

test('the owner can test the real assistant by having its line call their verified phone', async () => {
  const { app, messaging, numbers } = saas({ pool: ['+15550000000'], purchasable: false });
  const owner = await onboardTenant(app, messaging, { name: 'Test Caller', personal: '+14014842831' });

  const started = await request(app).post('/owner/phone/test-call').set(owner.headers);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.deepEqual({ from: started.body.from, to: started.body.to }, { from: owner.line, to: owner.personal });
  assert.equal(numbers.testCalls.length, 1);
  assert.equal(numbers.testCalls[0].humanOnly, true);
  assert.equal(numbers.testCalls[0].url,
    'https://text-me.vercel.app/webhooks/twilio/voice/test?assistantLine=%2B15550000000');

  const answered = await request(app)
    .post('/webhooks/twilio/voice/test?assistantLine=%2B15550000000')
    .type('form')
    .send({ CallSid: started.body.id, From: owner.line, To: owner.personal, CallStatus: 'in-progress' });
  assert.equal(answered.status, 200, answered.text);
  assert.match(answered.type, /xml/);
  const conversations = await request(app).get('/conversations').set(owner.headers);
  assert.equal(conversations.body.length, 1);
  assert.equal(conversations.body[0].participant.phoneNumber, owner.personal);
});

test('a registered platform Messaging Service can text every onboarding code before an account has a line', async () => {
  const messaging = new FakeMessagingProvider();
  const tenancyStore = new InMemoryTenancyStore();
  const numbers = new FakePhoneNumberClient([], false);
  const sent: Array<{ to: string; body: string }> = [];
  const phoneNumbers = new PhoneNumberService(tenancyStore, numbers, 'https://text-me.vercel.app', messaging, {
    allowSmsVerification: true,
    verificationMessaging: {
      async sendVerification(input) {
        sent.push({ to: input.to, body: input.body });
        return { providerMessageId: 'SM-onboarding' };
      },
    },
  });
  const app = createApp({ repository: new InMemoryConversationRepository(), messagingProvider: messaging, tenancyStore, phoneNumbers });
  const owner = await signUp(app, { name: 'Texted' });
  const started = await request(app).post('/account/phone/personal').set(owner.headers)
    .send({ number: '+1 (401) 484-2831', channel: 'sms' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(sent[0].to, '+14014842831');
  const code = sent[0].body.match(/\b(\d{6})\b/)?.[1];
  assert.ok(code);
  assert.equal((await request(app).post('/account/phone/personal/verify').set(owner.headers).send({ code })).status, 200);
});

test('Twilio Verify can verify an existing number before an account has an assistant line', async () => {
  const messaging = new FakeMessagingProvider();
  const tenancyStore = new InMemoryTenancyStore();
  const numbers = new FakePhoneNumberClient([], false);
  const started: string[] = [];
  const checked: Array<{ to: string; code: string }> = [];
  const phoneNumbers = new PhoneNumberService(tenancyStore, numbers, 'https://text-me.vercel.app', messaging, {
    allowSmsVerification: false,
    verification: {
      async start(to) { started.push(to); },
      async check(to, code) {
        checked.push({ to, code });
        return code === '654321';
      },
    },
  });
  const app = createApp({ repository: new InMemoryConversationRepository(), messagingProvider: messaging, tenancyStore, phoneNumbers });
  const owner = await signUp(app, { name: 'Verified' });

  const status = await request(app).get('/account/phone').set(owner.headers);
  assert.deepEqual(status.body.verificationChannels, ['call', 'sms']);
  const challenge = await request(app).post('/account/phone/personal').set(owner.headers)
    .send({ number: '+1 (401) 484-2831', channel: 'sms' });
  assert.equal(challenge.status, 202, JSON.stringify(challenge.body));
  assert.deepEqual(started, ['+14014842831']);
  assert.equal(messaging.sentMessages.length, 0, 'Verify owns delivery; the relay sender is not used');

  const wrong = await request(app).post('/account/phone/personal/verify').set(owner.headers).send({ code: '000000' });
  assert.equal(wrong.status, 400);
  const approved = await request(app).post('/account/phone/personal/verify').set(owner.headers).send({ code: '654321' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual(checked, [
    { to: '+14014842831', code: '000000' },
    { to: '+14014842831', code: '654321' },
  ]);
  assert.equal(approved.body.numbers.personal.status, 'verified', 'the number waits for a relay line before becoming active');
});

test('phone number lifecycle: codes expire, attempts are limited, and a verified number belongs to one account', async () => {
  const { app, messaging } = saas();
  const a = await onboardTenant(app, messaging, { personal: '+15553330001' });
  const b = await signUp(app, { name: 'Bee' });
  await request(app).post('/account/phone/line').set(b.headers);

  // B can start a verification for A's number (it proves nothing yet), but can never complete it.
  await request(app).post('/account/phone/personal').set(b.headers).send({ number: '+15553330001' });
  const code = lastCode(messaging, '+15553330001');
  const stolen = await request(app).post('/account/phone/personal/verify').set(b.headers).send({ code });
  assert.equal(stolen.status, 409);
  assert.equal(stolen.body.code, 'number_taken');
  assert.equal((await request(app).get('/owner/phone').set(a.headers)).body.ownerNumber, '+15553330001', 'still A’s');

  // Wrong codes are counted; after the limit, a new code is needed.
  await request(app).post('/account/phone/personal').set(b.headers).send({ number: '+15553330002' });
  const realCode = lastCode(messaging, '+15553330002');
  const wrongCode = realCode === '000000' ? '111111' : '000000';
  for (let attempt = 0; attempt < MAX_VERIFICATION_ATTEMPTS; attempt += 1) {
    assert.equal((await request(app).post('/account/phone/personal/verify').set(b.headers).send({ code: wrongCode })).body.code, 'verification_mismatch');
  }
  const locked = await request(app).post('/account/phone/personal/verify').set(b.headers).send({ code: realCode });
  assert.equal(locked.status, 429);
  await request(app).post('/account/phone/personal').set(b.headers).send({ number: '+15553330002' });
  assert.equal((await request(app).post('/account/phone/personal/verify').set(b.headers).send({ code: lastCode(messaging, '+15553330002') })).status, 200);

  assert.equal((await request(app).post('/account/phone/personal').set(b.headers).send({ number: '555-1234' })).status, 400);
  assert.equal((await request(app).post('/account/phone/personal').set(b.headers).send({ number: a.line })).status, 400,
    'an assistant line is never anyone’s personal number');
  assert.equal(VERIFICATION_TTL_MS, 10 * 60 * 1000);
});

test('a verification code expires', async () => {
  let clock = Date.now();
  const messaging = new FakeMessagingProvider();
  const tenancyStore = new InMemoryTenancyStore();
  const { PhoneNumberService } = await import('../src/telephony/phone-number.js');
  const phoneNumbers = new PhoneNumberService(tenancyStore, new FakePhoneNumberClient(), 'https://x.test', messaging, { allowPurchase: true, now: () => clock });
  const app = createApp({ repository: new InMemoryConversationRepository(), messagingProvider: messaging, tenancyStore, phoneNumbers });
  const { headers } = await signUp(app);
  await request(app).post('/account/phone/line').set(headers);
  await request(app).post('/account/phone/personal').set(headers).send({ number: '+15553330009' });
  clock += VERIFICATION_TTL_MS + 1;
  const late = await request(app).post('/account/phone/personal/verify').set(headers).send({ code: lastCode(messaging, '+15553330009') });
  assert.equal(late.status, 410);
  assert.equal(late.body.code, 'verification_expired');
});

test('an assistant line is claimed by exactly one account, even when two claim at once', async () => {
  const { app, tenancyStore } = saas({ pool: ['+15550001000'], purchasable: false });
  const [a, b] = await Promise.all([signUp(app), signUp(app)]);
  const [first, second] = await Promise.all([
    request(app).post('/account/phone/line').set(a.headers),
    request(app).post('/account/phone/line').set(b.headers),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const winner = first.status === 200 ? a : b;
  assert.equal((await tenancyStore.findAssistantLine('+15550001000'))!.accountId, winner.accountId);
  // Claiming again is idempotent for the winner.
  assert.equal((await request(app).post('/account/phone/line').set(winner.headers)).body.assistantLine, '+15550001000');
  // And the store itself refuses a second live owner for one line.
  await assert.rejects(tenancyStore.insertPhoneNumber({
    id: 'pn_dupe', accountId: 'acct_other', kind: 'assistant_line', number: '+15550001000', status: 'active', provider: 'fake',
    verificationStatus: 'provider_verified', verificationAttempts: 0, createdAt: new Date(), updatedAt: new Date(),
  }), PhoneNumberTakenError);
});

test('authorization is principal + membership + account + action, and fails closed', async () => {
  const actions: TenantAction[] = ['account.read', 'account.manage', 'members.manage', 'conversation.read', 'conversation.control',
    'device.register', 'device.manage', 'settings.manage', 'phone.manage'];
  assert.deepEqual(actions.filter((action) => can('member', action)), ['account.read', 'conversation.read', 'conversation.control', 'device.register']);
  assert.deepEqual(actions.filter((action) => !can('admin', action)), ['members.manage']);
  assert.ok(actions.every((action) => can('owner', action)));
  assert.equal(can('nobody' as never, 'account.read'), false);

  const { app, messaging } = saas();
  const owner = await onboardTenant(app, messaging);
  const helper = await signUp(app, { name: 'Helper' });
  assert.equal((await request(app).post('/account/members').set(helper.headers).send({ email: owner.email, role: 'admin' })).status, 201,
    'the helper owns their own (empty) account and can add people to it — not to anyone else’s');
  assert.equal((await request(app).post('/account/members').set(owner.headers).send({ email: helper.email, role: 'member' })).status, 201);

  // The helper switches into the owner's account as a member.
  const switched = await request(app).post('/auth/session/account').set(helper.headers).send({ accountId: owner.accountId });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.account.role, 'member');
  assert.equal((await request(app).get('/conversations').set(helper.headers)).status, 200, 'members can read');
  assert.equal((await request(app).patch('/owner/configuration').set(helper.headers).send({ assistant: { tone: 'warm' } })).status, 403);
  assert.equal((await request(app).post('/account/phone/line').set(helper.headers)).status, 403);
  assert.equal((await request(app).post('/owner/devices/pair/qr').set(helper.headers).send({})).status, 403);
  assert.equal((await request(app).post('/account/members').set(helper.headers).send({ email: 'x@example.test', role: 'member' })).status, 403);

  // Removing the membership takes effect on the very next request, with the same session.
  assert.equal((await request(app).delete(`/account/members/${helper.userId}`).set(owner.headers)).status, 204);
  const removed = await request(app).get('/conversations').set(helper.headers);
  assert.equal(removed.status, 403);
  assert.equal(removed.body.code, 'no_membership');
  assert.equal((await request(app).get('/me').set(helper.headers)).body.activeAccountId, null);
  // Switching into an account you don't belong to is not found.
  assert.equal((await request(app).post('/auth/session/account').set(helper.headers).send({ accountId: owner.accountId })).status, 404);
  assert.equal((await request(app).post('/auth/session/account').set(helper.headers).send({ accountId: helper.accountId })).status, 200);
  // The last owner can't be removed.
  assert.equal((await request(app).delete(`/account/members/${owner.userId}`).set(owner.headers)).status, 409);
});

test('users can belong to several accounts; the API speaks active_account_id, never user id = account id', async () => {
  const { app, messaging } = saas();
  const person = await onboardTenant(app, messaging, { name: 'Morgan' });
  assert.notEqual(person.accountId, person.userId);
  const second = await request(app).post('/accounts').set(person.headers).send({ name: 'Morgan’s Studio' });
  assert.equal(second.status, 201);
  const studio = second.body.activeAccountId as string;
  assert.notEqual(studio, person.accountId);
  assert.equal(second.body.memberships.length, 2);
  assert.equal(second.body.onboarding.state, 'account_created', 'a new account starts its own setup');
  // The session now operates on the studio: its own (empty) control plane.
  const plane = (await request(app).get('/owner/control-plane').set(person.headers)).body;
  assert.equal(plane.account.id, studio);
  assert.equal(plane.plane.status, 'setup');
  assert.equal(plane.plane.assistantLine, null);
  // Back to the first account: everything is where it was.
  const back = await request(app).post('/auth/session/account').set(person.headers).send({ accountId: person.accountId });
  assert.equal(back.body.onboarding.state, 'ready');
  assert.equal((await request(app).get('/owner/control-plane').set(person.headers)).body.plane.assistantLine, person.line);
});

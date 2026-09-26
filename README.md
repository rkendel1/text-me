# text-me

Minimal inbound-call conversation service for Twilio-style voice webhooks.

## Environment

Copy `.env.example` and set:

- `DATABASE_URL`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `OWNER_PHONE_NUMBER`
- `PUBLIC_BASE_URL`

## Run locally

```bash
npm install
npm run dev
```

The service exposes:

- `POST /webhooks/twilio/voice`
- `POST /webhooks/twilio/status`
- `GET /conversations`
- `GET /conversations/:id`
- `POST /conversations/:id/turns` (with `callbackId` and audio/text input)

Conversation turns are provider-independent. Speech, conversation-model, and
voice providers can be replaced through `createApp` options; deterministic fake
providers are used by default for local testing. Transcript, model, and voice
milestones are stored in the append-only conversation event log.

When `NODE_ENV` is not `production`, local webhook simulation is also available:

- `POST /webhooks/fake/voice`
- `POST /webhooks/fake/status`

## Test

```bash
npm test
```
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
- `OWNER_AUTH_TOKEN`

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


## Mac bridge runtime

The production backend now persists owner devices, pairing credentials, device sessions,
configuration revisions, authorized chats, and queued Mac Messages deliveries in the
same PostgreSQL database as conversations.

To run the macOS bridge against a real backend after building:

```bash
BACKEND_URL=http://localhost:3000 \
PAIRING_CREDENTIAL='attn://pair/...' \
PHOTON_CLIENT_MODULE=/absolute/path/to/photon-client.js \
npm run bridge:macos
```

The bridge stores its restart-safe session token and message checkpoint locally and
reuses them on reboot.

## Test

```bash
npm test
```
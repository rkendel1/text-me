# Owner API: the contract for every owner surface

The iPhone web app is the default owner surface. A future native iOS app, or
any other owner device, uses exactly the same API. **The server is the only
authority.** A client never holds AI, telephony, durable conversation state or
owner authority. It renders state, registers for notifications and sends
commands.

All routes need `Authorization: Bearer <owner token>`. EventSource can't set
headers, so the live streams also accept `?token=`.

## 1. Authentication

| | |
|---|---|
| `GET /conversations` → `200` | the token is valid |
| any route → `401` | sign in again |

The owner token identifies the owner. Everything below is scoped to that owner
server-side, and the ids a client sends are always re-checked against it.

## 2. Conversation state

| Route | Returns |
|---|---|
| `GET /conversations` | Now/inbox: each conversation with `participant` (name, reason), `ownerRequest`, `lastCallerMessage`, `lastAssistantMessage`, `runtime`, `voice.live` |
| `GET /conversations/:id` | The live screen: everything above plus `messages` (the transcript), `eventLog`, `durationSeconds`, `startedAt` |

`runtime` is the authoritative state of the conversation's assistant:

```json
{
  "runtimeId": "rt_…", "revision": 7,
  "status": "active | paused | owner_needed | takeover | text_active | ended | idle",
  "mode": "automatic | ask_owner | owner_only",
  "state": "listening | transcribing | thinking | speaking | waiting_for_owner | …",
  "voiceEnabled": true, "transcriptionEnabled": true, "verbosity": "short | normal | detailed",
  "temporarySettings": true, "overriddenFields": ["verbosity"]
}
```

## 3. Owner attention

Attention is what the conversation wants from the owner. It's durable, and it
exists whether or not any device is registered.

| Route | |
|---|---|
| `GET /owner/attention?open=true` | Open items, newest first: `id`, `conversationId`, `type`, `priority`, `title`, `body`, `actions`, `status`, `url` |
| `POST /owner/attention/:id/opened` | The owner saw it (e.g. tapped the notification) |
| `POST /owner/attention/:id/dismiss` | The owner dismissed it |
| `POST /owner/attention/:id/actions` `{ action: "take_over" }` | Take over the conversation this attention belongs to |
| `POST /owner/attention/:id/actions` `{ action: "reply", body }` | Answer it; the assistant relays the answer to the caller |

Types: `conversation_started`, `assistant_needs_owner`,
`conversation_transferred`, `conversation_completed`, `owner_message`,
`error`. Statuses: `pending → delivered → opened → acted | dismissed |
resolved`.

**Actions never trust a conversation id from the client.** The server resolves
the conversation from the attention record, checks that the owner owns it,
and runs the action as a durable runtime command.

## 4. Runtime commands

| Command | Route |
|---|---|
| `start` / `stop` / `pause` / `resume` | `POST /conversations/:id/runtime/{start,stop,pause,resume}` |
| `take_over` / `return_to_assistant` | `POST /conversations/:id/runtime/{takeover,return-to-assistant}` |
| `interrupt` | `POST /conversations/:id/runtime/interrupt` |
| `transition_to_text` | `POST /conversations/:id/runtime/transition-to-sms` |
| `adjust_interaction` | `PATCH /conversations/:id/runtime` with any of `aiMode`, `askOwnerWhen`, `verbosity`, `responseStyle`, `voiceEnabled`, `transcriptionEnabled`, `smsTransitionEnabled`, `allowCommitments`, `allowScheduling`, `allowCallerFollowups`, `customInstructions` |
| reset (an `adjust_interaction`) | `DELETE /conversations/:id/runtime/overrides` |
| owner reply | `POST /conversations/:id/messages` `{ body, idempotencyKey }` |

Every command accepts an optional `commandId` and `expectedRevision`:

- **Idempotent and replay-safe:** reusing a `commandId` never runs the command
  twice. A replayed rejected command returns its original error.
- **Stale protection:** a mismatched `expectedRevision` is rejected (`409`).
  Refresh and retry.
- **Persisted:** `GET /conversations/:id/runtime/commands` returns each command
  with `runtimeId`, `status` (`accepted → applied | noop | rejected →
  applied_live`), `processedAt` and `appliedLiveAt`. `applied_live` means the
  live call acted on it, on whichever server instance holds the call.
- **Conversation-scoped:** `adjust_interaction` never changes account defaults
  (`GET/PATCH /owner/configuration`).

## 5. Push registration

| Route | |
|---|---|
| `GET /owner/push/config` | `{ publicKey }`, the VAPID key for Web Push |
| `POST /owner/push/devices` | Register or refresh a device |
| `GET /owner/push/devices` | This owner's devices (tokens are never returned) |
| `DELETE /owner/push/devices/:id` | Revoke |
| `POST /owner/push/test` | Send a test notification to this owner's devices |

A device record has `platform` (`web` today; `ios` and `macos` are reserved
in the schema), a device token (a Web Push subscription today, an APNs token
for a future native app), `capabilities`, `status` and `lastSeenAt`.
Capabilities are only what the server can actually do: `push` and
`deep_link` for web, plus `interactive_notification` only where the browser
shows action buttons. iOS web push does not, so the tap itself carries the
intent. `live_activity` is reserved for a native app and is never reported
for web.

**Notification payload** (kept minimal; open the app for details):

```json
{
  "title": "Jordan needs you",
  "body": "“Can you do Friday at 2?”",
  "tag": "att_…",
  "url": "/conversations/conv_…/live?attention=att_…",
  "actions": [{ "action": "reply", "title": "Reply" }, { "action": "take_over", "title": "Take Over" }]
}
```

## 6. Live conversation

| Route | |
|---|---|
| `/conversations/:id/live` | Deep link: opens that one live conversation directly, with no inbox step. `?attention=` marks it opened; `?intent=take_over\|reply` performs the tapped action |
| `GET /owner/events` | Server-sent events for **all** of the owner's conversations, including `runtime.attention` for new attention |
| `GET /conversations/:id/runtime/events` | Server-sent events for one conversation |

Streams are a projection of state in Neon, not a source of truth. After any
event, re-read the conversation with `GET /conversations/:id`.

## 7. Diagnostics (not consumer UI)

`GET /conversations/:id/audit` returns the full id-linked timeline:
conversation, turn, response, command, attention, notification delivery and
provider ids. Keep it out of consumer screens.

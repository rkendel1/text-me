# MCP endpoint

Just Text Me is an MCP server whose tools are **projections of its AppPort capabilities**. MCP is a transport, not an authority:

```
MCP client ─► POST /mcp (Express, existing app) ─► JTM bearer-session auth ─► AppPort Session
           ─► @appport/mcp ─► AppPort handleRequest (validate → authorize → idempotency/deadline) ─► call.* capability
           ─► CallSessionService (tenant-scoped) ─► outbound policy ─► CallProvider (Twilio)
```

There is no MCP implementation in this repository. `src/appport/mcp.ts` selects which capabilities are projected (`call.*`) and maps the
authenticated caller to an AppPort session. `src/http-app.ts` mounts the package's `(Request) => Response` handler at `/mcp` (route
conventions: top-level resource paths, `/api/internal/*` for cron only).

## Packages (published, exact versions)

`@appport/mcp@1.1.0`, `@appport/core@1.0.4`, `@appport/protocol@1.0.3`, `@appport/authorization@1.0.3`, `@appport/schema@1.0.3`,
`@modelcontextprotocol/sdk@1.31.0` (the SDK is also a dev dependency, for the test client). `npm ls @appport/protocol --all` shows a single,
deduped `1.0.3`. Check it after any AppPort bump.

## Connecting

Transport: MCP Streamable HTTP, stateless, JSON responses (`POST` only; `GET`/`DELETE` return `405`).

```ts
const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('https://<host>/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${sessionToken}` } },
}));
```

`sessionToken` is a JTM session token (the same bearer token the API uses: `POST /auth/sessions`). OAuth is not implemented.

## Authentication and authorization

- Authentication is JTM's existing session system. `/mcp` resolves the bearer token to a live session, then re-checks the account membership
  (as every API route does), and builds the AppPort `Session` with `appPortSessionFor`: account in `attributes.accountId`, permissions from the role.
- No credential → the request is dispatched anonymously and AppPort refuses every call (`UNAUTHORIZED`). An invalid/expired/revoked token →
  `UNAUTHORIZED`; a removed member → `FORBIDDEN`. The caller cannot supply identity or account in arguments or `_meta`.
- `tools/list` (and `initialize`) is not filtered by caller; it lists what the application publishes. **Authorization happens at invocation.**
- Tenant isolation is in the capability handlers: the account always comes from the session. Another account's call is `NOT_FOUND`, identical to
  a missing one, with no call data in the error.

## Tools

`call_create`, `call_get`, `call_list`, `call_end` (from `call.create`, `call.get`, `call.list`, `call.end`); schemas, descriptions and required
permissions are the capabilities' own. Results carry `structuredContent`; failures are `isError` results with the AppPort code in
`_meta["dev.appport/error"]`.

Metadata (`tools/call` `_meta`): `dev.appport/idempotencyKey`, `dev.appport/timeoutMs`, `dev.appport/traceId` reach the capability unchanged
(the trace id is echoed on the result). Idempotency is decided by JTM's durable CallSession, not by an MCP cache; MCP adds none.
The timeout becomes the request deadline, which `call.get`'s bounded wait honours. A client disconnect aborts the capability's `signal`;
that is a request cancellation, not a guarantee that work stops (it stops only where a handler checks the signal). The endpoint is stateless, so an
MCP `notifications/cancelled` (a separate HTTP request) cannot reach a request held by another invocation; disconnecting does.

## Outbound calls are not available over MCP

`call_create` with `direction: "outbound"` is refused by the existing outbound policy (`FORBIDDEN`, `details.reason = "transport_not_supported"`),
whatever `OUTBOUND_AGENT_CALLS` says and whatever the caller's permissions: only the in-process transport may place calls. Nothing is created or
dialed, and the telephony provider is never contacted. Inbound `call_create` is reserved for the telephony webhook (`call.ingest`), which MCP
sessions never hold. MCP is not on the Twilio webhook path; inbound calls are unchanged.

## HTTP behaviour and limits

Body ≤ 256 KB (`413`), malformed JSON → JSON-RPC `-32700` (`400`), unknown method `-32601`, unknown tool `-32602`, rate limit 120/min/IP,
a browser `Origin` other than the app's own is refused (`403`; credentials are headers, never cookies). Logs contain method/path/status only;
call logs mask phone numbers; tokens are never logged. Works on Vercel as-is: no sessions, sockets or process state.

## Before autonomous outbound calling can be enabled

Consent, calling-window, recording and AI-disclosure policy and do-not-call handling (see call-session.md); a deliberate, reviewed change to
the transport rule in the outbound policy plus the `OUTBOUND_AGENT_CALLS` gate; scoped credentials for agents (today a bearer token carries its
member's full role); per-agent rate/spend limits; and OAuth (or equivalent) if third-party agents connect.

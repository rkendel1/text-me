# Just Text Me launch audit

## Public site

`/` is an unauthenticated Just Text Me landing/sign-in page. It describes the
product and the single $19.99/month plan; `/signup`, `/signin`, `/checkout`,
`/setup`, `/app`, and `/billing` are refresh-safe entry points.

## Billing

Stripe is the billing authority. `STRIPE_PRODUCT_ID` is fetched server-side and
its recurring default price is used for Checkout; no price or secret key is
embedded in client code. Each account stores its Stripe customer and
subscription IDs. Checkout leaves accounts `pending`; signed,
idempotent-by-state webhooks move them through `active`, `past_due`, `unpaid`,
`incomplete`, and `canceled`. `/billing` exposes status and the Stripe portal
handles payment methods, cancellation, and recovery.

## Account and setup

Signup creates a user, membership, account, provider configuration, and a
pending subscription in durable storage. Setup is account-scoped and the
control plane is only reached through the authenticated membership. Numbers,
devices, notifications, and planes are stored per account.

## iOS

Onboarding explicitly identifies the iPhone app as `not_yet_available` and does
not block activation or control-plane access. The future App Store URL belongs
in the notifications setup step.

## Security and scale

Stripe secret/webhook keys are server-only; publishable/shareable keys are not
authorization credentials. Every customer resource is authorized through the
authenticated user and account membership. Account and billing state is
persisted in Postgres, so checkout, webhook, and control-plane requests may be
handled by different instances.

`NEXT_PUBLIC_SHAREABLE_KEY` is intentionally browser-safe platform
configuration only; it is not used for authentication or tenant authorization.
`STRIPE_PUBLISHABLE_KEY` may be exposed for Stripe.js integrations, while
`STRIPE_SECRET_KEY` and `STRIPE_MCP_KEY` remain server-only.

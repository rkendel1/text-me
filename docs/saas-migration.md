# Migrating a single-owner deployment to accounts

Before accounts existed, one deployment belonged to one person, named by
environment variables. This one-time migration turns that person into an
ordinary account on the multi-tenant model, so they sign in and use the
product through exactly the same paths as a new customer. Afterwards nothing
reads the old variables, and the deployment refuses to start while they are
still set.

| Before | After |
|---|---|
| `OWNER_ID` (usually `owner`) on every row | **Account** `acct_…` (deterministic from the old id) owning every row |
| `OWNER_AUTH_TOKEN` (shared access key) | **User** with your email and a password; **Membership** role `owner` |
| `OWNER_PHONE_NUMBER` | **PhoneNumber** `personal`, `verified` (`verification_status: migrated`), then `active` |
| `TWILIO_PHONE_NUMBER` (or the Twilio account's only number) | **PhoneNumber** `assistant_line`, verified against Twilio and `active` |
| Settings, devices, Mac bridge, conversations, attention, commands, deliveries | Re-owned by the account, unchanged otherwise |
| One configuration flag for "set up" | Account onboarding state, evaluated by the same state machine (`ready`) |
| SMS fallback to your number (always on) | Kept on (`messages.smsEnabled`) |
| Access-key sessions | Dropped: every device signs in again with email and password |

## Run it

1. Deploy nothing yet. On a machine with the repository (`npm install`),
   point the migration at the production database with the **platform**
   credentials and pass what used to be in the customer variables:

   ```bash
   DATABASE_URL='postgres://…'            # Neon: the pooled or unpooled URL
   TWILIO_ACCOUNT_SID=AC… TWILIO_AUTH_TOKEN=…
   PUBLIC_BASE_URL=https://<project>.vercel.app
   MIGRATION_OWNER_PASSWORD='a new password, 10+ characters'
   npm run migrate:legacy -- \
     --email you@example.com --name "Randy" \
     --personal-number "$OWNER_PHONE_NUMBER" \
     --assistant-line "$TWILIO_PHONE_NUMBER"      # omit if the Twilio account has one number
     # --legacy-owner-id "$OWNER_ID"              # only if you changed OWNER_ID
   ```

   It prints the account id, what it moved, and the onboarding state
   (`ready`). It is deterministic and idempotent: running it again changes
   nothing and prints the same ids.

2. In Vercel → Settings → Environment Variables, **delete**
   `OWNER_AUTH_TOKEN`, `OWNER_PHONE_NUMBER`, `OWNER_ID` and
   `TWILIO_PHONE_NUMBER`. Deploy.

3. Open the deployment and sign in with the email and password. Settings,
   conversations and devices are where they were. Sign in again on each
   device (the iOS app included); turning notifications on re-registers the
   device for the account.

4. Check `GET /health/ready` and run the acceptance journey:
   `ACCEPTANCE_PASSWORD=… npm run acceptance -- --url https://<project>.vercel.app --email you@example.com`.

If the deployment starts while an old variable is still set, it shows the
setup page listing exactly which variables to remove.

## What it does, in order

1. Creates the schema (and renames every legacy `owner_id` column to
   `account_id` in place).
2. Creates the user (scrypt-hashed password) and the account with its owner
   membership, subscription and provider configuration. Ids are derived from
   the old owner id and the email, so they are the same on every run.
3. In one transaction, re-owns every row whose `account_id` is the old owner
   id (or empty), sets the user on existing devices, and drops the access-key
   session table.
4. Through the same services a new customer uses: sets the name if missing,
   adopts the assistant line (verified against Twilio, webhooks pointed at the
   deployment), attests the personal number, creates the plane, and evaluates
   onboarding.

Code: `src/tenancy/legacy-migration.ts` (the migration),
`src/tenancy/migrate-legacy-cli.ts` (the command). Test:
`test/legacy-migration.test.ts` builds a database with the old schema and
data, migrates it twice, then signs in on a deployment with no customer
variables and checks everything is there, that new calls to the old line land
in the account, and that a brand-new customer on the same deployment sees none
of it.

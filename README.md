# Trust Ajo

Trust Ajo is a local prototype for Ajo savings groups, contribution records, the Kudi Link Financial Passport, payment-reference checks, and a member marketplace. See [`PRODUCT_BRIEF.md`](PRODUCT_BRIEF.md) for the problem hypothesis, prototype boundaries, build priorities, and answers to likely judge questions.

## Run the app

Install Node.js 20.19 or newer, then open this folder in VS Code. In its terminal, run:

```powershell
npm install
npm run dev
```

Open http://localhost:4173. The Node.js server provides the frontend and API together. Keep the terminal open while using the app; press Ctrl+C to stop the server.

By default, Trust Ajo runs locally with seeded, in-memory demo data and does not need a database. Changes last for the current server process and reset when it restarts. Existing local JSON or MongoDB data is not uploaded automatically.

To start a fresh copy, stop any existing `npm run dev` process with Ctrl+C first. If port 4173 is occupied, use another port, for example `$env:PORT=4174; npm run dev` in PowerShell, and open the matching localhost address.

## Set up Supabase Auth

1. Create or choose a Supabase project.
2. In **Authentication → URL Configuration**, set the Site URL to `http://localhost:4173` and add that URL to Redirect URLs. Add your deployed app's exact origin before deploying.
3. In **Authentication → Sign In / Providers**, enable Email. Supabase's email confirmation links return to Trust Ajo, and the app establishes the session after confirmation.
4. In **Project Settings → API Keys**, copy the project URL and publishable key (or legacy `anon` key) into `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `.env`.
5. Run `npm run dev`. Supabase Auth handles signup, email confirmation, sign-in, and sign-out. The Node API validates the access token with Supabase before it serves protected app endpoints. Without the Auth key, local demo sign-in remains available.

The publishable key is designed for client use. Keep `.env` private regardless, and never expose a Supabase secret key in `public/` or a `NEXT_PUBLIC_` variable.

## Persist app data in Supabase

1. Create a server-side secret key (`sb_secret_...`) in **Project Settings → API Keys**. Keep it private; it bypasses row-level security.
2. Run the SQL in [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL Editor.
3. In **Integrations → Data API**, expose the `public` schema so the server-side client can reach `app_state`. Grant access only to `service_role`; the schema enables RLS and does not grant table access to `anon` or `authenticated`.
4. Set `SUPABASE_SECRET_KEY` in `.env` and restart the server. Without this secret, Auth still works but app data stays in the in-memory demo store.

The prototype stores app data in one JSONB row, so the API's per-user authorization is enforced in the Node server. Production use needs per-user tables and row-level security policies before storing customer data.

## Flutterwave sandbox checkout

1. Create a Flutterwave account and switch its dashboard to **Test mode**.
2. Copy the **test secret key** into `FLW_SECRET_KEY` in `.env`. The app accepts only a `FLWSECK_TEST-` key, so a live key cannot start checkout.
3. Set `APP_BASE_URL=http://localhost:4173`, then restart the app.
4. Open a circle you belong to and choose **Pay with Flutterwave · test**. Flutterwave hosts the checkout; the server verifies the returned transaction reference, status, exact amount, and NGN currency before recording a contribution.

Without a test key, the app offers a clearly labelled demo contribution that records no payment. Flutterwave test transactions do not move real money. The local callback does not require a webhook. For a deployed environment, configure `FLW_SECRET_HASH` and a public HTTPS webhook URL; the webhook is signature-checked and the transaction is verified again before it updates the ledger.

Circle organizers can share the invite code shown in circle details and rotate it if it is exposed. New codes are 16 characters; the seeded demo circles use shorter sample codes. Invitees review the amount, due date, frequency, capacity, and payout order before confirming. Joining checks available capacity and compares recurring due dates over the next year; the server repeats the check on confirmation. Contributions open only when the circle is full and the agreed due date has arrived. Duplicate entries are rejected, and a cycle advances after every member has contributed.

## Included

- Landing page before sign-in and registration, with the original TA brand mark.
- Local account registration and sign-in, hashed passwords, and 12-hour HttpOnly session cookies.
- Ajo circles with weekly or monthly rules, private invite codes, due-date conflict checks, payout order, contribution history, and a ledger.
- Kudi Link Financial Passport with illustrative indicators and permission-limited share links that expire after 24 hours and can be revoked.
- Trust Engine checks against synthetic payment references.
- Member marketplace with local demo orders.
- Theme and profile settings, plus saved preferences for future reminders, weekly summaries, and Passport-access alerts. No notifications are sent by this prototype.
- Activity history and privacy trail.

## Demo references

`TA-DEMO-730145` matches ₦30,000. `TA-DEMO-110948` matches ₦18,500. Both are synthetic records.

## Prototype boundary

This is not a bank, wallet, escrow service, or regulated financial product. The local demo does not hold funds or initiate transfers. Flutterwave integration is sandbox-only; payouts are not automated.

Email, BVN, and NIN steps are mock flows. Do not enter real identity numbers, bank details, or real card details. Use only Flutterwave test credentials and test payment data. A production system needs properly modeled and indexed tables, Supabase Auth and per-user RLS, durable audit and payment records, webhook reconciliation, operational monitoring, a reviewed payout model, and required compliance approval before handling customer money or identity data.

The Supabase prototype stores application state in a single JSONB row for simple development. This keeps the current prototype behavior but is not designed for concurrent production traffic or large data volumes. A production system should move each entity to properly indexed tables, use Supabase Auth, and enforce user-specific database access controls.


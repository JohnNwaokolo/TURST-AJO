# Trust Ajo

Trust Ajo is a prototype for a simulated Ajo wallet and community. Members can search public Ajo offers, discuss terms, form private groups, and track sample wallet activity and group rotations. See [PRODUCT_BRIEF.md](PRODUCT_BRIEF.md) for product scope and prototype limits.

## Run locally

Use Node.js 20.19 or newer:

```powershell
npm install
npm run dev
```

Open http://localhost:4173. The default app uses seeded in-memory data; changes reset when the server restarts. Stop the server with Ctrl+C.

## Optional Supabase Auth

1. Create a Supabase project and enable Email under **Authentication → Sign In / Providers**.
2. Set the local Site URL and Redirect URL to `http://localhost:4173`.
3. Put `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `.env`.
4. Restart the app. Never expose a Supabase secret key in frontend code.

## Optional development persistence

The current prototype persists one application-state JSONB row through a server-side Supabase secret. Apply [`supabase/schema.sql`](supabase/schema.sql), expose the `public` schema through the Data API, grant table access only to `service_role`, set `SUPABASE_SECRET_KEY` in `.env`, and restart. This adapter is for development only; it is not suitable for real member data or concurrent production traffic.

## Main prototype flows

- Sample wallet funding and withdrawals with illustrative flat fee bands.
- Ajo contribution debits and payout credits represented in sample wallet records.
- Public Ajo offers searchable by text, amount range, frequency, minimum seats, and minimum turns.
- Public comments and interest, followed by a private Ajo group with its own member chat.
- Invite codes, due-date conflict checks, payout swaps requiring member acceptance, and rotation continuation choices.
- Mock KYC states, sample guarantor requests with explicit sample accept/decline, sample dispute evidence, and activity ratings gated by 20 completed contribution records.
- Activity record filters for search, category, money direction, status, dates, and amount range.

The wallet architecture described in the product brief is a proposal only. This prototype records fictional local wallet activity and does not connect to a payment partner. Sample guarantor acceptances are not legal commitments.

The app does not connect debit cards, process live payments, hold funds, send payouts, verify real KYC, or calculate creditworthiness. Use fictional sample data only. The fee bands and any pitch projections are assumptions for discussion, not approved pricing or forecasts.

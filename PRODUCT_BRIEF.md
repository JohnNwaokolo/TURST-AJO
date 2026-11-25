# Trust Ajo: product brief

## The problem we are testing

People use rotating savings circles to save with people they know. The group depends on clear agreements: who is in, how much each person contributes, when contributions are due, and whose turn comes next. When that information is spread across messages, memory, or separate notebooks, members can struggle to check the same record or catch a schedule conflict before joining.

Trust Ajo is testing whether a simple, member-visible record can reduce that uncertainty while keeping the group in charge of its own rules. This is a product hypothesis, not a measured impact claim. The next step is to test it with savings-circle members and organizers in Nigeria, including people who use low-cost phones or unreliable connections.

## Who it is for

- Members of informal rotating savings groups (Ajo, Esusu, Adashe, and similar circles).
- Organizers who coordinate contribution dates, invite members, and keep the rotation understandable.
- Small traders and makers who want a clearer record of their group participation.

## What the prototype does

- Creates weekly or monthly circles with a contribution amount, first due date, capacity, and visible payout order.
- Lets invitees review those terms before joining. It checks capacity and same-day due-date conflicts, then checks again when the member confirms.
- Lets an organizer rotate an invite code if it has been shared too widely.
- Prevents duplicate entries for the same member and cycle, rejects contributions before the agreed due date, and advances the rotation after all members have contributed.
- Records demo contributions locally, or starts a Flutterwave sandbox checkout when a test key is configured. A provider transaction is checked server-side before it is added to the ledger.
- Shows a Financial Passport record count and clearly labeled synthetic figures for the sample account. Passport links allow selected profile sections, expire after 24 hours, and can be revoked.
- Keeps sample payment-reference checks, sample marketplace products, and demo orders visibly within the prototype boundary.

## What the prototype does not claim

- It is not a wallet, bank, escrow service, credit bureau, lender, or payment recipient.
- It does not send money to the person whose turn it is. The payout order is a record; payouts remain manual and outside the app.
- A demo contribution is a member-entered ledger item, not independent proof that money moved. Flutterwave test mode uses test transactions only.
- It does not connect bank accounts, calculate creditworthiness, make lending decisions, or verify email, BVN, or NIN with an identity provider.
- Reminder, digest, and Passport-access settings are saved preferences only; this prototype does not send notifications.
- The Supabase option is a development adapter using one shared JSONB application-state row and a server-side secret key. It is not ready for real member data or concurrent production traffic.

## Likely judge questions

### What exact problem does it solve?

It helps a savings circle agree on the commitment before a person joins, spot recurring due-date clashes, and review the same contribution and payout-order record. The measurable outcome to test is fewer missed or disputed contributions and fewer avoidable schedule conflicts, compared with the group's current process.

### Why is this more than a group chat?

A chat is useful for discussion, but the prototype makes the current amount, recurring due date, membership capacity, contribution count, and payout order visible together. Joining requires reviewing those terms, and the server checks the schedule again at confirmation.

### Does the app hold or transfer money?

No. Local demo entries do not move money. Optional Flutterwave checkout is restricted to test credentials. The app verifies a provider transaction before recording a test contribution, but it does not automate payouts.

### What does the Financial Passport prove?

At this stage, nothing beyond what the app itself has recorded. It is not a credit score or independently verified financial history. The sample account contains synthetic figures; new accounts have no bank or income connection. The sharing flow is permission-limited, time-limited, and revocable, but a recipient link is a bearer link that anyone holding it can open.

### How are members protected from a circle clash?

Before joining, a person sees the amount, due date, frequency, capacity, and payout order. The app compares scheduled dates over the next year against circles that person already belongs to. It repeats the check when they confirm, so a stale preview cannot bypass a new conflict.

### How will the team know the idea works?

Run small, opt-in pilots with existing groups. Compare missed contributions, schedule clashes, time spent reconciling records, and member-reported trust before and after. Include members who use shared phones, have limited data, or prefer a language other than English. Do not claim impact until the pilot measures it.

### What must happen before handling real data or money?

Conduct member research and threat modeling; define consent, correction, dispute, and group-exit flows; move to normalized tenant-scoped tables with per-user authorization; use a reviewed authentication and recovery system; complete payment-provider sandbox and webhook reconciliation; define a lawful, operational payout model with an authorized partner; and obtain security, privacy, accessibility, and compliance review. Keep credit decisions outside the product unless the data, governance, consent, validation, and appeal process are separately designed and tested.

## Build priorities

1. Validate the problem and language with real circle members and organizers before expanding features.
2. Add member consent and correction flows: confirm group rules, report an incorrect entry, leave a circle safely, and raise a dispute.
3. Replace prototype storage and authentication with normalized Supabase tables, Supabase Auth, and tested row-level access policies.
4. Add durable payment idempotency and reconciliation, then evaluate an authorized payout partner and a clear failure/complaint process.
5. Make reminders real only after adding consent, delivery controls, and a reliable notification service.
6. Test small-screen layouts, keyboard and screen-reader navigation, low-bandwidth behavior, and security boundaries with users.

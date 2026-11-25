# Trust Ajo product brief

## Product hypothesis

Trust Ajo combines a simulated wallet, a public Ajo offer board, and private Ajo groups. Members can find groups that fit their contribution range, discuss terms in public before joining, then coordinate contributions and payout order in a private group space. This is a prototype hypothesis, not evidence of reduced defaults, increased trust, or business impact.

## Prototype experience

- A sample wallet shows a balance, simulated deposits and withdrawals, illustrative fee bands, Ajo contribution debits, payout credits, and an activity ledger. No funds move.
- Members can post public Ajo offers and search/filter them by contribution range, frequency, minimum seats, minimum turns, and text. They can comment and express interest. The author can form a private group with interested registered members; each private group has its own member-only chat.
- Ajo groups have a contribution, cadence, due date, capacity, payout order, invite code, private chat, payout-swap requests, and a member-by-member choice after each full rotation.
- A swap changes the schedule only after the receiving member accepts. A completed rotation prompts members to continue, recruit replacements, or leave. The prototype records those choices.
- The mock KYC screen shows sample email/BVN/NIN statuses and a sample missed-payment report. It never collects identity numbers or documents and cannot track or recover a person.
- The sample guarantor workflow records a request, named sample account, maximum amount, and explicit accept/decline response. It sends no real invitation, verifies no identity, moves no money, and creates no legal obligation.
- A member participation rating stays hidden until at least 20 completed contribution records. It uses sample on-time contribution history and is not a credit score or guarantee.
- Activity records can be filtered by search text, category, direction, record status, date range, and amount range.

## Proposed real-wallet architecture (not implemented)

Each app user would map to a distinct customer or account reference with a suitably authorised payment partner. Trust Ajo's server would initiate funding and withdrawal requests, verify signed partner events, use idempotency keys to prevent duplicate ledger postings, keep an append-only transaction record, and reconcile the app ledger against partner reports. A pending request is not a confirmed payment. Before launch, legal and compliance review must confirm who may hold funds and which partner arrangement fits the exact flow. The prototype wallet remains fictional.

## Guarantor design questions before production

The guarantor must be a separate person who independently reviews the specific member, Ajo group, maximum liability, trigger, duration, claim and dispute process, and any release conditions. Acceptance must be explicit and recorded against the version of the terms shown. Decide whether capacity assessment is necessary and proportionate, how a guarantor can challenge a claim, and whether the requirement would exclude or pressure members. Obtain Nigerian legal and privacy review before collecting identity or financial data or presenting the promise as enforceable.

## Pitch economics: editable scenario model

These scenarios are arithmetic examples, not a market forecast, validated pricing, or a claim about customer demand. They assume the flat fee bands shown in the prototype, a 0.30% comparison fee on each wallet deposit or withdrawal, and that all shown transaction values are processed without provider cost. Real processing fees, failed transactions, taxes, support, fraud, compliance, and other costs are not included, so net results below are only contribution after the illustrative operating-cost assumption.

| Scenario | Active users | Fee events / user / month | Average fee-event amount | Monthly turnover | Monthly flat-band fee revenue* | Monthly 0.30% fee revenue | Monthly operating-cost assumption |
|---|---:|---:|---:|---:|---:|---:|---:|
| Early | 1,000 | 2 | ₦20,000 | ₦40,000,000 | ₦60,000 | ₦120,000 | ₦1,200,000 |
| Base | 10,000 | 3 | ₦20,000 | ₦600,000,000 | ₦900,000 | ₦1,800,000 | ₦2,000,000 |
| Growth | 40,000 | 4 | ₦20,000 | ₦3,200,000,000 | ₦4,800,000 | ₦9,600,000 | ₦4,000,000 |

*At a ₦20,000 event the prototype flat fee is ₦30. Turnover is the sum of deposits and withdrawals; it is not revenue. Under the percentage comparison, the fee is 0.30% of each event’s amount.

For an illustrative ₦20,000,000 initial investment, and assuming each scenario’s monthly revenue and cost persist for twelve months, annual operating contribution (fee revenue minus assumed operating costs) is:

| Scenario | Flat-band annual contribution | Flat-band ROI | 0.30% annual contribution | 0.30% ROI |
|---|---:|---:|---:|---:|
| Early | −₦13,680,000 | −68.4% | −₦12,960,000 | −64.8% |
| Base | −₦13,200,000 | −66.0% | −₦2,400,000 | −12.0% |
| Growth | ₦9,600,000 | 48.0% | ₦67,200,000 | 336.0% |

Formula: monthly turnover = active users × monthly fee events × average event amount. Fee revenue = events multiplied by the applicable fee. Annual operating contribution = 12 × (monthly fee revenue − monthly operating cost). Scenario ROI = annual operating contribution ÷ ₦20,000,000. This simplified ROI excludes investment recovery, financing, taxes, partner fees, and changes in user growth or transaction behavior; it must not be presented as investor return without a fuller financial model.

A defensible market sizing model still needs sourced estimates for reachable Ajo participants, serviceable locations, adoption, transaction frequency, typical amount, partner pricing, and operating costs. Calculate a serviceable annual transaction volume from evidenced reachable participants × expected fee events × average amount, then show revenue separately from volume. Validate every input before pitching it as a projection.

## What this prototype does not do

- It is not a bank, live wallet, escrow service, lender, credit bureau, or payment recipient. Sample balances and ledger entries are fictional.
- It does not connect debit cards or bank accounts, send live deposits or withdrawals, automatically collect real contributions, or pay out real money.
- It does not verify identity with an external provider, independently verify payment performance, calculate creditworthiness, create enforceable guarantor commitments, or guarantee repayment.
- The rating is a small sample participation indicator. It must not be represented as a credit or default-risk score.
- The local demo store is in-memory. The optional development Supabase adapter stores the application state in one JSONB row and is not ready for real customer data or concurrent production traffic.

## Pilot measures

With consent and sample-safe operations, evaluate offer-to-group conversion, time to fill a group, missed contributions, swaps, group continuation choices, disputes, member-reported trust, and the time organizers spend reconciling records. Include people using low-cost phones, limited data, or shared devices. Do not claim an impact before measuring it.

## Before production

Conduct member research, threat modeling, privacy and accessibility review. Design tenant-scoped tables, access policies, audit trails, consent and appeal processes, reconciliation, customer support, and service availability. Select an appropriately authorized payment and payout partner and confirm the applicable compliance obligations before handling real money or identity data. Keep lending and credit decisions out of scope unless their data governance, validation, explanations, and appeals are separately designed and reviewed.

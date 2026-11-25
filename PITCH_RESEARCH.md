# Trust Ajo pitch research kit

Prepared 25 November 2026 for the AIESEC 2026 Pitch Competition. Pitch day: 26 November 2026, 9:00 a.m., Oduduwa Hall, Obafemi Awolowo University. Slot: 5 minutes plus judges' questions. The email asks for a short deck and asks the team to cover differentiation, sustainability, and what has been built or tested.

## The honest one-line pitch

**Trust Ajo helps people find and coordinate rotating savings circles with clear terms, shared records, and group-controlled schedules.**

Use “coordination platform/prototype” today. Do not describe Trust Ajo as an active payment app, live wallet, escrow product, or credit service. The current prototype uses simulated wallet activity and synthetic sample data; it does not move real money or independently verify contributions.

## Evidence you can put on a slide

- **11.7 million Nigerian adults used a savings group in 2023** (EFInA A2F 2023, provider usage table; page 48). This is a national indicator of existing behavior, not the number of prospective Trust Ajo customers.
- **39% (about 40 million) used informal financial services in 2023**, up from 31% in 2020 (EFInA A2F 2023, p. 48). This includes several types of informal services, not just Ajo.
- **8% reported saving through an informal savings group** in both 2020 and 2023 (EFInA A2F 2023, savings channels table; p. 67). This is a separate survey measure from the 11.7 million provider-usage estimate; do not combine the two.
- **51% of Nigeria's estimated 111 million adults were aged 18–35** in the survey (EFInA A2F 2023, p. 15). This supports a youth segment hypothesis; it does not prove youth are more likely to adopt Trust Ajo.
- **62% of adults reported monthly personal income below ₦100,000** (EFInA A2F 2023, p. 15). If pricing is discussed, explain affordability and say pricing is unvalidated.

Suggested slide footnote: “Source: EFInA, Access to Financial Services in Nigeria (A2F) 2023. Survey of Nigerian adults (18+); savings-group use is existing market behavior, not Trust Ajo traction.”

Primary report: [EFInA A2F 2023 report (PDF)](https://a2f.ng/wp-content/uploads/2024/07/A2F-2023-SURVEY-REPORT-1.pdf). The EFInA survey describes itself as a nationally representative household survey. See pp. 14–15 for population and methods context, p. 48 for provider use, and p. 67 for savings channels.

## What we have actually built

The local web prototype supports:

- a public board to list, search, filter, discuss, and express interest in Ajo offers;
- creation of a private group from an offer, with member chat, invite code, contribution cadence, due date, capacity, and payout order;
- schedule-conflict checks, contribution records, payout swaps requiring acceptance, and post-rotation choices to continue, replace members, or leave;
- a simulated wallet, activity ledger, mock identity-status screen, and sample participation rating.

The existing deck and [PRODUCT_BRIEF.md](PRODUCT_BRIEF.md) are explicit: wallet balances and member activity are sample data; no funds move. The local demo store is in-memory by default. Supabase is a development persistence adapter, not production-ready. The fee bands are illustrative. Do not count seeded users, offers, contributions, balances, or ratings as traction or tests with real customers.

**What has been tested:** the team has built a clickable/interactive software prototype of the workflows above. The materials reviewed contain no evidence of user interviews, a live pilot, real users, real-money transactions, measured retention, or validated willingness to pay. If the team has done any of that separately, add dates, sample size, method, and results before saying so.

## Competition and differentiation

Digital Ajo is already an active product category. A quick public scan found:

| Product | Publicly described offer | Implication for Trust Ajo |
|---|---|---|
| [Ajora](https://www.ajora.app/) | Rotating savings circles; shared contribution records and chat; says funds will be held at a CBN-licensed partner bank; invite-only; 2% service fee; its FAQ says it is pre-launch and forming its first circles. | Direct competitor. Avoid claiming that digital records, group chat, automation, or partner-bank custody are unique. |
| [Ajo Family](https://ajofamily.tech/) | Rotating savings for families, friends, and communities; public site describes contribution schedules, visible payout order, and direct debit. | Direct competitor on circle coordination and visibility. Confirm product availability and payment claims directly before detailed comparison. |
| [Ajo Money](https://ajomoney.ng/) | Public site markets digital Ajo groups, automated reminders, visible transactions, and free platform fees. | Direct competitor; public claims are not independently verified. |
| [AjoApp Cooperative](https://www.ajoapp.ng/) | Public site describes a digital cooperative savings platform inspired by Ajo and says it is licensed by the Cooperative Society of Nigeria. | Adjacent/direct competitor; verify legal and operational details before comparing. |

**Defensible differentiation to test:** Trust Ajo combines *discoverable public offers* (people can browse terms and express interest) with a transition into a *private, member-coordinated group*; it also models schedule-conflict checks, accepted payout swaps, and post-rotation continuation choices. Some competing products may add similar functions, and public sites do not establish comparative performance. Say “our current product design emphasizes…” rather than “we are the only…” or “competitors cannot…”.

The pitch can say that trust is supported by shared rules and visibility, but must not claim it has already reduced defaults, fraud, disputes, organizer workload, or losses. Those are pilot questions.

## Business model: how to answer “how does it make money?”

Potential revenue paths in the source proposal are a transparent service fee, group-management fee, or partner revenue share. None is validated. The current demo shows illustrative flat wallet fee bands; these are not approved pricing and no transactions occur.

Say: “We will test which fee members will accept and compare it with payment-partner costs before selecting a model. Our first validation is whether groups use the coordination product; then we test willingness to pay and unit economics.”

Do not use the scenario ROI or annual revenue figures in PRODUCT_BRIEF.md as forecasts. They are explicitly assumption-only and exclude transaction provider cost, support, fraud, compliance, taxes, and other material costs. Turnover is not revenue. There is no evidence yet for a TAM/SAM/SOM or a forecast; the EFInA savings-group estimate is a useful behavioral baseline, not a market-size calculation.

## 5-minute spoken pitch draft

**[0:00–0:35 | Hook]**

Think of a savings circle where everyone agrees on the contribution and whose turn is next. The hard part is keeping that agreement clear as dates change, people join, and each round moves forward. Trust Ajo is a coordination tool designed to make those commitments easier for every member to see.

**[0:35–1:15 | Need and evidence]**

This is an existing behavior, not a new habit we need to invent. EFInA’s 2023 national Access to Finance survey estimates that 11.7 million Nigerian adults used a savings group. The same survey found 39% used informal financial services. We are starting with people who already save together and asking how to make the process clearer.

**[1:15–2:10 | Product demo]**

With Trust Ajo, a member can browse an offer, compare its amount and schedule, ask questions, and register interest. When the group forms, its members see the agreed contribution, due date, capacity, and payout order in a private space. The prototype also checks recurring schedule clashes and supports accepted turn swaps and an end-of-rotation choice to continue, find replacements, or leave. The group sets its rules; the product keeps them visible.

**[2:10–2:55 | Difference]**

Digital Ajo products already exist, so we are not claiming to invent digital savings circles. Our current design focuses on the path from discovering an open group to coordinating a private one, with member-visible terms and practical rotation tools. We will test whether that path is more useful than how groups coordinate today.

**[2:55–3:40 | Built and validation]**

We have built an interactive software prototype of these flows. The wallet and sample activity are simulated: we do not move or hold money, and the sample activity is not customer traction. Our next step is a small, opt-in pilot with existing groups. We will measure time to fill a group, avoidable schedule conflicts, reconciliation time, missed contributions, and member-reported trust before and after use.

**[3:40–4:25 | Sustainability]**

The business needs to earn from a service members value, while keeping the cost and handling of payments transparent. We are considering a disclosed service or group-management fee, or a partner arrangement, but have not validated pricing. We will test willingness to pay and payment-provider costs before choosing a model. Real-money collection would require an appropriately authorized financial partner, legal review, secure reconciliation, and clear member protections. Trust Ajo will not hold pooled funds itself under the proposed model.

**[4:25–5:00 | Close / ask]**

We are asking for support to recruit pilot groups, learn from organizers and members, and validate the safest sustainable payment and pricing path. Trust Ajo is being built around a simple idea: when everyone can see the same agreement and the same progress, a savings circle is easier to coordinate. We want to prove that with real groups before making bigger claims.

## Likely judge questions

**What is different from WhatsApp or a spreadsheet?**

The prototype brings group discovery, structured terms, schedule-conflict checks, private group coordination, accepted swaps, and rotation choices into one flow. We need pilot evidence to show that this is meaningfully better than a group's current tools.

**How many users do you have?**

“We have an interactive prototype with seeded demo data, not a live user base yet. Our next milestone is an opt-in pilot with real groups.” If you have genuine testers, state only the verified number and what they actually did.

**How will you prevent default or guarantee payouts?**

“We cannot guarantee a member will contribute, and the prototype does not move money. We show group rules and progress transparently. Before real-money flows, we need a suitable regulated partner, legal review, and tested dispute, reconciliation, and member-protection processes.”

**What is your market size?**

“EFInA reports 11.7 million adults using savings groups in 2023. That establishes significant existing behavior, but it is not our addressable market. We are narrowing the first segment and will estimate serviceable reach from real group recruitment and usage data.”

**Who pays, and how much?**

“We have not validated willingness to pay. We will test a clearly disclosed fee against member value and partner costs before finalizing pricing.”

**What do you need next?**

“Introductions to existing Ajo groups for pilot recruitment, plus feedback from payments and compliance partners on a safe, affordable operating model.”

## Do not say

- “We have thousands of users/groups” based on seeded demo data or a market statistic.
- “We automate payments / guarantee payouts / protect funds” about the current prototype.
- “We have solved default, fraud, trust, or disputes.” These are untested outcomes.
- “Our unique feature” without narrowing the claim to the current design and acknowledging competitors.
- Any market-share, TAM, revenue, profit, ROI, or growth projection unless the inputs are researched and stated.
- “AI credit score,” “creditworthiness,” or equivalent. The demo rating is not a credit score and uses sample activity.

## Sources and caveats

- [EFInA A2F 2023 report (PDF)](https://a2f.ng/wp-content/uploads/2024/07/A2F-2023-SURVEY-REPORT-1.pdf) — primary market data source. Key sections: p. 15 adult population/income, p. 48 informal-service use and savings-group count, p. 49 gender and area, p. 67 savings channels. Statistics are survey estimates, not Trust Ajo customers.
- [Ajora](https://www.ajora.app/) — competitor features, pricing and pre-launch statement are from its own public site and are not independently verified.
- [Ajo Family](https://ajofamily.tech/) — product description from its public site; payment and safety claims are not independently verified.
- [Ajo Money](https://ajomoney.ng/) and [AjoApp Cooperative](https://www.ajoapp.ng/) — public marketing claims only; verify current availability, licensing, terms and functionality before using precise comparisons.
- Product claims above are checked against the repository’s [PRODUCT_BRIEF.md](PRODUCT_BRIEF.md), [README.md](README.md), and existing nine-slide [Trust Ajo deck](Trust_Ajo_Presentation.pptx). The attached email supplies competition requirements and deadline; its requests are not authorization for us to send email or submit the deck.

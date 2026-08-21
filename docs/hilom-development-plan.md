# Hilom Collective — Development Plan

A phase-by-phase build guide for rebuilding hilomcollective.com as a custom React product/commerce site that sells courses hosted on Moodle (learn.hilomcollective.com), with PayMongo checkout and AWS-backed enrollment automation.

**How to use this document:** Keep it as a project reference (e.g. `docs/plan.md` or in `CLAUDE.md`). Feed Claude Code **one phase at a time** rather than pasting the whole thing — each phase below is written to be self-contained. Manual steps you must do yourself (AWS Console, GoDaddy, PayMongo dashboard) are flagged with 🔧 **MANUAL**. Steps Claude Code can build are unmarked.

---

## Locked Decisions (reference)

| Area | Decision |
|---|---|
| Frontend | React on AWS Amplify + S3 + CloudFront |
| Backend | AWS Lambda (Node.js / TypeScript) behind API Gateway at `api.hilomcollective.com` |
| Identity / SSO | AWS Cognito (Hosted UI), set as a custom OIDC issuer in Moodle's `auth_oauth2` plugin |
| Database | Supabase (Postgres) — free tier pre-launch, paid tier at launch |
| Checkout | Stays on hilomcollective.com; PayMongo direct integration |
| Enrollment | Lambda calls Moodle Web Services after payment confirmation |
| Bundles | One purchase can enroll a user in multiple Moodle courses |
| Access duration | Permanent (no expiry logic) |
| Refunds | Manual admin revoke, no automation |
| Course data sync | Manual trigger, read-only, Moodle → Supabase |
| Users | Fresh start, no migration of existing Moodle accounts |
| SSO testing | Disposable Bitnami Moodle on EC2 (started only during SSO work) |
| DNS | Stays at GoDaddy; add records as needed |
| AWS region | `ap-southeast-1` (Singapore) — all services except CloudFront ACM cert |
| Old WordPress/EC2 | Decommissioned entirely after cutover |
| Builder | Solo, via Claude Code |
| Build order | SSO first, then checkout/enrollment |

### Critical cross-cutting rules
- **All AWS resources in `ap-southeast-1`** EXCEPT the ACM certificate for CloudFront, which MUST be in `us-east-1` (CloudFront requirement). You'll create two certs: one in Singapore (for API Gateway custom domain) and one in `us-east-1` (for CloudFront).
- **Never test auth config on production Moodle.** Prove every `auth_oauth2` change on the disposable EC2 Bitnami instance first, then apply the known-good config to `learn.hilomcollective.com` once.
- **Separate the money-record from the fulfillment action.** A payment must be durably recorded in the DB *before* enrollment is attempted, so "paid but not enrolled" is always recoverable.
- **Secrets (PayMongo secret key, Moodle WS token) live only in the backend** (AWS Secrets Manager or Lambda env vars via SSM), never in the React frontend.

---

## Phase 0 — Foundations & Accounts

**Goal:** Everything needed before any code. No application logic yet.

### Tasks
- 🔧 **MANUAL** Confirm AWS account has billing set up and you can create resources in `ap-southeast-1`.
- 🔧 **MANUAL** Create an IAM user (or SSO role) for daily work — do **not** build using the root account. Attach least-privilege policies as you go (start with admin on a non-production account if solo and pre-revenue, tighten later).
- 🔧 **MANUAL** Create a Supabase account and a new project. Note the project URL, `anon` key, and `service_role` key. Region: pick Singapore if offered.
- 🔧 **MANUAL** Create a PayMongo account. Get **test-mode** API keys (public + secret). Keep live keys for launch only.
- 🔧 **MANUAL** Confirm GoDaddy DNS access for hilomcollective.com.
- Set up a Git repo (monorepo recommended: `/frontend`, `/backend`, `/infra`, `/docs`).
- 🔧 **MANUAL** Decide IaC approach: for a solo Claude Code build, **AWS CDK (TypeScript)** or **SAM** keeps infra in the same language as the rest. CDK recommended. (Claude Code can scaffold this.)

### Exit criteria
- You can log into AWS, Supabase, PayMongo (test mode), and GoDaddy.
- Empty repo with folder structure and CDK/SAM scaffold committed.

---

## Phase 1 — SSO: Cognito ↔ Moodle (build first, highest risk)

**Goal:** A user can log into Moodle via Cognito. This is the hardest integration and touches auth, so it goes first and is proven on disposable infrastructure.

> ⚠️ **Known issue to expect:** With Moodle `auth_oauth2` + Cognito, testers have reported that the **first** login attempt redirects back to Moodle with an error and the user appears not logged in, but a **second** attempt logs them straight in. Budget time to reproduce and resolve this before it ever reaches a real user. Likely causes to investigate: issuer/endpoint config, email-claim mapping, and Cognito logout/session handling.

### Tasks
- 🔧 **MANUAL** Launch a **Bitnami Moodle on EC2** instance in `ap-southeast-1`. Give it a public DNS name (temporary is fine). Start it only while working; **terminate** when Phase 1 is done.
- 🔧 **MANUAL** In AWS Cognito, create a **User Pool** in `ap-southeast-1`:
  - Sign-in: email.
  - Create an **App client** (with a client secret).
  - Set up a **Cognito domain** (hosted UI) — e.g. `hilom-auth.auth.ap-southeast-1.amazoncognito.com`.
  - Configure allowed callback URLs: the Moodle OAuth2 callback (`https://<moodle-host>/admin/oauth2callback.php`) and later your React app's callback.
- 🔧 **MANUAL** In Moodle (on the EC2 test box), as admin:
  - Enable the **OAuth 2** authentication plugin.
  - Create a **custom OAuth2 issuer** pointing at Cognito. Use Cognito's discovery document at `https://<cognito-domain>/.well-known/openid-configuration` to get the authorization, token, and userinfo endpoints. Set the client ID/secret from the Cognito app client.
  - Map Cognito's `email` claim to Moodle's email field.
  - Decide and configure whether to **force OAuth2-only login** (disable native username/password) or allow both. Recommendation: for the new fresh-start world, prefer Cognito as the primary path; if you keep native login enabled, document that admins use it, to avoid users creating duplicate accounts.
- Test the full round-trip on the EC2 box: Cognito Hosted UI → login → redirect back to Moodle → user logged in.
- Reproduce and fix the first-login bug. Document the exact working config in `/docs`.

### Exit criteria
- A test user logs into the EC2 Moodle via Cognito reliably on the **first** attempt.
- The working issuer/endpoint/claim config is written down.
- 🔧 **MANUAL** Apply the known-good config to production `learn.hilomcollective.com` **once**, then verify one login there.
- 🔧 **MANUAL** Terminate the EC2 Bitnami instance.

---

## Phase 2 — Moodle Web Services (enrollment + course read API)

**Goal:** Your backend can programmatically read courses from and enroll users into production Moodle. No AWS wiring yet — just prove the Moodle API calls work.

### Tasks
- 🔧 **MANUAL** In production Moodle admin:
  - Enable **Web Services** and the **REST protocol**.
  - Create a dedicated **web service** and a **service account** (a Moodle user) for the integration — not your personal admin account.
  - Grant that account only the capabilities it needs: create users, enrol/unenrol users manually, read course info.
  - Generate a **token** for that account/service. This token is a secret.
- Identify and test the exact WS functions you'll use:
  - `core_course_get_courses` (or `core_course_get_courses_by_field`) — read course list/metadata for sync.
  - `core_user_create_users` — create a Moodle user when a buyer is new.
  - `core_user_get_users_by_field` — look up a user by email (to avoid duplicates).
  - `enrol_manual_enrol_users` — enroll a user into a course (accepts `timeend`, which you leave empty for permanent access).
- Write a small local test script (Claude Code) that hits these against production Moodle using the token, confirming each works and observing the exact request/response shapes.
- **Verify enrollment idempotency:** call `enrol_manual_enrol_users` twice for the same user+course and confirm it does not error or duplicate. Document the behavior.

### Exit criteria
- From a local script you can: read courses, create a user by email, and enroll that user into a course on production Moodle.
- Enrollment idempotency behavior is confirmed and documented.
- Moodle WS token stored securely (Secrets Manager), never committed.

---

## Phase 3 — Data model in Supabase

**Goal:** The database that maps purchasable products (incl. bundles) to Moodle courses, and durably records orders.

> Whether Claude Code can run Supabase CLI/migrations depends on your Claude Code environment (CLI installed + authenticated). If it can't, you'll run `supabase` migration commands yourself; Claude Code writes the SQL.

### Schema (starting point)
- **`products`** — what a customer buys.
  - `id` (uuid, pk), `name`, `slug`, `description`, `price_centavos` (int), `currency` (default `PHP`), `thumbnail_url`, `is_active` (bool), `created_at`.
- **`product_courses`** — mapping (handles single courses AND bundles uniformly).
  - `id` (pk), `product_id` (fk → products), `moodle_course_id` (int). One row per course; a bundle has multiple rows.
- **`courses`** — read-only cache synced from Moodle.
  - `moodle_course_id` (pk, int), `fullname`, `shortname`, `summary`, `last_synced_at`.
- **`orders`** — durable money record + fulfillment status.
  - `id` (pk, uuid), `paymongo_payment_id` (unique — dedupe key), `product_id` (fk), `buyer_email`, `amount_centavos`, `status` (enum: `paid_pending_enrollment`, `fulfilled`, `failed`, `refunded`), `cognito_user_sub` (nullable), `created_at`, `updated_at`, `error_detail` (nullable text).

### Tasks
- Write SQL migrations for the tables above.
- Add the `unique` constraint on `orders.paymongo_payment_id` (critical for webhook dedupe).
- Add Row Level Security policies: the frontend `anon` key can read `products`/`courses` (public catalog) but **not** `orders`. Order writes happen only from the backend using the `service_role` key.
- Seed a couple of test products (one single-course, one bundle) mapping to real Moodle course IDs from Phase 2.
- Add a small admin note field / `last_synced_at` surfacing so staleness is visible.

### Exit criteria
- Tables exist in Supabase with RLS.
- Test products (single + bundle) seeded and readable via the `anon` key.
- `orders` not readable via `anon` key.

---

## Phase 4 — Backend: API Gateway + Lambda skeleton

**Goal:** `api.hilomcollective.com` exists and serves a few endpoints. No payment logic yet — just the wired-up, deployable backend shell.

### Tasks
- 🔧 **MANUAL** Request an **ACM certificate in `ap-southeast-1`** for `api.hilomcollective.com`. Validate it by adding the CNAME ACM gives you **at GoDaddy**.
- Build (CDK) an API Gateway (HTTP API) with a **custom domain** `api.hilomcollective.com` using that cert.
- 🔧 **MANUAL** Add a DNS record at GoDaddy pointing `api.hilomcollective.com` to the API Gateway domain target.
- Scaffold Lambda functions (Node/TS), all in `ap-southeast-1`:
  - `GET /products` — list active products (reads Supabase).
  - `GET /products/{slug}` — product detail.
  - `GET /courses` — cached course list.
  - `POST /admin/sync-courses` — manual sync trigger (protect this — admin only).
  - `POST /webhooks/paymongo` — placeholder for Phase 6.
  - `POST /admin/retry-enrollment/{orderId}` — placeholder for Phase 6.
- Store secrets in **AWS Secrets Manager** (Supabase service key, Moodle token, later PayMongo secret). Lambdas read them at runtime.
- Configure CORS to allow the frontend origin.

### Exit criteria
- `https://api.hilomcollective.com/products` returns seeded products over HTTPS.
- Secrets are read from Secrets Manager, not hardcoded.

---

## Phase 5 — Manual course sync

**Goal:** An admin action pulls course data from Moodle into the Supabase `courses` cache.

### Tasks
- Implement `POST /admin/sync-courses`: calls Moodle `core_course_get_courses`, upserts into `courses`, sets `last_synced_at`.
- Protect the endpoint (admin-only — e.g. require a Cognito admin group token, or a separate admin key for now).
- Surface `last_synced_at` wherever courses are shown in the admin UI, so stale data is visible.
- **Safeguard (decided earlier):** because sync is manual and pricing/status can drift, add a visible "last synced" timestamp in the admin panel and a reminder that price/status changes in Moodle require a manual sync.

### Exit criteria
- Hitting sync updates the `courses` table from live Moodle.
- `last_synced_at` is visible in the admin view.

### Note: "Enrolled Students" count on course pages
Moodle's public course page (e.g. `/course/view.php?id=16`) shows live enrollment
stats (Enrolled / Completed / In Progress / Yet to Start). We want "Enrolled
Students" mirrored on our React course/product pages, but **not** the other three:

- The Moodle WS token's permitted functions (see CLAUDE.md) do not include
  anything that returns per-course enrolled/completed/in-progress counts.
  `core_enrol_get_users_courses` only goes user → courses, and
  `core_enrol_get_enrolled_users` is explicitly not permitted. Getting
  Completed / In Progress / Yet to Start would require a Moodle-admin change
  (enabling `core_enrol_get_enrolled_users` and/or a completion-status
  function) — deliberately out of scope for now.
- **Enrolled Students** doesn't need Moodle at all: once Phase 6 is live, it's
  derivable from our own `orders` + `product_courses` tables —
  `count(distinct buyer_email)` from `orders` joined to `product_courses` on
  `moodle_course_id`, filtered to `status = 'fulfilled'`. Compute this at
  request time (or cache it) in the `GET /products/{slug}` (and/or `GET
  /courses`) endpoint and render it on `ProductDetail.tsx`. No new schema or
  Moodle permission needed — blocked only on Phase 6 (payment + enrollment)
  existing so `orders` actually has fulfilled rows.

---

## Phase 6 — Payment + enrollment (the core flow)

**Goal:** Buy on hilomcollective.com → pay via PayMongo → user created in Cognito (if new) → enrolled in all Moodle courses for that product (bundle-aware) → order marked fulfilled. Failures are visible and recoverable.

> This is the highest-value, highest-risk phase. Build it defensively.

### Flow to implement
1. **Frontend** creates a PayMongo payment (checkout stays on hilomcollective.com). On success, PayMongo notifies your webhook.
2. **`POST /webhooks/paymongo`** (Lambda):
   - Verify the PayMongo webhook signature.
   - **Dedupe** on `paymongo_payment_id` (unique constraint). If the order already exists and is `fulfilled`, return 200 and stop (idempotent).
   - **Write the order row first** with status `paid_pending_enrollment` — before any enrollment attempt.
   - Look up the product's course IDs via `product_courses` (one or many — bundle-aware).
   - Ensure a Cognito user exists for `buyer_email` (create if new); capture `cognito_user_sub`.
   - Ensure a Moodle user exists (`core_user_get_users_by_field` by email; `core_user_create_users` if new).
   - For **each** course ID, call `enrol_manual_enrol_users` (no `timeend` = permanent).
   - On full success → set order `fulfilled`, then send a branded "your course is ready" email via SES (see below) with a deep link into the course.
   - On any failure → leave order `paid_pending_enrollment`, record `error_detail`, push to **SQS retry queue**.
3. **SQS retry consumer** (Lambda): retries enrollment a few times for transient Moodle failures. On exhaustion → **dead-letter queue** + **SNS alert** to you (email).
4. **`POST /admin/retry-enrollment/{orderId}`**: admin-triggered re-run of fulfillment for a stuck order (button in admin panel).

### As built: sign-in happens before payment, not "create if new" at fulfillment
The buyer now authenticates via Cognito Hosted UI as the *first* step of checkout, not
as a side effect of fulfillment — `ensureCognitoUser` (called from the webhook) is a
lookup on the happy path, and only falls back to admin-creating an account for an
order that somehow reaches fulfillment without one already existing. Two reasons:

- The checkout email becomes a verified id_token claim the backend re-checks
  (`backend/src/lib/auth.ts`), not a value the client can name freely — closes the
  gap where a typo or a deliberately wrong email could provision access to the
  wrong Cognito/Moodle account.
- A live Cognito session in the browser is a precondition for the Moodle handoff
  below actually landing the buyer in class without a second login prompt.

The admin-created fallback path suppresses Cognito's default "temporary password"
email (`MessageAction: 'SUPPRESS'`) — a buyer meant to sign in via SSO has no use
for a password that arrives out of nowhere.

### Confirmation email — SES from ap-south-1, not ap-southeast-1
The fulfillment email sends from the **ap-south-1** SES identity — the same one
`community.ts` already uses with production access — not the newer ap-southeast-1
identity verified 2026-08-21. A Lambda calling the SES API has no region tie to its
own region, so there's no reason to route this through a still-sandboxed identity
when a production-ready one already exists. (Cognito's own *built-in* email sending
is the one thing that genuinely is region-locked to the user pool's region — see
"Open items to revisit" below.) Best-effort: a send failure is logged and swallowed,
never allowed to turn a successful enrollment into a retried order.

### Payment-state nuance
- PayMongo supports methods that are **instant** (cards) and some that can be **pending** before confirming (e.g. certain e-wallet/bank flows). Handle a `pending` state explicitly — don't treat "not yet paid" as failure. Only enroll on a **confirmed paid** event.
- Frontend UI should show "Payment confirmed — setting up your access" until the order is `fulfilled`, so a brief enrollment delay doesn't read as a broken purchase.

### Tasks
- 🔧 **MANUAL** In PayMongo dashboard: configure the webhook endpoint (`https://api.hilomcollective.com/webhooks/paymongo`) and get the webhook signing secret. Store it in Secrets Manager.
- Implement signature verification, dedupe, order-first write, Cognito user ensure, Moodle user ensure, bundle-aware enrollment loop.
- Build SQS queue + retry consumer + DLQ + SNS alert (CDK).
- Implement admin retry endpoint.
- Test end-to-end in **PayMongo test mode**: single-course purchase and bundle purchase; simulate an enrollment failure (e.g. bad course ID) and confirm the order lands in `paid_pending_enrollment`, alerts you, and the admin retry works.

### Exit criteria
- Test-mode purchase of a single course enrolls the buyer and marks the order `fulfilled`.
- Test-mode purchase of a bundle enrolls the buyer in all courses in the bundle.
- A forced enrollment failure is recorded, alerted, and recoverable via admin retry — no silent "paid but no access".

---

## Phase 7 — Frontend: product site + checkout + auth

**Goal:** The public hilomcollective.com React app — product pages, Cognito Hosted UI login, PayMongo checkout, and a "my courses / go to learning" handoff to Moodle.

### Tasks
- Build the React app (product homepage, course/product listing, product detail, bundle pages), reading from `GET /products`.
- Integrate **Cognito Hosted UI** for signup/login (accept the brief visual hand-off to Cognito's pages; theme with logo/colors).
- Implement PayMongo checkout on-site; on payment success, show the "setting up access" state, then confirm fulfillment.
- Post-purchase: a "Start learning" link straight into the purchased course (or `/my/` for a bundle) — the order-status endpoint returns `accessUrl`, computed from the same `product_courses` mapping fulfillment enrolls against, so the email and the processing screen never disagree on where it points.
- Build a minimal **admin panel** (can be gated routes): list products, trigger course sync (with `last_synced_at`), view stuck orders, retry enrollment, and manual refund-revoke (see Phase 8).

### As built: checkout requires sign-in first
Checkout requires signing in via Cognito Hosted UI *before* the buyer reaches the
payment step — framed as "create your Hilom account" rather than a login wall,
since they need the account regardless. See Phase 6's "as built" note for why.
The checkout form has no email field at all now: the backend takes it from the
verified token.

### As built: the Moodle SSO handoff has a known quirk, mitigated with copy, not code
Moodle's `auth_oauth2` callback occasionally bounces the *first* SSO attempt in a
browser back to the login page ("your session has most likely timed out") before
succeeding immediately on retry — a documented sesskey/session-timing issue
(`docs/sso-runbook.md`), not a broken account. A cross-origin iframe "pre-warm" to
establish a Moodle session cookie before the buyer clicks through was considered
and rejected: Safari's ITP and Chrome's third-party-cookie phase-out would likely
block it silently in exactly the browsers where it'd matter, giving false
confidence instead of fixing anything. Both the processing screen and the
confirmation email instead set expectations up front — "choose Hilom Collective,"
and a note that a first-time bounce-and-retry is normal, not an error.

### Tasks — hosting
- 🔧 **MANUAL** Request an **ACM cert in `us-east-1`** for the site domain(s) (`hilomcollective.com`, `www`) — CloudFront requires `us-east-1`. Validate via CNAME at GoDaddy.
- Deploy the React app via **Amplify Hosting** (or S3 + CloudFront directly). If using S3+CloudFront manually: S3 bucket (private) + CloudFront distribution with the `us-east-1` cert.
- 🔧 **MANUAL** Point apex/`www` at CloudFront/Amplify via GoDaddy DNS.

### Exit criteria
- Public site loads over HTTPS at hilomcollective.com.
- A user can sign up/log in (Cognito), buy a course/bundle (test mode), and reach their Moodle courses via one identity.
- Admin panel can sync courses, see stuck orders, and retry.

---

## Phase 8 — Refunds (manual)

**Goal:** Handle refunds without automation, as decided.

### Tasks
- 🔧 **MANUAL** Process the refund in the PayMongo dashboard.
- In the admin panel, provide a **manual "revoke access"** action that unenrolls the user from the relevant Moodle course(s) via WS (`enrol_manual_unenrol_users`) and sets the order `refunded`.
- Document the runbook: refund in PayMongo → revoke in admin panel.

### Exit criteria
- An admin can revoke course access and mark an order refunded in a couple of clicks.

---

## Phase 9 — Launch cutover

**Goal:** Go live and retire WordPress.

### Tasks
- 🔧 **MANUAL** Switch PayMongo to **live keys** (in Secrets Manager). Update webhook to live mode.
- 🔧 **MANUAL** Move Supabase to a **paid tier** (free tier pauses on inactivity — unacceptable once real payments flow).
- Full live-mode smoke test: one real (small) purchase end-to-end, confirm enrollment, then refund it via the Phase 8 runbook.
- 🔧 **MANUAL** Final DNS cutover at GoDaddy so hilomcollective.com serves the new site.
- 🔧 **MANUAL** Once verified stable, **decommission the old WordPress EC2** entirely.
- 🔧 **MANUAL** Confirm production Moodle is on the known-good Cognito config and native-login policy you chose.

### Exit criteria
- A real purchase works end-to-end in production.
- Old WordPress is gone.
- Supabase is on a non-pausing paid plan.

---

## Cost expectation (reference)
At pre-launch/early scale, **new** monthly AWS spend is roughly **$20–40** on top of the existing Moodle EC2 host. Lambda, API Gateway, Cognito, and SQS are effectively free at your volume (generous free tiers, usage-priced). Supabase is free pre-launch, small paid tier at launch. Keep Lambdas and any future RDS in the **same region/AZ** to avoid cross-AZ transfer charges. Avoid Aurora Serverless v2 at this scale — its idle floor and per-I/O charges make it worse than plain Postgres for your workload.

## Things deliberately deferred (not in scope now)
- Selling a `paygw_paymongo` plugin on the Moodle marketplace (separate product, decoupled from this build).
- Scheduled/automatic course sync (manual only for now).
- Time-limited / cohort access (permanent only for now).
- Automated refund-driven unenrollment (manual only for now).
- Custom-built (non-Hosted-UI) auth screens.
- Migrating existing Moodle users (fresh start).

## Open items to revisit at/after launch
- Move off Cognito Hosted UI to custom auth screens if the visual hand-off bothers you.
- Re-evaluate Supabase vs. RDS once volume and access patterns are known.
- Add scheduled sync if manual becomes error-prone.
- Add expiry/cohort support if you introduce time-limited products.

### Cognito production-readiness — pending, not launch-blocking after the SES fix above
The buyer-facing confirmation email is already production-ready (ap-south-1, see
Phase 6). What's left is narrower than it first looked, because the sign-in-first
checkout change made Cognito's own admin-created-account path a rare fallback
rather than the norm:
- **Cognito's own built-in email** (invites/MFA codes/password resets, as opposed
  to the fulfillment confirmation email) is still on Cognito's default sender,
  sandboxed to ~50/day. Wiring it to SES requires the **ap-southeast-1** identity
  specifically — Cognito's `EmailConfiguration.SourceArn` must be in the same
  region as the user pool, unlike a Lambda's own SES calls. `scripts/configure-cognito-ses.ts`
  does this; not run yet, since it mutates a live shared auth resource. Low
  urgency now that the temp-password invite is suppressed and the fallback path
  rarely fires — worth doing before relying on any other Cognito-sent email
  (e.g. self-service password reset).
- **SES production access for ap-southeast-1** is only needed if the item above
  gets prioritized. Not needed for the confirmation email (ap-south-1 already has
  production access).
- **Bring the `hilom-users` user pool into CDK.** It was created by hand; the
  stack only references its id as a hardcoded default
  (`infra/lib/hilom-backend-stack.ts`). Not reproducible as-is — losing it means
  losing every buyer's identity and, through the email match, their Moodle access.
- **Custom Hosted UI domain** (e.g. `auth.hilomcollective.com`) instead of the raw
  `hilom-auth.auth.ap-southeast-1.amazoncognito.com`. Buyers now hit Hosted UI
  moments before paying; an unfamiliar AWS domain at that moment costs conversions.
- **DKIM/SPF/DMARC** — the ap-south-1 identity is already DKIM-signed
  (`community.ts`); SPF/DMARC status on the sending domain hasn't been verified
  from this codebase and is worth confirming directly in Route 53/GoDaddy + SES.
- **Refresh tokens** instead of session-storage-only auth — a returning buyer
  currently re-authenticates every visit since tokens die with the tab. Deliberate
  for now; revisit once accounts carry more standing value (e.g. a "my courses"
  dashboard on our own site).
- **Alarm on `AdminCreateUser` failures** in the fallback path — the SNS alert
  topic already exists (Phase 6); a buyer who pays and can't be given an identity
  should page someone, not just sit in `error_detail` waiting to be noticed.

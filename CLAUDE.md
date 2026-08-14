# Hilom Collective — Project Context

Rebuild of hilomcollective.com as a custom React commerce site selling courses hosted on
Moodle, with PayMongo checkout and AWS-backed enrollment automation.

Full phase-by-phase plan: [docs/hilom-development-plan.md](docs/hilom-development-plan.md).
Build one phase at a time.

## Layout

- `frontend/` — React (Vite + TS), deployed via **Amplify Hosting**
- `backend/` — Lambda handlers (Node 20 / TS) behind API Gateway at `api.hilomcollective.com`
- `infra/` — AWS CDK (TypeScript)
- `scripts/` — local operational scripts (Moodle WS probes, migrations)
- `docs/` — plan and runbooks

## Locked decisions

| Area | Decision |
|---|---|
| Frontend hosting | AWS Amplify Hosting |
| Backend | Lambda (Node/TS) + API Gateway HTTP API |
| Identity | Cognito Hosted UI, custom OIDC issuer in Moodle `auth_oauth2` |
| Moodle native login | **Kept, admins only** — documented so a broken Cognito config can't lock us out |
| Database | Supabase Postgres |
| Checkout | On-site, PayMongo direct |
| Access duration | Permanent, no expiry |
| Refunds | Manual revoke, no automation |
| Course sync | Manual trigger, read-only, Moodle → Supabase |
| AWS region | `ap-southeast-1` (Singapore) |
| Build order | SSO first, then checkout/enrollment |

## Hard rules

- **All AWS resources in `ap-southeast-1`** except the CloudFront/Amplify ACM cert, which
  must be in `us-east-1`. API Gateway's custom-domain cert goes in `ap-southeast-1`.
- **Never test auth config on production Moodle.** Prove every `auth_oauth2` change on the
  disposable EC2 Bitnami box first, then apply the known-good config once.
- **Record the money before fulfilling.** The order row is written with status
  `paid_pending_enrollment` *before* any enrollment is attempted, so "paid but not enrolled"
  is always recoverable.
- **Secrets live only in the backend** (AWS Secrets Manager). Never in `frontend/`, never
  committed. `.env` is gitignored.
- **Moodle host is `https://www.learn.hilomcollective.com`** — with `www`. The bare host
  301-redirects; using it breaks the OAuth2 callback and POSTed web-service calls.
- **Supabase connections use the pooler** (`aws-0-ap-southeast-1.pooler.supabase.com:5432`).
  The direct `db.<ref>.supabase.co` host is IPv6-only and does not resolve here.

## Verified environment (as of 2026-08-14)

- AWS account `651706741660`, IAM user `cursor-admin`.
- Supabase project `afdhnjohvsoxwzlmpddj`, Postgres 17.6, region **ap-southeast-1 (Singapore)**
  — recreated from an earlier Mumbai project while the DB was still empty, so it's now
  same-region as the AWS stack. Connection details (URL, publishable key, DB pooler URL,
  secret key) live in Secrets Manager as `hilom/supabase`, not in this repo.
- Moodle web-service token is valid and permits: `core_course_get_courses`,
  `core_course_get_courses_by_field`, `core_user_get_users_by_field`,
  `core_user_create_users`, `core_user_update_users`, `enrol_manual_enrol_users`,
  `enrol_manual_unenrol_users`, `core_enrol_get_users_courses`.
  It does **not** permit `core_webservice_get_site_info` or `core_enrol_get_enrolled_users`.

## Live Moodle course IDs

| ID | Shortname | Name | Visible |
|---|---|---|---|
| 3 | EI101 | How To Master Your Emotions | no |
| 6 | SELFDEVELOPEMENT_CONFIDENCE1 | The Confidence Takeoff | no |
| 10 | EI101_1 | Module 1: Understand Yourself | yes |
| 15 | EI101_2 | Module 2: Build Resilience | yes |
| 16 | EI101_3 | Module 3: Transform Your Life | yes |
| 17 | EI101_BUNDLE1 | The Breakthrough Bundle | yes |
| 18 | burger101 | How to Cook a Burger | yes |

Course 1 is the Moodle site-level pseudo-course (`format: site`) — never sell or enroll into it.
Courses 3 and 6 are hidden/retired — not sellable. Only **10, 15, 16, 17, 18** are real
products. Course 17 (The Breakthrough Bundle) is a bundle product whose purchase enrolls the
buyer in courses 10, 15, and 16 — not course 17 itself.

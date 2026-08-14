# Hilom Collective

Rebuild of [hilomcollective.com](https://hilomcollective.com) as a custom React commerce
site selling courses hosted on Moodle, with PayMongo checkout and AWS-backed enrollment
automation.

Full phase-by-phase build plan: [docs/hilom-development-plan.md](docs/hilom-development-plan.md).
Project conventions and locked decisions: [CLAUDE.md](CLAUDE.md).

**Status:** Phases 0–8 complete and verified against production. The storefront is
live at **https://main.d2hx75l7mk7woi.amplifyapp.com** — the apex domain still serves
the old WordPress site until the Phase 9 cutover.

---

## Architecture

```mermaid
flowchart TB
    subgraph Buyer["Buyer's browser"]
        UI["React storefront (Phase 7)<br/>Amplify Hosting"]
    end

    subgraph AWS["AWS — ap-southeast-1 (Singapore)"]
        Cognito["Cognito User Pool<br/>hilom-users<br/>Hosted UI login"]

        subgraph API["API Gateway HTTP API"]
            direction TB
            RCatalog["GET /products, /products/{slug}<br/>GET /courses"]
            RAdmin["POST /admin/sync-courses<br/>POST /admin/retry-enrollment/{id}"]
            RWebhook["POST /webhooks/paymongo"]
        end

        subgraph Lambdas["Lambda (Node 24, ARM64)"]
            FnCatalog["products.ts / courses.ts"]
            FnAdmin["admin.ts"]
            FnWebhook["paymongo-webhook.ts"]
            FnRetry["enrollment-retry-consumer.ts"]
        end

        SQS["SQS: hilom-enrollment-retry"]
        DLQ["SQS DLQ: hilom-enrollment-retry-dlq"]
        Alarm["CloudWatch Alarm"]
        SNS["SNS: hilom-enrollment-alerts"]
        Secrets["Secrets Manager<br/>hilom/supabase, hilom/moodle,<br/>hilom/paymongo/test, hilom/cognito,<br/>hilom/admin-api-key"]
    end

    subgraph Supabase["Supabase Postgres — ap-southeast-1"]
        DB[("products, courses,<br/>product_courses, orders")]
    end

    subgraph External["External services"]
        PayMongo["PayMongo<br/>(test mode)"]
        Moodle["Moodle 4.5<br/>www.learn.hilomcollective.com<br/>auth_oauth2 -> Cognito"]
    end

    UI -- "Hosted UI login" --> Cognito
    UI -- "browse catalog" --> RCatalog
    RCatalog --> FnCatalog --> DB

    PayMongo -- "payment.paid webhook" --> RWebhook --> FnWebhook
    FnWebhook -- "order-first write,<br/>dedupe on payment id" --> DB
    FnWebhook -- "ensure identity" --> Cognito
    FnWebhook -- "ensure user + enrol" --> Moodle
    FnWebhook -- "on failure" --> SQS --> FnRetry
    FnRetry --> Cognito
    FnRetry --> Moodle
    FnRetry -- "exhausted retries" --> DLQ --> Alarm --> SNS

    RAdmin --> FnAdmin --> DB
    FnAdmin --> Moodle

    Lambdas -. "read secrets" .-> Secrets

    UI -. "SSO session" .-> Moodle
```

**Everything lives in `ap-southeast-1` (Singapore)** except the CloudFront/Amplify ACM
certificate, which AWS requires in `us-east-1`. See [CLAUDE.md](CLAUDE.md) for the
full list of hard rules this build follows.

---

## AWS services in use

| Service | Purpose |
|---|---|
| **API Gateway** (HTTP API) | Public + admin REST surface at `api.hilomcollective.com` |
| **Lambda** (Node 24, ARM64) | All backend handlers — catalog reads, admin actions, PayMongo webhook, enrollment retry consumer |
| **Cognito** | User pool + Hosted UI; the shared identity between the storefront and Moodle SSO |
| **Secrets Manager** | Every credential (Supabase, Moodle, PayMongo, Cognito app client, admin API key) — nothing secret lives in code, env vars, or the repo |
| **SQS** | `hilom-enrollment-retry` queue + `hilom-enrollment-retry-dlq` dead-letter queue for failed enrollments |
| **SNS** | `hilom-enrollment-alerts` — emails when an order exhausts retries and needs manual attention |
| **CloudWatch** | Logs for every Lambda; alarm on DLQ depth that triggers the SNS alert |
| **ACM** | TLS certs for `api.hilomcollective.com` (ap-southeast-1) and the future storefront domain (us-east-1) |
| **Amplify Hosting** | Serves the React storefront (app `d2hx75l7mk7woi`) |
| **EC2** | Used only transiently in Phase 1 (disposable Moodle SSO test box), already terminated |

Outside AWS: **Supabase Postgres** (ap-southeast-1) for the catalog and orders,
**PayMongo** for payment processing, and **Moodle 4.5** (self-hosted, not on AWS) for
course delivery.

---

## Important values

Non-secret identifiers only — every credential lives in Secrets Manager, never here.

| What | Value |
|---|---|
| AWS account | `651706741660` |
| AWS region | `ap-southeast-1` (Singapore) |
| API base URL | `https://api.hilomcollective.com` |
| API execute-api URL (fallback) | `https://n5r99dri26.execute-api.ap-southeast-1.amazonaws.com` |
| Storefront (Amplify) | `https://main.d2hx75l7mk7woi.amplifyapp.com` |
| Amplify app id | `d2hx75l7mk7woi` |
| Cognito user pool | `ap-southeast-1_AA9IeeZ2z` (`hilom-users`) |
| Cognito SPA client (public, PKCE) | `29bo0gpj7j9u7ofbcii22emj8l` (`hilom-web`) |
| Cognito Hosted UI domain | `hilom-auth.auth.ap-southeast-1.amazoncognito.com` |
| Supabase project | `afdhnjohvsoxwzlmpddj` (ap-southeast-1) |
| Supabase pooler host | `aws-0-ap-southeast-1.pooler.supabase.com:5432` |
| Moodle production URL | `https://www.learn.hilomcollective.com` (the `www` is required) |
| Enrollment retry queue | `hilom-enrollment-retry` |
| Enrollment retry DLQ | `hilom-enrollment-retry-dlq` |
| SNS alert topic | `hilom-enrollment-alerts` |

Secrets Manager entries (values never appear in the repo):

| Secret name | Contents |
|---|---|
| `hilom/supabase` | Project URL, publishable key, secret key, DB pooler URL |
| `hilom/moodle` | Web service URL + integration token |
| `hilom/paymongo/test` | Public key, secret key, webhook signing secret |
| `hilom/cognito` | User pool ID, app client ID/secret, Hosted UI domain |
| `hilom/admin-api-key` | Shared key for `/admin/*` routes (CDK-generated) |

Read any of these with:
```bash
aws secretsmanager get-secret-value --region ap-southeast-1 --secret-id <name> --query SecretString --output text
```

---

## Layout

- `frontend/` — React (Vite + TS), deployed via **Amplify Hosting**
- `backend/` — Lambda handlers (Node 24 / TS) behind API Gateway
- `infra/` — AWS CDK (TypeScript) — `HilomBackendStack`
- `db/` — Supabase SQL migrations, RLS policies, seed data
- `scripts/` — operational scripts (Moodle WS probes, PayMongo test-mode checkout harness)
- `docs/` — build plan, SSO runbook, backend runbook, admin handoff docs

## Progress

| Phase | Status |
|---|---|
| 0 — Foundations | ✅ done |
| 1 — SSO (Cognito ↔ Moodle) | ✅ done, verified on production |
| 2 — Moodle Web Services | ✅ done, enrollment idempotency confirmed on production |
| 3 — Supabase schema + RLS | ✅ done |
| 4 — API Gateway + Lambda skeleton | ✅ done |
| 5 — Manual course sync | ✅ done (`POST /admin/sync-courses`) |
| 6 — Payment + enrollment | ✅ done, verified end-to-end (single course, bundle, forced-failure recovery) against production |
| 7 — Frontend storefront | ✅ done — storefront, on-site checkout, Cognito login, admin panel; live on Amplify |
| 8 — Manual refunds | ✅ done — admin revoke-access, verified incl. the overlapping-products case |
| 9 — Launch cutover | not started |

## Local development

```bash
npm install                 # installs all three workspaces
cd backend && npm run typecheck
cd infra && npx cdk synth   # requires -c apiCertificateArn=... for the custom domain
```

Runbooks with exact deploy/test commands:
[docs/backend-runbook.md](docs/backend-runbook.md),
[docs/frontend-runbook.md](docs/frontend-runbook.md),
[docs/sso-runbook.md](docs/sso-runbook.md),
[docs/refund-runbook.md](docs/refund-runbook.md).

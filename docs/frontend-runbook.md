# Frontend runbook (Phase 7)

React (Vite + TS) on **Amplify Hosting**, app id `d2hx75l7mk7woi`, `ap-southeast-1`.

**Live (staging) URL:** https://main.d2hx75l7mk7woi.amplifyapp.com

The apex domain `hilomcollective.com` is **deliberately not pointed here yet** — it
still serves the live WordPress store. Repointing it is the Phase 9 cutover, not a
Phase 7 step, because it would take the existing store offline.

## Routes

| Route | Purpose |
|---|---|
| `/` | Home — hero + catalog |
| `/courses` | Full catalog |
| `/courses/:slug` | Product / bundle detail, lists included courses |
| `/checkout/:slug` | On-site card checkout |
| `/checkout/processing` | "Payment confirmed → setting up your access" poller |
| `/auth/callback` | Cognito PKCE code exchange |
| `/admin` | Admin panel (shared key) |

## Deploying

```bash
cd frontend && npm run build
cd dist && python -c "import shutil; shutil.make_archive('../dist','zip','.')"
```

Then create a deployment, upload the zip to the returned URL, and start it:

```bash
aws amplify create-deployment --region ap-southeast-1 --app-id d2hx75l7mk7woi --branch-name main
curl -X PUT -T frontend/dist.zip "<zipUploadUrl>"
aws amplify start-deployment --region ap-southeast-1 --app-id d2hx75l7mk7woi --branch-name main --job-id <jobId>
```

This is manual zip deployment rather than a GitHub CI/CD connection, which would
need a GitHub OAuth authorization the build doesn't currently have. Connecting the
repo later is a drop-in improvement.

### SPA routing

Amplify needs an explicit rewrite or every deep link 404s. The naive
`/<*> -> /index.html (404-200)` rule does **not** work — Amplify issues a
trailing-slash 301 first and the rewrite never matches. The rule actually in use
is the regex form that matches any path without a file extension:

```
</^[^.]+$|\.(?!(css|gif|ico|jpg|jpeg|js|png|txt|svg|woff|woff2|ttf|map|json|webmanifest)$)([^.]+$)/>  ->  /index.html  (200)
```

Verified: `/`, `/courses`, `/courses/:slug`, `/admin`, `/checkout/:slug` all return
200, and `/assets/*.css` still serves as `text/css` rather than being rewritten.

## Auth

Cognito Hosted UI, authorization-code flow with **PKCE**, using app client
`29bo0gpj7j9u7ofbcii22emj8l` (`hilom-web`) — a **public client with no secret**.

The older `hilom-moodle` client has a client secret and is used only by Moodle's
`auth_oauth2`. A browser cannot hold a secret, so the two clients are deliberately
separate; never point the SPA at the Moodle client.

Callback URLs registered: localhost:5173, the Amplify URL, and both apex/www
production URLs (pre-registered so cutover needs no Cognito change).

Tokens live in `sessionStorage` and are cleared when the tab closes.

## Payments

Card details go **straight from the browser to PayMongo** using the *public* key
and never reach our servers. The backend creates the payment intent so the amount
always comes from the database — the browser never supplies a price.

**PayMongo returns `payments[]` as an EMPTY array to public-key clients.** This was
verified directly against the live API with a side-by-side secret-key vs
public-key probe. The practical consequence: the browser can confirm its payment
succeeded but can never learn its own payment id. Fulfillment is therefore tracked
by payment *intent* id through `GET /orders/status-by-intent/{intentId}`, which
resolves intent → payment server-side where the secret key can see it.

This bit the first live UI purchase: the money was taken and the buyer was shown
an error, because the success check required a payment id that can never arrive.
Anyone touching this flow should keep the intent-id path.

3-D Secure returns land on `/checkout/processing` with no query string, so the
intent id is stashed in `sessionStorage` before redirecting to the bank.

## Admin panel

Gated by the shared admin key from Secrets Manager (`hilom/admin-api-key`), held
in `sessionStorage` only. Shows orders with status, surfaces `error_detail` for
stuck ones, offers per-order retry, and displays course-cache staleness
("last synced Nh ago") with a reminder that sync is manual.

This is a stopgap — the plan replaces the shared key with a Cognito admin group.

## Remaining for Phase 9 (cutover)

- ACM certificate for `hilomcollective.com` + `www` already requested in
  **us-east-1** (CloudFront requirement):
  `arn:aws:acm:us-east-1:651706741660:certificate/8b37ddf0-d665-491a-b930-4fa06807094f`
  — pending the two DNS validation CNAMEs at GoDaddy.
- Attach the custom domain to the Amplify app once validated.
- Point apex + `www` at Amplify, retiring the WordPress site.

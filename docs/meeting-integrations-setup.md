# Setting up the Google Meet and Zoom OAuth apps

One-time provisioning for the connected-accounts feature. The code is deployed;
these two secrets are what switch it on. Nothing here costs money.

Do **Google first** — it can go live immediately. Start the **Zoom** submission
at the same time, because that one waits on Zoom's review queue.

---

## Google Meet

### 1. Project and API

1. <https://console.cloud.google.com> → create a project (e.g. `hilom-meet`).
2. **APIs & Services → Library** → search **Google Meet API** → **Enable**.

### 2. Consent screen

**APIs & Services → OAuth consent screen**

| Field | Value |
|---|---|
| User type | **External** |
| App name | Hilom Collective |
| Support email | kumusta@hilomcollective.com |
| App domain | `https://www.hilomcollective.com` |
| Privacy policy | `https://www.hilomcollective.com/privacy-policy` |
| Developer contact | kumusta@hilomcollective.com |

**Scopes** — add exactly these three:

```
openid
email
https://www.googleapis.com/auth/meetings.space.created
```

> `meetings.space.created` only reaches meetings *this app creates*. It cannot
> read a facilitator's calendar or existing meetings. That narrowness is what
> keeps this off Google's restricted-scope path — no security assessment, no fee.

**Publishing status: leave on `Testing`.** Under **Test users**, add each
facilitator's Google address. Testing mode allows 100 users with no
verification, which is far beyond the current roster. Verification becomes a
task only when Hilom approaches 100 facilitators.

### 3. OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**

- Application type: **Web application**
- Name: `Hilom API`
- **Authorised redirect URI** — must match byte for byte:

```
https://api.hilomcollective.com/facilitator/integrations/google_meet/callback
```

Copy the client ID and client secret.

### 4. Store the secret

```bash
aws secretsmanager create-secret \
  --name hilom/google-meet \
  --region ap-southeast-1 \
  --secret-string '{"clientId":"PASTE_CLIENT_ID","clientSecret":"PASTE_CLIENT_SECRET"}'
```

Updating it later:

```bash
aws secretsmanager put-secret-value \
  --secret-id hilom/google-meet \
  --region ap-southeast-1 \
  --secret-string '{"clientId":"...","clientSecret":"..."}'
```

> Lambda caches secrets for the life of a warm container, so a changed secret
> is picked up as containers cycle — within a few minutes, not instantly.

---

## Zoom

### 1. Create the app

1. <https://marketplace.zoom.us> → sign in → **Develop → Build App**.
2. Choose **General App**.
3. **User-managed app** — *not* account-level, and *not* Server-to-Server.
   Server-to-Server only reaches your own Zoom account, which is exactly the
   thing this feature is not doing: facilitators host their own meetings.

### 2. Redirect URL

```
https://api.hilomcollective.com/facilitator/integrations/zoom/callback
```

Add the same URL to the allow list.

### 3. Scopes

```
meeting:write:meeting
meeting:update:meeting
meeting:delete:meeting
user:read:user
```

These must match `CONFIG.zoom.scopes` in `backend/src/lib/integrations.ts`
exactly. Zoom rejects a consent request asking for a scope the app is not
configured for, so treat the two lists as one thing kept in sync — if you
change the app's scopes, change the code's, and vice versa.

### 4. Store the secret

```bash
aws secretsmanager create-secret \
  --name hilom/zoom \
  --region ap-southeast-1 \
  --secret-string '{"clientId":"PASTE_CLIENT_ID","clientSecret":"PASTE_CLIENT_SECRET"}'
```

### 5. Submit for review — do this early

An **unpublished** Zoom app can only be authorised by users inside the
developer's own Zoom account. Any other facilitator gets:

> Unable to install this app without the developer's account.

There is no Testing-mode equivalent to Google's. Publication is mandatory for
external facilitators, and review takes weeks. Submitting as soon as the app is
configured means that queue runs in parallel with everything else rather than
after it.

The submission wants: privacy policy URL, terms of use URL, support contact, a
security questionnaire, and a functional demo video.

**Until it is approved**, Zoom works for facilitators inside Hilom's own Zoom
account. Google Meet works for everyone in the test-user list. Manual links
work for everybody, always.

---

## Checking it worked

Once `hilom/google-meet` exists:

1. Sign in as a facilitator whose Google address is on the test-user list.
2. **Dashboard → Connections → Connect Google Meet.**
3. Google's consent screen should ask for Meet space creation and your email —
   and nothing about your calendar. If it mentions calendar access, the scope
   list is wrong.
4. After allowing, you land back on Connections showing
   **Connected as `you@gmail.com`**.

Confirm nothing sensitive was stored in the clear:

```bash
psql "$DBURL" -c "select provider, external_email, scopes, broken_at,
  length(access_token_enc) as access_bytes, length(refresh_token_enc) as refresh_bytes
  from public.facilitator_integrations;"
```

Both token columns should be opaque binary of a few hundred bytes. If either is
readable text, stop — something is bypassing KMS.

---

## What this does not do yet

Connecting an account does not yet change anything a client sees. Creating the
actual Meet space or Zoom meeting per booking, and the **Google Meet / Zoom /
Manual** picker on a service, are the next step —
see [meeting-link-integrations.md](meeting-link-integrations.md).

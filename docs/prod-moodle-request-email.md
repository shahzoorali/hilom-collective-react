# Email to the production Moodle team

Two options, presented in order of preference. Send Option A first; fall back to
Option B only if they decline SSH/shell access.

---

## Option A — ask for temporary SSH/shell access

Subject: Access needed to configure Cognito SSO on learn.hilomcollective.com

Hi [team],

We're adding AWS Cognito as a login option on learn.hilomcollective.com
(Project: Hilom Collective SSO rollout). I've built and fully tested the
integration on a disposable throwaway Moodle instance first — never touched
production — and now need to apply the same, already-proven configuration to
the live site.

The change is a single PHP CLI script that configures Moodle's built-in
`auth_oauth2` plugin (no core file changes, no plugin installs). It:

- Creates one OAuth2 "issuer" pointing at our Cognito user pool
- Maps Cognito's email/name claims to Moodle's user fields
- Enables `oauth2` as a login method **alongside** the existing manual
  (username/password) login — nothing is removed or disabled, so anyone who
  logs in today continues to work exactly the same way

Could you either:
1. Run the attached script for us (`moodle-configure-cognito.php`, instructions
   below), or
2. Grant temporary SSH access to run it ourselves, revoked after

**Command to run** (as the web server user, e.g. `www-data`):

```bash
# Copy moodle-configure-cognito.php into <moodledir>/admin/cli/ first
sudo -u www-data php admin/cli/moodle-configure-cognito.php \
  --clientid=<value>       \
  --clientsecret=<value>   \
  --poolid=ap-southeast-1_AA9IeeZ2z \
  --region=ap-southeast-1  \
  --cognitodomain=hilom-auth.auth.ap-southeast-1.amazoncognito.com
```

(Client ID/secret shared separately, not over email.)

After running it, we'd like to do one test login ourselves with a throwaway
account to confirm, then hand back any access immediately.

Thanks,
[name]

---

## Option B — they do it themselves via the admin UI

If shell/SSH access isn't something they can grant, the same result can be
achieved by an admin clicking through Moodle's own settings — no server access
needed at all. Send this instead:

Subject: Config needed on learn.hilomcollective.com — Site Administration only, no server access required

Hi [team],

Following up — no problem if shell access isn't something you can offer. This
can be done entirely through Moodle's **Site Administration** pages by anyone
with your admin login. Roughly 10 minutes, no plugins to install.

### 1. Enable the OAuth 2 login plugin
Site administration → Plugins → Authentication → Manage authentication
→ enable **OAuth 2**. Confirm **Manual accounts (manual)** stays enabled too —
that's the existing admin login and must not be turned off.

### 2. Create a new OAuth2 issuer
Site administration → Server → OAuth 2 services → **Create new custom service**

> ⚠️ **The Name field is user-facing copy, not just a label.** Whatever goes
> here is the exact text Moodle renders on the login page button, and the
> post-purchase screen and enrollment email both instruct buyers to click it
> by name (`frontend/src/pages/Processing.tsx`,
> `backend/src/lib/enrollment-email.ts`). Production is currently
> `Hilom Collective` — verified by reading the live login page, after an
> earlier revision of this doc said `Hilom Account` and the two silently
> drifted apart. **Renaming the issuer means updating that copy in the same
> change**, or buyers are told to look for a button that does not exist.

| Field | Value |
|---|---|
| Name | `Hilom Collective` |
| Client ID | *(shared separately)* |
| Client secret | *(shared separately)* |
| Authentication endpoint | `https://hilom-auth.auth.ap-southeast-1.amazoncognito.com/oauth2/authorize` |
| Token endpoint | `https://hilom-auth.auth.ap-southeast-1.amazoncognito.com/oauth2/token` |
| Userinfo endpoint | `https://hilom-auth.auth.ap-southeast-1.amazoncognito.com/oauth2/userInfo` |
| Scopes on login | `openid email profile` |
| Scopes on login (offline access) | `openid email profile` |
| Basic authentication | **Yes / enabled** — Cognito requires this; if left off, login fails with `invalid_client` |
| Require confirmation | **No** — Cognito already verifies the email; leaving this on causes a broken-looking first login |
| Show on login page | **Only on login page** |
| Enabled | **Yes** |

Save.

### 2b. Turn off email re-verification — easy to miss, breaks first login

This is **not** on the creation form — it only appears on the issuer's
separate **Settings** page after saving, labeled "Require email verification"
in this Moodle version (older versions call it "Require confirmation"). It
defaults to **on**, and if left on, every new signup lands on Moodle's
"Confirm your account, check your email" page instead of logging in — Cognito
already verified the email, so this is redundant and actively breaks login.

Open the issuer → **Settings** → find **Require email verification** →
uncheck it → an "I understand disabling email verification can be a security
issue" checkbox will appear → check that too → **Save changes**.

### 3. Map the user fields
On the same issuer's **User field mappings** tab, add:

| External field | Internal field |
|---|---|
| `email` | `email` |
| `given_name` | `firstname` |
| `family_name` | `lastname` |

Without the `email` mapping specifically, login will appear to succeed at
Cognito but then fail on return to Moodle.

### 4. Save and test
We'll do one test login with a throwaway Cognito account afterward to confirm
it's working, then report back.

**One known quirk to expect and ignore:** the very first login attempt after
someone signs in with Cognito for the first time may bounce back to the Moodle
login page with a "session timed out" message. Trying the same "Hilom Collective"
button a second time immediately succeeds. We've reproduced and confirmed this
is a harmless, self-resolving session-timing thing on Moodle's side (not
specific to your server) — not a sign anything is misconfigured.

Thanks — happy to hop on a call to walk through it live if that's faster.

[name]

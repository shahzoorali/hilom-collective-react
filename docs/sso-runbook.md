# SSO runbook: Cognito ↔ Moodle (Phase 1)

Proven end-to-end on a disposable test box, `learn-test.hilomcollective.com`
(`i-038e4d956e80ff120`, `ap-southeast-1`, terminate after cutover — see below).

## Working configuration

**Cognito** (`ap-southeast-1`, account `651706741660`):
- User pool `hilom-users` — `ap-southeast-1_AA9IeeZ2z`
- Hosted UI domain — `hilom-auth.auth.ap-southeast-1.amazoncognito.com`
- App client `hilom-moodle` — id/secret in Secrets Manager as `hilom/cognito`
- Callback URLs registered for **both** test and production, so no client edit
  is needed at cutover:
  `https://learn-test.hilomcollective.com/admin/oauth2callback.php`,
  `https://www.learn.hilomcollective.com/admin/oauth2callback.php`

**Moodle** `auth_oauth2` issuer, applied by
[`scripts/moodle-configure-cognito.php`](../scripts/moodle-configure-cognito.php)
rather than admin-UI clicks, so the exact config proven here is what production
gets:

```bash
sudo -u www-data php admin/cli/moodle-configure-cognito.php \
  --clientid=<from hilom/cognito> \
  --clientsecret=<from hilom/cognito> \
  --poolid=ap-southeast-1_AA9IeeZ2z \
  --region=ap-southeast-1 \
  --cognitodomain=hilom-auth.auth.ap-southeast-1.amazoncognito.com
```

Key settings the script sets, and why:

| Setting | Value | Reason |
|---|---|---|
| `basicauth` | `1` | Cognito's token endpoint expects the client secret over HTTP Basic. Without this Moodle posts it in the body and Cognito answers `401 invalid_client`. |
| `requireconfirmation` | `0` | Cognito has already verified the email. Leaving Moodle's own confirmation on means the *first* login silently creates an unconfirmed account and bounces back to the login page — this looked identical to the "first login fails" bug during testing before it was ruled out. |
| claim mapping | `email→email`, `given_name→firstname`, `family_name→lastname` | Without the `email` mapping specifically, Moodle can't match or create an account and login dies right after a successful Cognito redirect. |
| `auth` config list | adds `oauth2` **and** `manual` | A fresh Moodle install does not enable `manual` by default, even though the CLI installer's own admin account uses `auth=manual`. Left alone, the admin account — the locked-decision fallback — would be unable to log in with a password at all. Caught by the script's own validation, not assumed. |

## The known first-login bug — reproduced and understood

Confirmed on the test box, matching the plan's warning exactly: the **first**
SSO attempt bounces back to `/login/index.php` with *"Your session has most
likely timed out"*; the **second** attempt (same browser) succeeds immediately,
without Cognito re-prompting for credentials.

Server-side, the first attempt's Apache log shows the callback was reached
correctly — a real authorization `code` and the expected `state` came back from
Cognito, and Moodle responded `303` — so **this is not an OAuth2 failure**.
Moodle's `admin/oauth2callback.php` re-derives the original sesskey from the
`state` parameter and calls `confirm_sesskey()` against the *current* session
before it will proceed; on the first round trip that check fails and Moodle
falls back to treating it as a plain session timeout.

The mechanism is a session-identity mismatch across the redirect out to
Cognito and back — the sesskey minted when the login page first rendered does
not match the session the browser presents on return. It resolves itself on
retry because by then the session cookie is fully established locally. This
was reproduced consistently; a real fix would mean patching Moodle core's
`auth_oauth2` session handling, which is out of scope here.

**Given decision:** ship with this known behavior rather than patch core.
Mitigation is one line in the login flow: *if you're bounced back to the login
page after signing in, click "Hilom Account" again.* Worth a small note on the
login page copy in Phase 7 if it comes up in user feedback.

## Verified on the test box

- Manual (admin) login still works — `auth=manual` was force-enabled by the
  script; without it the CLI installer's own admin account would have been
  locked out entirely.
- SSO login creates a Moodle user correctly: `auth=oauth2`, `confirmed=1`,
  email/first/last name mapped from the Cognito claims.
- Test Cognito user and test Moodle account were both deleted after
  verification — nothing test-related was left behind.

## Applying to production — 🔧 manual, by design

Per the hard rule (never test auth config on production) and the plan marking
this step manual, I have not touched `www.learn.hilomcollective.com`. To apply:

1. SSH or admin-UI access to production Moodle is needed to run the same
   script (`scripts/moodle-configure-cognito.php`) against it — I only hold the
   web admin login given for this project, not server SSH.
2. Run the identical command above against production.
3. Verify one login on `www.learn.hilomcollective.com` with a throwaway
   Cognito user, expecting the same first-attempt/second-attempt pattern.
4. Register the production callback in Cognito if not already present — it
   already is, added proactively during test-box setup.

## Cleanup — 🔧 manual, after cutover is confirmed

- Terminate `i-038e4d956e80ff120` (`hilom-moodle-sso-test`).
- Delete the `learn-test.hilomcollective.com` A record at GoDaddy.
- Delete the `hilom-moodle-test` EC2 key pair and `hilom-moodle-test` security
  group (not needed again once the box is gone).

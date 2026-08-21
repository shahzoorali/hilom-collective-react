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
page after signing in, click "Hilom Collective" again.* Worth a small note on the
login page copy in Phase 7 if it comes up in user feedback.

## Verified on the test box

- Manual (admin) login still works — `auth=manual` was force-enabled by the
  script; without it the CLI installer's own admin account would have been
  locked out entirely.
- SSO login creates a Moodle user correctly: `auth=oauth2`, `confirmed=1`,
  email/first/last name mapped from the Cognito claims.
- Test Cognito user and test Moodle account were both deleted after
  verification — nothing test-related was left behind.

## Applied to production — done

Production did not grant SSH, so the config was applied through Moodle's
admin UI instead (Site administration → Server → OAuth 2 services →
"Create new custom service"), following the click-by-click guide in
[`docs/prod-moodle-request-email.md`](prod-moodle-request-email.md). The
issuer, its three endpoints, and the three user field mappings were entered
manually there, mirroring exactly what `moodle-configure-cognito.php` sets.

**One thing the admin-UI path gets wrong by default that the CLI script
doesn't:** the "Create new custom service" form has no field for
`requireconfirmation` at all — it only appears on the issuer's separate
**Settings** page, defaults to **on**, and there's no reason an admin
clicking through the creation form would think to look for it there. Left at
the default, the very first SSO signup landed on a Moodle "Confirm your
account" waiting-for-email page instead of logging the user in — a different
failure mode than the sesskey retry bug, easy to mistake for the same "first
login is flaky" issue, but with a different fix: turn off **Require email
verification** on the issuer's Settings page, tick the "I understand this is
a security tradeoff" acknowledgement Moodle requires alongside it, and save.
Once fixed, verified end-to-end on production:

- Fresh SSO signup (throwaway Cognito user `prod-sso-test@hilomcollective.com`)
  created the Moodle account correctly — `firstname`/`lastname`/`email` all
  matched the Cognito claims — and logged straight in with **no** confirmation
  bounce and **no** sesskey retry needed on this attempt.
- Verified via the account's public profile page and via `admin/user.php`,
  not just by trusting the redirect.
- Test user deleted from both Cognito and production Moodle afterward; no
  test data left in either system.

Given the admin-UI path already requires production-only settings the CLI
script doesn't need to touch (Manage authentication's built-in `manual`/
`oauth2` handling turned out to differ from the test box too — see below),
**anyone repeating this on another Moodle install should check the issuer's
Settings page for `requireconfirmation`/"Require email verification"
explicitly, even if the create-service form looked complete.**

### Manage authentication — turned out simpler than expected

On the disposable test box, a fresh Moodle install did not have `manual` in
its enabled-auth list, and the script was changed to force-enable it
alongside `oauth2` so the CLI installer's own admin account wouldn't be
locked out. Production's **Manage authentication** page never offers an
enable/disable toggle for "Manual accounts" or "No login" at all — Moodle
hardcodes both as always available regardless of that list. So on an
established install like production, this particular test-box finding
doesn't apply and needed no action; it's left here because it's the kind of
thing worth checking, not assuming, on any *other* Moodle install this
config gets applied to.

## Cleanup — 🔧 manual, after cutover is confirmed

- Terminate `i-038e4d956e80ff120` (`hilom-moodle-sso-test`).
- Delete the `learn-test.hilomcollective.com` A record at GoDaddy.
- Delete the `hilom-moodle-test` EC2 key pair and `hilom-moodle-test` security
  group (not needed again once the box is gone).

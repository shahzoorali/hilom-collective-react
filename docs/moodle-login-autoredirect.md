# Moodle: auto-redirect the login page to Cognito SSO

## Problem this solves

The main site (hilomcollective.com) has a **Hilom Learning Hub** menu item that
links to `https://www.learn.hilomcollective.com/my/`. A logged-out visitor who
clicks it lands on Moodle's **login page** with a single "Hilom Account" button.
Because they already hold a Cognito Hosted UI session from signing in on the main
site, clicking that button leads to a silent OAuth round-trip and straight into
Moodle — so the page is a dead stop with one pointless click.

We cannot remove the click from the React side: `/auth/oauth2/login.php`
requires a `sesskey` bound to the visitor's Moodle session, which only exists
once Moodle has rendered a page for them. The fix has to live on the Moodle
server: make `/login/index.php` perform that click itself.

## What changes

One block appended to Moodle's `config.php`. When a logged-out visitor hits the
login page with a plain GET (no form submit, no error bounce, no `?nosso=1`), it
mints a valid `sesskey` and redirects them to the "Hilom Account" OAuth2 issuer —
exactly what clicking the button does.

- **Native password login is preserved** for admins (the locked decision "Moodle
  native login kept, admins only") via `?nosso=1` — see below.
- **Kill switch:** set `$CFG->hilom_sso_autoredirect = false;` (or delete the
  block). No rebuild, effective on the next request.
- **Fails open:** anything unexpected inside the block is swallowed and Moodle
  renders the normal login page. It can never lock anyone out.

### Interaction with the known first-login bounce

`docs/sso-runbook.md` documents a Moodle-core quirk: the *first ever* SSO attempt
for a brand-new user can bounce back to `/login/index.php` with a session error,
and succeeds on the second attempt. When that happens the bounce carries an
`errorcode` parameter, which this block treats as "show the real page" — so the
user sees the normal login page with the button and clicks it once more, as
today. Returning users who already have a Moodle account are unaffected and get
the zero-click path.

---

## The snippet

Append this to the **end** of `config.php`, *after* the
`require_once(__DIR__ . '/lib/setup.php');` line (on Bitnami:
`/opt/bitnami/moodle/config.php`). That is the supported place for site-level
access rules — the full Moodle API (`sesskey()`, `redirect()`, `optional_param()`,
`\core\oauth2\api`) is available there.

```php
// ---------------------------------------------------------------------------
// Hilom SSO: auto-redirect the login page straight to Cognito.
//
// A logged-out visitor hitting /login/index.php (e.g. from the "Hilom Learning
// Hub" menu link on hilomcollective.com) would otherwise see the login page
// with a "Hilom Account" button they must click. They already have a Cognito
// session from the main site, so that click just leads to a silent round-trip
// and straight in. This performs the click for them.
//
// Admins / manual accounts: append ?nosso=1 to reach the password form, i.e.
//   https://www.learn.hilomcollective.com/login/index.php?nosso=1
// Kill switch: set the line below to false (or remove this whole block).
// ---------------------------------------------------------------------------
$CFG->hilom_sso_autoredirect = true;

if (
    !empty($CFG->hilom_sso_autoredirect)
    && isset($SCRIPT) && $SCRIPT === '/login/index.php'
    && (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET')
    && empty($_POST)
    && !isloggedin()
    && optional_param('nosso',        0,  PARAM_INT) === 0   // admin bypass
    && optional_param('errorcode',    0,  PARAM_INT) === 0   // auth error bounced here -> show real page
    && optional_param('testsession',  0,  PARAM_INT) === 0   // Moodle's session self-test
    && optional_param('loginredirect', 0, PARAM_INT) === 0
    && optional_param('cancel',       '', PARAM_RAW) === ''  // user backed out
) {
    try {
        $hilomissuer = null;
        foreach (\core\oauth2\api::get_all_issuers() as $issuer) {
            // Match by the issuer name set in scripts/moodle-configure-cognito.php
            // (--name, default "Hilom Account"). Adjust if it was named
            // differently in the prod admin UI.
            if ($issuer->get('name') === 'Hilom Account' && $issuer->is_available_for_login()) {
                $hilomissuer = $issuer;
                break;
            }
        }

        if ($hilomissuer !== null) {
            $wantsurl = optional_param('wantsurl', '', PARAM_LOCALURL);
            if ($wantsurl === '') {
                $wantsurl = (new moodle_url('/my/'))->out(false);
            }
            redirect(new moodle_url('/auth/oauth2/login.php', [
                'id'       => $hilomissuer->get('id'),
                'wantsurl' => $wantsurl,
                'sesskey'  => sesskey(),
            ]));
        }
        // No matching issuer -> fall through to the normal login page.
    } catch (\Throwable $e) {
        // Never let this optimisation break login. Log and show the real page.
        debugging('hilom_sso_autoredirect skipped: ' . $e->getMessage(), DEBUG_DEVELOPER);
    }
}
// --- end Hilom SSO auto-redirect ---
```

If the issuer was given a different display name in production, change the
`'Hilom Account'` string. Confirm the name at **Site administration → Server →
OAuth 2 services**, or run:

```bash
sudo -u daemon php admin/cli/cfg.php --component=core --name=none 2>/dev/null; \
echo "issuers:"; sudo -u daemon php -r 'define("CLI_SCRIPT",true); require("/opt/bitnami/moodle/config.php"); foreach (\core\oauth2\api::get_all_issuers() as $i) { printf("  id=%d  name=%s  loginready=%s\n", $i->get("id"), $i->get("name"), $i->is_available_for_login() ? "yes" : "no"); }'
```

(Web user is `daemon` on Bitnami, `www-data` on a Debian/Ubuntu package install.)

---

## Test procedure (disposable box — NOT production)

**Hard rule (CLAUDE.md):** never test auth config on production Moodle. Prove it
on a throwaway Bitnami Moodle first.

The Phase-1 test box (`learn-test.hilomcollective.com`,
`i-038e4d956e80ff120`) was slated for termination after cutover and is likely
gone. Recreate an equivalent, or use any non-prod Moodle that has the same
Cognito issuer configured.

### 0. Prerequisites on the test box

- Moodle reachable over HTTPS on a hostname whose
  `/admin/oauth2callback.php` is a registered callback URL on the `hilom-moodle`
  Cognito app client. The client already lists both
  `learn-test.hilomcollective.com` and `www.learn.hilomcollective.com`
  (see `docs/sso-runbook.md`); a *new* test hostname must be added to the
  client's callback list first, or the callback will fail with `redirect_mismatch`.
- The "Hilom Account" OAuth2 issuer configured and working (run
  `scripts/moodle-configure-cognito.php`, or copy the settings from prod).
- Verify the SSO **button** already works end-to-end before touching
  `config.php` — otherwise you will not be able to tell the snippet apart from a
  pre-existing issuer problem.

### 1. Back up and apply

```bash
sudo cp /opt/bitnami/moodle/config.php /opt/bitnami/moodle/config.php.bak
sudo nano /opt/bitnami/moodle/config.php      # paste the block at the very end
sudo php -l /opt/bitnami/moodle/config.php    # must print "No syntax errors detected"
sudo /opt/bitnami/ctlscript.sh restart apache # clears opcache
```

### 2. Cases to verify

Use a **fresh private/incognito window** for each so sessions don't bleed.

| # | Steps | Expected |
|---|---|---|
| 1 | Not signed in anywhere. Open `https://<testhost>/my/` | Redirects through `/login/index.php` → Cognito Hosted UI (asks for credentials, because no session exists yet). After login, lands on `/my/`. No Moodle login page with a button is ever shown. |
| 2 | In the same window (now has a Cognito session), sign out of **Moodle only**: `https://<testhost>/login/logout.php`. Then open `/my/` again | Straight to `/my/` with **no prompt at all** — Cognito session reused silently. This is the case the main-site menu link hits. |
| 3 | `https://<testhost>/login/index.php?nosso=1` | The normal Moodle login **page with the username/password form** renders. Admin can log in with a password. |
| 4 | As an admin using `?nosso=1`, submit the password form | Logs in normally (POST is excluded from the redirect). |
| 5 | Trigger the first-login bounce if you can (brand-new Cognito user, first ever SSO). If it bounces to `/login/index.php?errorcode=...` | The **normal login page renders** (not an infinite redirect). Clicking the button once more completes login. |
| 6 | Set `$CFG->hilom_sso_autoredirect = false;`, restart apache, open `/my/` logged out | Old behaviour returns: login page with the button, no auto-redirect. |
| 7 | Direct-link check: `https://<testhost>/login/index.php` logged out, `hilom_sso_autoredirect = true` | Auto-redirects to Cognito. |

### 3. Roll back on the test box

```bash
sudo cp /opt/bitnami/moodle/config.php.bak /opt/bitnami/moodle/config.php
sudo /opt/bitnami/ctlscript.sh restart apache
```

---

## Handover: what the Moodle team needs to do on production

You do not have SSH to production Moodle. Give the team below to whoever does.
Steps 1–3 are the change; 4–5 are verification; 6 is rollback.

> ### Change: auto-redirect the Moodle login page to Cognito SSO
>
> **Why:** the main website links users to `.../my/`; today they hit a Moodle
> login page and must click the "Hilom Account" button even though they are
> already signed in via Cognito. This makes that redirect automatic. Native
> password login stays available for admins at `/login/index.php?nosso=1`.
>
> **Risk:** low and reversible. The added code fails open (any error → normal
> login page) and has a config flag to disable it without another edit.
> It changes **no database settings** and **no plugin config** — only
> `config.php`.
>
> **1. Prove it on a non-production Moodle first.** Do not apply directly to
> production. Use the test procedure in
> `docs/moodle-login-autoredirect.md` (this file) on a disposable box.
>
> **2. Back up `config.php`:**
> ```bash
> sudo cp <moodledir>/config.php <moodledir>/config.php.bak-$(date +%F)
> ```
> Production path is whatever the install uses (Bitnami: `/opt/bitnami/moodle`;
> package install: `/var/www/html/moodle` or similar).
>
> **3. Append the snippet** from the "The snippet" section of
> `docs/moodle-login-autoredirect.md` to the **end** of `config.php`, after the
> `require_once(__DIR__ . '/lib/setup.php');` line. Before that, confirm the
> OAuth2 issuer's exact display name at **Site administration → Server → OAuth 2
> services** and edit the `'Hilom Account'` string in the snippet to match.
> Then:
> ```bash
> sudo php -l <moodledir>/config.php     # expect: No syntax errors detected
> ```
> Restart the web server / clear opcache (Bitnami:
> `sudo /opt/bitnami/ctlscript.sh restart apache`; Apache+PHP-FPM:
> `sudo systemctl reload php*-fpm apache2`).
>
> **4. Verify, each in a fresh incognito window:**
> - Signed out everywhere → open `https://www.learn.hilomcollective.com/my/` →
>   Cognito asks for credentials once → lands on `/my/`. No Moodle login-page
>   button shown.
> - Repeat with a live Cognito session (e.g. right after signing in on
>   hilomcollective.com) → `/my/` opens with **no prompt at all**.
> - `https://www.learn.hilomcollective.com/login/index.php?nosso=1` → the
>   username/password form still renders; an admin can log in with a password.
>
> **5. Confirm admins are not locked out** before walking away: log in as an
> admin via `?nosso=1` and submit the password form.
>
> **6. Rollback (if anything is off):** restore the backup and restart:
> ```bash
> sudo cp <moodledir>/config.php.bak-<date> <moodledir>/config.php
> sudo /opt/bitnami/ctlscript.sh restart apache
> ```
> Or, to disable without restoring: change `$CFG->hilom_sso_autoredirect = true;`
> to `false` in the snippet and restart.

## No frontend change required

Once this is live, the existing `Hilom Learning Hub` → `.../my/` menu link
(commit `10ba4e5`) is seamless, and so are the post-purchase "Start learning"
links (`frontend/src/config.ts` → `moodleAccessUrl`). Nothing in this repo needs
to change.

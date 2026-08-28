# Cognito managed login branding

Managed login **v2** styling for the `hilom-users` pool, shared by both app clients.
`managed-login-settings.json` is the source of truth — edit it here, then re-apply.

| Client | Branding ID |
|---|---|
| `hilom-web` (`29bo0gpj7j9u7ofbcii22emj8l`) | `b24c50e3-4cef-4d0c-ada8-8f1d6b49ebea` |
| `hilom-moodle` (`7ckmm1tbljpthfgdk9t41kdhbk`) | `fbfa7b09-a936-4e53-8402-8a45466144bc` |

Colors track the brand tokens in `frontend/src/index.css` (`:root`). Values here are
`RRGGBBAA` with no leading `#`. `colorSchemeMode` is forced to `LIGHT` — the brand guide
defines no dark palette, so the darkMode blocks in the JSON are inert.

Assets: `FORM_LOGO` = `frontend/src/assets/logo-leaf.png`,
`FAVICON_ICO` = `frontend/public/favicon.ico`.

Re-apply with `./apply.sh`.

## Known limits

- Managed login cannot load Google Fonts, so Libre Baskerville / Montserrat do not apply.
  Login pages render in Cloudscape's Open Sans. This gap is not closable via branding.
- **Never set a domain to `--managed-login-version 2` before a branding style exists for
  every app client.** v2 with no style renders "Login pages unavailable" and login is down
  until a style is created.

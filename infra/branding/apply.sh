#!/usr/bin/env bash
# Re-apply managed login branding to both app clients.
set -euo pipefail
cd "$(dirname "$0")"
POOL=ap-southeast-1_AA9IeeZ2z
REGION=ap-southeast-1
REPO=../..

ASSETS=$(mktemp)
trap 'rm -f "$ASSETS"' EXIT
python3 - "$ASSETS" "$REPO" <<'PY'
import base64, json, sys
out, repo = sys.argv[1], sys.argv[2]
def blob(p): return base64.b64encode(open(repo + '/' + p, 'rb').read()).decode()
json.dump([
  {"Category": "FORM_LOGO",   "ColorMode": "LIGHT", "Extension": "PNG",
   "Bytes": blob('frontend/src/assets/logo-leaf.png')},
  {"Category": "FAVICON_ICO", "ColorMode": "LIGHT", "Extension": "ICO",
   "Bytes": blob('frontend/public/favicon.ico')},
], open(out, 'w'))
PY

for ID in b24c50e3-4cef-4d0c-ada8-8f1d6b49ebea fbfa7b09-a936-4e53-8402-8a45466144bc; do
  echo "applying to $ID"
  aws cognito-idp update-managed-login-branding \
    --user-pool-id "$POOL" --managed-login-branding-id "$ID" \
    --no-use-cognito-provided-values \
    --settings "file://managed-login-settings.json" \
    --assets "file://$ASSETS" \
    --region "$REGION" --query 'ManagedLoginBranding.ManagedLoginBrandingId' --output text
done

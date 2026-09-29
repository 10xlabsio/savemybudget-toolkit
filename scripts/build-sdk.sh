#!/bin/sh
# Rebuild src/sdk/smb.js from the SaveMyBudget SDK repo (MIT). Pin the commit in smb.build.json.
set -e
cd "$(dirname "$0")/.."
SDK=${SDK_DIR:-../savemybudget-sdk}
(cd "$SDK" && npm ci --silent && npm run build --silent)
cp "$SDK/dist/smb.js" src/sdk/smb.js
SRI=$(openssl dgst -sha384 -binary src/sdk/smb.js | openssl base64 -A)
BUILD=$(sha256sum src/sdk/smb.js | cut -c1-12)
VER=$(node -p "require('$SDK/package.json').version")
COMMIT=$(git -C "$SDK" rev-parse HEAD)
printf '{ "sdk_version": "%s", "sdk_commit": "%s", "build": "%s", "sri": "sha384-%s", "built_at": "%s" }\n' "$VER" "$COMMIT" "$BUILD" "$SRI" "$(date -u +%FT%TZ)" > src/sdk/smb.build.json
echo "sdk build $BUILD"

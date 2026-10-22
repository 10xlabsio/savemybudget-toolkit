#!/bin/sh
# Rebuild src/sdk/smb.js from a local checkout of the tag source. The commit is pinned in smb.build.json.
# Usage: scripts/build-sdk.sh <path-to-tag-source-checkout>
#    or: SDK_DIR=<path-to-tag-source-checkout> scripts/build-sdk.sh
# The checkout needs a package.json with a "build" script that writes dist/smb.js.
set -e
cd "$(dirname "$0")/.."
SDK=${1:-${SDK_DIR:-}}
if [ -z "$SDK" ]; then
  echo "usage: $0 <path-to-tag-source-checkout> (or set SDK_DIR)" >&2
  exit 1
fi
(cd "$SDK" && npm ci --silent && npm run build --silent)
cp "$SDK/dist/smb.js" src/sdk/smb.js
SRI=$(openssl dgst -sha384 -binary src/sdk/smb.js | openssl base64 -A)
BUILD=$(sha256sum src/sdk/smb.js | cut -c1-12)
VER=$(node -p "require('$SDK/package.json').version")
COMMIT=$(git -C "$SDK" rev-parse HEAD)
printf '{ "sdk_version": "%s", "sdk_commit": "%s", "build": "%s", "sri": "sha384-%s", "built_at": "%s" }\n' "$VER" "$COMMIT" "$BUILD" "$SRI" "$(date -u +%FT%TZ)" > src/sdk/smb.build.json
echo "sdk build $BUILD"

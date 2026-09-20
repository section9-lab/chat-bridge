#!/bin/bash
set -euo pipefail

BRIDGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_NODE="$(python3 "$BRIDGE_ROOT/scripts/bootstrap-runtime.py")"
BRIDGE_NODE_ROOT="$(dirname "$(dirname "$BRIDGE_NODE")")"
export PATH="$BRIDGE_NODE_ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin"
BRIDGE_OUTPUT_DIR="${CHAT_BRIDGE_OUTPUT_DIR:-$BRIDGE_ROOT/dist}"
mkdir -p "$BRIDGE_OUTPUT_DIR"
BRIDGE_OUTPUT_DIR="$(cd "$BRIDGE_OUTPUT_DIR" && pwd)"
BRIDGE_BUNDLE="$BRIDGE_OUTPUT_DIR/Chat Bridge.app"
BRIDGE_SIGN_IDENTITY="${CHAT_BRIDGE_SIGNING_IDENTITY:-Apple Development}"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
if [ -n "${CHAT_BRIDGE_RELEASE_TAG:-}" ]; then
  python3 "$BRIDGE_ROOT/scripts/release.py" metadata "$CHAT_BRIDGE_RELEASE_TAG" >/dev/null
  : "${CHAT_BRIDGE_BUILD_NUMBER:?A release build number is required}"
fi

cd "$BRIDGE_ROOT/bridge"
# Claude Code uses the user's installed CLI; do not bundle a second optional engine.
npm ci --omit=optional --no-audit --no-fund
node "$BRIDGE_ROOT/scripts/patch-imessage.mjs"
npm run build
npm test
cd "$BRIDGE_ROOT/apps/macos"
swift test --force-resolved-versions
swift build -c release --force-resolved-versions
BRIDGE_SWIFT_BIN="$(swift build -c release --show-bin-path)"

# Reusing an output directory must not carry files from an older release.
rm -rf "$BRIDGE_BUNDLE"
mkdir -p "$BRIDGE_BUNDLE/Contents/MacOS" "$BRIDGE_BUNDLE/Contents/Resources/runtime" "$BRIDGE_BUNDLE/Contents/Resources/service/dist"
cp "$BRIDGE_SWIFT_BIN/ChatBridge" "$BRIDGE_BUNDLE/Contents/MacOS/ChatBridge"
cp -R "$BRIDGE_SWIFT_BIN/ChatBridge_ChatBridge.bundle" "$BRIDGE_BUNDLE/Contents/Resources/"
cp "$BRIDGE_ROOT/apps/macos/Info.plist" "$BRIDGE_BUNDLE/Contents/Info.plist"
cp "$BRIDGE_ROOT/apps/macos/Resources/AppIcon.icns" "$BRIDGE_BUNDLE/Contents/Resources/AppIcon.icns"
cp "$BRIDGE_NODE" "$BRIDGE_BUNDLE/Contents/Resources/runtime/node"
cp "$BRIDGE_NODE_ROOT/LICENSE" "$BRIDGE_BUNDLE/Contents/Resources/runtime/LICENSE"
cp "$BRIDGE_ROOT/bridge/package.json" "$BRIDGE_ROOT/bridge/package-lock.json" "$BRIDGE_BUNDLE/Contents/Resources/service/"
cp -R "$BRIDGE_ROOT/bridge/dist/src" "$BRIDGE_BUNDLE/Contents/Resources/service/dist/"
cd "$BRIDGE_BUNDLE/Contents/Resources/service"
npm ci --omit=dev --omit=optional --no-audit --no-fund
node "$BRIDGE_ROOT/scripts/patch-imessage.mjs"
cp "$BRIDGE_ROOT/LICENSE" "$BRIDGE_BUNDLE/Contents/Resources/LICENSE"
if [ -n "${CHAT_BRIDGE_RELEASE_TAG:-}" ]; then
  python3 "$BRIDGE_ROOT/scripts/release.py" stamp "$BRIDGE_BUNDLE" "$CHAT_BRIDGE_RELEASE_TAG" "$CHAT_BRIDGE_BUILD_NUMBER"
fi

# Keep a stable development identity across updates. Distribution requires Developer ID and notarization.
codesign --force --sign "$BRIDGE_SIGN_IDENTITY" "$BRIDGE_BUNDLE/Contents/Resources/runtime/node"
codesign --force --sign "$BRIDGE_SIGN_IDENTITY" "$BRIDGE_BUNDLE/Contents/Resources/service/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
codesign --force --sign "$BRIDGE_SIGN_IDENTITY" "$BRIDGE_BUNDLE"
codesign --verify --deep --strict "$BRIDGE_BUNDLE"
printf '\nBuilt: %s\n' "$BRIDGE_BUNDLE"

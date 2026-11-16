#!/bin/bash
set -euo pipefail

BRIDGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_APP="${1:?Usage: package-dmg.sh APP TAG ARCH OUTPUT_DIR}"
BRIDGE_TAG="${2:?A release tag is required}"
BRIDGE_ARCH="${3:?An architecture is required}"
BRIDGE_OUTPUT="${4:?An output directory is required}"
python3 "$BRIDGE_ROOT/scripts/release.py" metadata "$BRIDGE_TAG" >/dev/null
python3 "$BRIDGE_ROOT/scripts/verify-release-bundle.py" "$BRIDGE_APP" "$BRIDGE_ARCH" "$BRIDGE_TAG"
mkdir -p "$BRIDGE_OUTPUT"
BRIDGE_OUTPUT="$(cd "$BRIDGE_OUTPUT" && pwd)"
BRIDGE_IMAGE="$BRIDGE_OUTPUT/ChatBridge-${BRIDGE_TAG#v}-macos-$BRIDGE_ARCH.dmg"
BRIDGE_TEMP="$(mktemp -d)"
BRIDGE_MOUNT="$BRIDGE_TEMP/mount"
BRIDGE_MOUNTED=false
cleanup() {
  if [ "$BRIDGE_MOUNTED" = true ]; then
    hdiutil detach "$BRIDGE_MOUNT" -quiet || hdiutil detach "$BRIDGE_MOUNT" -force -quiet
  fi
  rm -rf "$BRIDGE_TEMP"
}
trap cleanup EXIT
mkdir -p "$BRIDGE_TEMP/stage" "$BRIDGE_MOUNT"
ditto "$BRIDGE_APP" "$BRIDGE_TEMP/stage/Chat Bridge.app"
ln -s /Applications "$BRIDGE_TEMP/stage/Applications"
hdiutil create -quiet -srcfolder "$BRIDGE_TEMP/stage" -volname "Chat Bridge" -fs HFS+ \
  -format UDZO -imagekey zlib-level=9 "$BRIDGE_TEMP/release.dmg"
hdiutil verify "$BRIDGE_TEMP/release.dmg"
hdiutil attach "$BRIDGE_TEMP/release.dmg" -readonly -nobrowse -noautoopen -mountpoint "$BRIDGE_MOUNT" -quiet
BRIDGE_MOUNTED=true
test "$(readlink "$BRIDGE_MOUNT/Applications")" = /Applications
# Copy out as a user would, then exercise the actual packaged Node and SQLite.
ditto "$BRIDGE_MOUNT/Chat Bridge.app" "$BRIDGE_TEMP/installed/Chat Bridge.app"
python3 "$BRIDGE_ROOT/scripts/verify-release-bundle.py" "$BRIDGE_TEMP/installed/Chat Bridge.app" "$BRIDGE_ARCH" "$BRIDGE_TAG"
"$BRIDGE_TEMP/installed/Chat Bridge.app/Contents/Resources/runtime/node" "$BRIDGE_ROOT/scripts/smoke-bundle.mjs" \
  "$BRIDGE_TEMP/installed/Chat Bridge.app" "$BRIDGE_OUTPUT/bundle-smoke-$BRIDGE_ARCH.json"
hdiutil detach "$BRIDGE_MOUNT" -quiet
BRIDGE_MOUNTED=false
# Replace a previous local artifact only after all checks pass.
mv "$BRIDGE_TEMP/release.dmg" "$BRIDGE_IMAGE"
printf 'Verified DMG: %s\n' "$BRIDGE_IMAGE"

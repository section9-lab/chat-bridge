#!/bin/bash
set -euo pipefail
BRIDGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_ICON_TMP="$(mktemp -d)"
trap 'rm -rf "$BRIDGE_ICON_TMP"' EXIT
# Icon Composer sources require Xcode 26+. Commit both compiled resources so
# release builds can keep using Xcode 16.4 and the macOS 14 deployment target.
xcrun actool "$BRIDGE_ROOT/apps/macos/Resources/AppIcon.icon" \
  --platform macosx --minimum-deployment-target 14.0 --app-icon AppIcon \
  --compile "$BRIDGE_ICON_TMP" --output-partial-info-plist "$BRIDGE_ICON_TMP/icon-info.plist"
cp "$BRIDGE_ICON_TMP/AppIcon.icns" "$BRIDGE_ROOT/apps/macos/Resources/AppIcon.icns"
cp "$BRIDGE_ICON_TMP/Assets.car" "$BRIDGE_ROOT/apps/macos/Resources/Assets.car"
printf 'Updated AppIcon.icns and Assets.car from the native icon source.\n'

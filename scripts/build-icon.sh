#!/bin/bash
set -euo pipefail
BRIDGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_ICON_TMP="$(mktemp -d)"
trap 'rm -rf "$BRIDGE_ICON_TMP"' EXIT
swift "$BRIDGE_ROOT/scripts/generate-app-icon.swift" "$BRIDGE_ICON_TMP/AppIcon.iconset"
iconutil -c icns "$BRIDGE_ICON_TMP/AppIcon.iconset" -o "$BRIDGE_ROOT/apps/macos/Resources/AppIcon.icns"
printf 'Updated AppIcon.icns from the brand master.\n'

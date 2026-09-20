#!/bin/bash
set -euo pipefail
BRIDGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_DEMO_TMP="$(mktemp -d)"
trap 'rm -rf "$BRIDGE_DEMO_TMP"' EXIT
cd "$BRIDGE_ROOT"
# Build the real views, then stage an offline-only copy with fixture state.
swift build --package-path apps/macos -c debug
BRIDGE_SWIFT_BIN="$(swift build --package-path apps/macos -c debug --show-bin-path)"
python3 scripts/prepare-demo-sources.py "$BRIDGE_ROOT" "$BRIDGE_DEMO_TMP/sources"
rg -v '/ChatBridge.build/' "$BRIDGE_SWIFT_BIN/ChatBridge.product/Objects.LinkFileList" > "$BRIDGE_DEMO_TMP/dependencies.txt"
swiftc -swift-version 5 -parse-as-library \
  -I "$BRIDGE_SWIFT_BIN/Modules" -I "$BRIDGE_SWIFT_BIN/cmark_gfm.build" -I "$BRIDGE_SWIFT_BIN/cmark_gfm_extensions.build" \
  "$BRIDGE_DEMO_TMP/sources/"*.swift "$BRIDGE_SWIFT_BIN/ChatBridge.build/DerivedSources/resource_bundle_accessor.swift" \
  scripts/render-native-demo.swift @"$BRIDGE_DEMO_TMP/dependencies.txt" -o "$BRIDGE_DEMO_TMP/native"
"$BRIDGE_DEMO_TMP/native" "$BRIDGE_DEMO_TMP/native-frames"
swiftc apps/macos/Sources/ChatBridge/MenuBar.swift scripts/render-product-demo.swift -o "$BRIDGE_DEMO_TMP/render"
"$BRIDGE_DEMO_TMP/render" "$BRIDGE_DEMO_TMP/native-frames" "$BRIDGE_DEMO_TMP/export"
ffmpeg -hide_banner -loglevel error -y -i "$BRIDGE_DEMO_TMP/export/chat-bridge-demo.mp4" \
  -filter_complex '[0:v]fps=15,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle' \
  -loop 0 "$BRIDGE_DEMO_TMP/export/chat-bridge-demo.gif"
# Publish all three only after both formats have finished successfully.
cp "$BRIDGE_DEMO_TMP/export/"chat-bridge-demo* docs/assets/
printf 'Updated the product GIF, MP4, and static poster.\n'

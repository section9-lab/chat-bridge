#!/bin/bash
set -euo pipefail
BRIDGE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_INTRO_TMP="$(mktemp -d)"
trap 'rm -rf "$BRIDGE_INTRO_TMP"' EXIT
cd "$BRIDGE_ROOT"
# Play the app's intro from its production views and capture only its window. Needs Screen Recording permission.
swift build --package-path apps/macos -c debug
BRIDGE_SWIFT_BIN="$(swift build --package-path apps/macos -c debug --show-bin-path)"
BRIDGE_SOURCES=()
for source in apps/macos/Sources/ChatBridge/*.swift apps/macos/Sources/ChatBridge/Onboarding/*.swift; do
  case "$(basename "$source")" in AppMain.swift|AppDelegate.swift) ;; *) BRIDGE_SOURCES+=("$source") ;; esac
done
grep -v '/ChatBridge.build/' "$BRIDGE_SWIFT_BIN/ChatBridge.product/Objects.LinkFileList" > "$BRIDGE_INTRO_TMP/dependencies.txt"
# Only the version, so the window footer reads like the app's without borrowing its bundle identity or defaults.
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' apps/macos/Info.plist)" \
  "$BRIDGE_INTRO_TMP/version.plist" >/dev/null
swiftc -swift-version 5 -parse-as-library \
  -I "$BRIDGE_SWIFT_BIN/Modules" -I "$BRIDGE_SWIFT_BIN/cmark_gfm.build" -I "$BRIDGE_SWIFT_BIN/cmark_gfm_extensions.build" \
  "${BRIDGE_SOURCES[@]}" "$BRIDGE_SWIFT_BIN/ChatBridge.build/DerivedSources/resource_bundle_accessor.swift" \
  scripts/record-intro.swift @"$BRIDGE_INTRO_TMP/dependencies.txt" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$BRIDGE_INTRO_TMP/version.plist" -o "$BRIDGE_INTRO_TMP/record"
"$BRIDGE_INTRO_TMP/record" "$BRIDGE_INTRO_TMP/intro.mov"
# Start once the desktop has dimmed, so the loop runs from the closing fade straight back into the icon.
BRIDGE_INTRO_START=1.2
mkdir -p "$BRIDGE_INTRO_TMP/export"
ffmpeg -hide_banner -loglevel error -y -ss "$BRIDGE_INTRO_START" -i "$BRIDGE_INTRO_TMP/intro.mov" \
  -vf 'fps=30,scale=1512:-2:flags=lanczos' -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -movflags +faststart -an \
  "$BRIDGE_INTRO_TMP/export/chat-bridge-intro.mp4"
ffmpeg -hide_banner -loglevel error -y -i "$BRIDGE_INTRO_TMP/export/chat-bridge-intro.mp4" \
  -filter_complex '[0:v]fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle' \
  -loop 0 "$BRIDGE_INTRO_TMP/export/chat-bridge-intro.gif"
# The still: Claude's result on the Mac and in Messages at once.
ffmpeg -hide_banner -loglevel error -y -ss "${BRIDGE_INTRO_POSTER:-23.5}" -i "$BRIDGE_INTRO_TMP/export/chat-bridge-intro.mp4" \
  -frames:v 1 "$BRIDGE_INTRO_TMP/export/chat-bridge-intro-poster.png"
# Publish all three only after every format has finished successfully.
cp "$BRIDGE_INTRO_TMP/export/"chat-bridge-intro* docs/assets/
printf 'Updated the intro GIF, MP4, and static poster.\n'

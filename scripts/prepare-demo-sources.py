"""Stage production views for offline artwork, without changing application files."""
from pathlib import Path
import json
import sys

root, destination = map(Path, sys.argv[1:])
source = root / "apps/macos/Sources/ChatBridge"
destination.mkdir(parents=True, exist_ok=True)
translations = json.loads((root / "scripts/demo-ui.en.json").read_text())

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f"Demo fixture no longer matches production view: {old[:70]}")
    return text.replace(old, new, 1)

for path in source.glob("*.swift"):
    if path.name in {"AppMain.swift", "AppDelegate.swift"}:
        continue
    text = path.read_text()
    if path.name == "SettingsView.swift":
        text = replace_once(text, "@State private var tab = 0", "@State var tab = 0")
    if path.name == "RoutingSettings.swift":
        # Do not access the real keychain or call a routing provider while rendering.
        text = replace_once(text, ".task(id: provider.id) { await loadKey() }", "")
    if path.name == "ChatView.swift":
        text = replace_once(text, "private struct SessionBrowser: View", "struct SessionBrowser: View")
        for field in ("projects", "sessions", "project"):
            text = replace_once(text, f"@State private var {field} " if field == "project" else f"@State private var {field}:",
                                f"@State var {field} " if field == "project" else f"@State var {field}:")
        text = replace_once(text, '''.task(id: service.viewedAgent + ":" + project + ":" + query) {
            try? await Task.sleep(nanoseconds: 150_000_000)
            if !Task.isCancelled { await load(refresh: catalogAgent != service.viewedAgent) }
        }''', "")
    # Localize only the offline artwork copy. No product source or user preference is changed.
    for original, english in translations.items():
        text = text.replace(json.dumps(original, ensure_ascii=False), json.dumps(english, ensure_ascii=False))
    (destination / path.name).write_text(text)

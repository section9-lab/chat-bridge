#!/usr/bin/env python3
"""Check a release bundle before and after moving it through a disk image."""
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys

from release import parse_tag


app, arch, tag = sys.argv[1:]
if arch not in ("arm64", "x86_64"):
    raise SystemExit("Expected arm64 or x86_64.")
contents = Path(app) / "Contents"
version = parse_tag(tag)
info = plistlib.loads((contents / "Info.plist").read_bytes())
assert info["CFBundleIdentifier"] == "com.chatbridge.app", "Wrong bundle identifier"
assert info["CFBundleShortVersionString"] == version["app_version"], "Wrong app version"
assert info["ChatBridgeReleaseVersion"] == version["version"], "Wrong release version"
assert re.fullmatch(r"[1-9][0-9]*", info["CFBundleVersion"]), "Invalid build number"
assert info["LSMinimumSystemVersion"] == "14.0", "Unexpected minimum macOS version"
service = contents / "Resources/service"
assert json.loads((service / "package.json").read_text())["version"] == version["version"], "Wrong service version"
lock = json.loads((service / "package-lock.json").read_text())
assert lock["version"] == lock["packages"][""]["version"] == version["version"], "Wrong service lock version"

required = ["MacOS/ChatBridge", "Resources/runtime/node", "Resources/runtime/LICENSE",
            "Resources/AppIcon.icns", "Resources/LICENSE",
            "Resources/ChatBridge_ChatBridge.bundle/AgentIcons/codex-light.png",
            "Resources/service/dist/src/main.js",
            "Resources/service/node_modules/better-sqlite3/build/Release/better_sqlite3.node"]
for name in required:
    assert (contents / name).is_file(), f"Missing bundle resource: {name}"

# Include every Mach-O dependency, not only the main executable.
magic = {bytes.fromhex(value) for value in ("cffaedfe", "cefaedfe", "feedface", "feedfacf",
                                           "cafebabe", "cafebabf", "bebafeca", "bfbafeca")}
native_count = 0
for path in contents.rglob("*"):
    if not path.is_file() or path.is_symlink():
        continue
    with path.open("rb") as source:
        if source.read(4) not in magic:
            continue
    native_count += 1
    actual = subprocess.check_output(["lipo", "-archs", str(path)], text=True).strip()
    assert actual == arch, f"Wrong architecture: {path}: {actual}; expected {arch}"
    subprocess.run(["codesign", "--verify", "--strict", str(path)], check=True)
    libraries = subprocess.check_output(["otool", "-L", str(path)], text=True).splitlines()[1:]
    for line in libraries:
        library = line.strip().split(" (", 1)[0]
        assert library.startswith(("/System/Library/", "/usr/lib/", "@rpath/", "@loader_path/", "@executable_path/")), \
            f"Nonportable library dependency: {library}"
    commands = subprocess.check_output(["otool", "-l", str(path)], text=True)
    minimums = re.findall(r"(?:\bminos\s+|LC_VERSION_MIN_MACOSX\s+cmdsize\s+\d+\s+version\s+)([0-9.]+)", commands)
    assert minimums, f"Missing minimum macOS version: {path}"
    for minimum in minimums:
        parts = tuple(map(int, minimum.split(".")))
        assert (parts + (0, 0))[:3] <= (14, 0, 0), f"Requires macOS {minimum}, newer than the advertised 14.0: {path}"
assert native_count >= 3, "App, Node and SQLite native binaries must be present"
subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
signature = subprocess.run(["codesign", "-d", "--verbose=4", str(app)], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
assert "Signature=adhoc" in signature.stderr, "This release pipeline expects ad-hoc signing"
runtime = contents / "Resources/runtime/node"
details = json.loads(subprocess.check_output([str(runtime), "-p", "JSON.stringify({arch:process.arch,version:process.version})"],
                                            text=True, env={"PATH": "/usr/bin:/bin"}))
expected_node = (Path(__file__).resolve().parents[1] / ".nvmrc").read_text().strip()
assert details == {"arch": "x64" if arch == "x86_64" else "arm64", "version": "v" + expected_node}, "Wrong bundled Node runtime"
print(f"Verified {version['version']} ({arch}): {native_count} native binaries, resources, versions, signatures and deployment targets.")

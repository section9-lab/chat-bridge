#!/usr/bin/env python3
"""Fetch the fixed Node runtime and verify its official SHA-256 manifest."""
import hashlib
import pathlib
import platform
import subprocess
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSION = (ROOT / ".nvmrc").read_text().strip()
ARCH = {"arm64": "arm64", "x86_64": "x64"}.get(platform.machine())
if platform.system() != "Darwin" or not ARCH:
    raise SystemExit("This development bundle currently supports macOS arm64/x64 only.")
NAME = "node-v" + VERSION + "-darwin-" + ARCH
CACHE = ROOT / ".runtime"
BINARY = CACHE / NAME / "bin/node"
if BINARY.exists():
    actual = subprocess.check_output([str(BINARY), "--version"], text=True).strip()
    if actual != "v" + VERSION:
        raise SystemExit("Cached Node version does not match .nvmrc.")
    print(BINARY)
    raise SystemExit(0)
CACHE.mkdir(exist_ok=True)
BASE = "https://nodejs.org/dist/v" + VERSION + "/"
ARCHIVE = NAME + ".tar.gz"
manifest = urllib.request.urlopen(BASE + "SHASUMS256.txt", timeout=60).read().decode()
expected = next((line.split()[0] for line in manifest.splitlines() if line.split()[-1] == ARCHIVE), None)
if not expected:
    raise SystemExit("Runtime is absent from the official checksum manifest.")
destination = CACHE / ARCHIVE
with urllib.request.urlopen(BASE + ARCHIVE, timeout=60) as response, destination.open("wb") as output:
    while chunk := response.read(1024 * 1024):
        output.write(chunk)
actual = hashlib.sha256(destination.read_bytes()).hexdigest()
if actual != expected:
    destination.unlink()
    raise SystemExit("Runtime checksum mismatch.")
(CACHE / (ARCHIVE + ".sha256")).write_text(expected + "  " + ARCHIVE + "\n")
subprocess.run(["/usr/bin/tar", "-xzf", str(destination), "-C", str(CACHE)], check=True)
destination.unlink()
print(BINARY)

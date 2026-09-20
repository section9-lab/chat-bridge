#!/usr/bin/env python3
"""Version and publish tag releases. Uses only Python's standard library and gh."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile


def parse_tag(tag):
    match = re.fullmatch(r"v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))"
                         r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?", tag)
    if not match or any(part.isdigit() and len(part) > 1 and part.startswith("0")
                        for part in (match.group(2) or "").split(".")):
        raise ValueError("Invalid release tag: use vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.1 (no build metadata).")
    return {"version": tag[1:], "app_version": match.group(1), "prerelease": match.group(2) is not None}


def stamp_bundle(app, tag, build):
    version = parse_tag(tag)
    if not re.fullmatch(r"[1-9][0-9]*", build):
        raise ValueError("The build number must be a positive integer without leading zeros.")
    contents = Path(app) / "Contents"
    info_path = contents / "Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    info.update(CFBundleShortVersionString=version["app_version"], CFBundleVersion=build,
                ChatBridgeReleaseVersion=version["version"])
    info_path.write_bytes(plistlib.dumps(info, sort_keys=False))
    for filename in ("package.json", "package-lock.json"):
        path = contents / "Resources/service" / filename
        package = json.loads(path.read_text())
        package["version"] = version["version"]
        if filename == "package-lock.json":
            package["packages"][""]["version"] = version["version"]
        path.write_text(json.dumps(package, indent=2) + "\n")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_assets(directory, tag):
    version = parse_tag(tag)["version"]
    directory = Path(directory)
    expected = {f"ChatBridge-{version}-macos-{arch}.dmg" for arch in ("arm64", "x86_64")}
    if {path.name for path in directory.glob("*.dmg")} != expected:
        raise ValueError("Both architecture DMGs, and only those for this tag, are required.")
    files = [directory / name for name in sorted(expected)]
    if any(path.is_symlink() or not path.is_file() or path.stat().st_size == 0 for path in files):
        raise ValueError("A release artifact is empty, a symlink, or not a regular file.")
    checksums = directory / "SHA256SUMS.txt"
    checksums.write_text("".join(f"{sha256(path)}  {path.name}\n" for path in files))
    return files + [checksums]


def gh(*args):
    result = subprocess.run(["gh", *map(str, args)], check=True, stdout=subprocess.PIPE, text=True)
    if args[0] == "api":
        return json.loads(result.stdout)
    if result.stdout:
        print(result.stdout, end="")


def publish(directory, tag, repository, commit):
    version = parse_tag(tag)
    files = prepare_assets(directory, tag)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("A repository and full commit SHA are required.")
    api = f"repos/{repository}"
    if gh("api", f"{api}/commits/{tag}")["sha"] != commit:
        raise ValueError("The remote tag no longer points to the built commit.")
    releases = gh("api", f"{api}/releases?per_page=100", "--paginate", "--slurp")
    release = next((item for page in releases for item in page if item["tag_name"] == tag), None)
    marker = f"<!-- chat-bridge-release:{commit} -->"
    names = {path.name for path in files}
    if release:
        if not release["draft"]:
            raise ValueError("This release is already published; its assets will not be replaced.")
        if marker not in (release.get("body") or "") or any(asset["name"] not in names for asset in release["assets"]):
            raise ValueError("A different or manually edited draft exists; inspect it before retrying.")
    else:
        notes = f"""{marker}
## Downloads

- **Apple Silicon (M1 and later):** `ChatBridge-{version['version']}-macos-arm64.dmg`
- **Intel:** `ChatBridge-{version['version']}-macos-x86_64.dmg`
- **Checksums:** `SHA256SUMS.txt` (SHA-256)

Requires macOS 14 or later. Open the DMG and drag **Chat Bridge** to **Applications**.
Node.js and the local bridge service are included. Install and sign in to your preferred AI agent separately.

## Signing and first launch

These builds are ad-hoc signed and **not notarized** by Apple. If macOS blocks opening the app,
review the download and use **System Settings → Privacy & Security → Open Anyway** for this app.
iMessage requires Full Disk Access and Messages sign-in. App updates may require granting Full Disk Access again.
WeChat requires pairing. Keep your Mac awake, online, and Chat Bridge running.

Built from `{commit}`. Native builds and bundled-service checks passed on both architectures.
Messaging accounts and third-party Agent services are not exercised by release CI.
"""
        with tempfile.TemporaryDirectory(prefix="chat-bridge-notes-") as temp:
            note_path = Path(temp) / "notes.md"
            note_path.write_text(notes)
            args = ["release", "create", tag, "--repo", repository, "--draft", "--verify-tag",
                    "--title", f"Chat Bridge {tag}", "--notes-file", str(note_path), "--generate-notes"]
            if version["prerelease"]:
                args.append("--prerelease")
            gh(*args)
        releases = gh("api", f"{api}/releases?per_page=100", "--paginate", "--slurp")
        release = next(item for page in releases for item in page if item["tag_name"] == tag)
    gh("release", "upload", tag, *map(str, files), "--repo", repository, "--clobber")
    uploaded = gh("api", f"{api}/releases/{release['id']}")
    if not uploaded["draft"] or {asset["name"] for asset in uploaded["assets"]} != names:
        raise ValueError("Uploaded asset set is incomplete or the release is no longer a draft.")
    for path in files:
        asset = next(item for item in uploaded["assets"] if item["name"] == path.name)
        if asset["size"] != path.stat().st_size or asset.get("digest") != "sha256:" + sha256(path):
            raise ValueError(f"Uploaded asset failed size or SHA-256 verification: {path.name}")
    # Check the tag again after uploading; never publish binaries for a moved tag.
    if gh("api", f"{api}/commits/{tag}")["sha"] != commit:
        raise ValueError("The remote tag changed during upload and no longer points to the built commit.")
    prerelease = str(version["prerelease"]).lower()
    gh("api", f"{api}/releases/{release['id']}", "--method", "PATCH", "-F", "draft=false",
       "-F", f"prerelease={prerelease}", "-f", "make_latest=" + ("false" if version["prerelease"] else "legacy"))
    print(f"Published https://github.com/{repository}/releases/tag/{tag}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    metadata = commands.add_parser("metadata")
    metadata.add_argument("tag")
    stamp = commands.add_parser("stamp")
    stamp.add_argument("app", type=Path)
    stamp.add_argument("tag")
    stamp.add_argument("build")
    release = commands.add_parser("publish")
    release.add_argument("directory", type=Path)
    release.add_argument("tag")
    release.add_argument("repository")
    release.add_argument("commit")
    args = parser.parse_args()
    try:
        if args.command == "metadata":
            for key, value in parse_tag(args.tag).items():
                print(f"{key}={str(value).lower() if isinstance(value, bool) else value}")
        elif args.command == "stamp":
            stamp_bundle(args.app, args.tag, args.build)
        else:
            publish(args.directory, args.tag, args.repository, args.commit)
    except (ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Release failed: {error}\n")


if __name__ == "__main__":
    main()

import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "release.py"
COMMIT = "a" * 40
TAG = "v1.2.3-rc.1"


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "Release automation has not been implemented")
        spec = importlib.util.spec_from_file_location("release", SCRIPT)
        self.release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.release)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def assets(self, tag=TAG):
        for arch in ("arm64", "x86_64"):
            (self.root / f"ChatBridge-{tag[1:]}-macos-{arch}.dmg").write_bytes(arch.encode())

    def test_stable_tag(self):
        self.assertEqual(self.release.parse_tag("v1.2.3"), {
            "version": "1.2.3", "app_version": "1.2.3", "prerelease": False,
        })

    def test_prerelease_keeps_its_label_and_numeric_app_version(self):
        self.assertEqual(self.release.parse_tag(TAG), {
            "version": "1.2.3-rc.1", "app_version": "1.2.3", "prerelease": True,
        })
        self.assertTrue(self.release.parse_tag("v0.4.0-beta.12")["prerelease"])

    def test_invalid_tags_are_rejected(self):
        for tag in ("main", "1.2.3", "v1.2", "v01.2.3", "v1.2.3-", "v1.2.3-rc.01",
                    "v1.2.3+build.1", "v1.2.3/arm64", "v1.2.3\nversion=evil", "v1.2.3;id"):
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, "Invalid release tag"):
                self.release.parse_tag(tag)

    def bundle(self):
        app = self.root / "Chat Bridge.app"
        service = app / "Contents/Resources/service"
        service.mkdir(parents=True)
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "com.chatbridge.app", "CFBundleShortVersionString": "0.3.0",
            "CFBundleVersion": "3", "LSMinimumSystemVersion": "13.5",
        }))
        (service / "package.json").write_text(json.dumps({"name": "fixture", "version": "0.3.0"}))
        (service / "package-lock.json").write_text(json.dumps({
            "version": "0.3.0", "packages": {"": {"version": "0.3.0"}, "node_modules/a": {"version": "9.0.0"}},
        }))
        return app

    def test_stamp_updates_only_release_metadata(self):
        app = self.bundle()
        self.release.stamp_bundle(app, TAG, "42")
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        self.assertEqual(info["CFBundleShortVersionString"], "1.2.3")
        self.assertEqual(info["CFBundleVersion"], "42")
        self.assertEqual(info["ChatBridgeReleaseVersion"], "1.2.3-rc.1")
        self.assertEqual(info["CFBundleIdentifier"], "com.chatbridge.app")
        self.assertEqual(info["LSMinimumSystemVersion"], "13.5")
        service = app / "Contents/Resources/service"
        self.assertEqual(json.loads((service / "package.json").read_text())["version"], "1.2.3-rc.1")
        lock = json.loads((service / "package-lock.json").read_text())
        self.assertEqual(lock["version"], "1.2.3-rc.1")
        self.assertEqual(lock["packages"][""]["version"], "1.2.3-rc.1")
        self.assertEqual(lock["packages"]["node_modules/a"]["version"], "9.0.0")

    def test_invalid_build_number_does_not_mutate_bundle(self):
        app = self.bundle()
        original = (app / "Contents/Info.plist").read_bytes()
        for build in ("0", "-1", "1.0", "01", "", "42\nextra=yes"):
            with self.subTest(build=build), self.assertRaisesRegex(ValueError, "build number"):
                self.release.stamp_bundle(app, TAG, build)
        self.assertEqual((app / "Contents/Info.plist").read_bytes(), original)

    def test_checksum_file_covers_both_architectures(self):
        self.assets()
        files = self.release.prepare_assets(self.root, TAG)
        self.assertEqual(len(files), 3)
        lines = (self.root / "SHA256SUMS.txt").read_text().splitlines()
        self.assertEqual(len(lines), 2)
        for line in lines:
            digest, name = line.split("  ")
            self.assertEqual(digest, hashlib.sha256((self.root / name).read_bytes()).hexdigest())

    def test_missing_architecture_fails_before_creating_checksums(self):
        self.assets()
        (self.root / "ChatBridge-1.2.3-rc.1-macos-x86_64.dmg").unlink()
        with self.assertRaisesRegex(ValueError, "Both architecture"):
            self.release.prepare_assets(self.root, TAG)
        self.assertFalse((self.root / "SHA256SUMS.txt").exists())

    def test_empty_or_wrong_version_artifact_is_rejected(self):
        self.assets()
        (self.root / "ChatBridge-1.2.3-rc.1-macos-x86_64.dmg").write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "empty"):
            self.release.prepare_assets(self.root, TAG)
        self.assets()
        (self.root / "ChatBridge-0.3.0-macos-arm64.dmg").write_bytes(b"old")
        with self.assertRaisesRegex(ValueError, "Both architecture"):
            self.release.prepare_assets(self.root, TAG)

    def publish(self, remote):
        with patch.object(self.release, "gh", remote):
            self.release.publish(self.root, TAG, "owner/repo", COMMIT)

    def test_publish_happens_after_all_assets_are_verified(self):
        self.assets()
        remote = FakeGitHub()
        self.publish(remote)
        self.assertTrue(remote.published)
        self.assertEqual(remote.uploaded, 3)
        self.assertTrue(remote.checked_uploads)
        self.assertTrue(remote.prerelease)

    def test_new_draft_can_publish_before_it_appears_in_release_list(self):
        self.assets()
        remote = FakeGitHub(visible_in_list=False)
        try:
            self.publish(remote)
        except StopIteration:
            self.fail("Publishing must not depend on a new draft appearing in the release list immediately")
        self.assertTrue(remote.created)
        self.assertTrue(remote.published)
        self.assertEqual(remote.uploaded, 3)

    def test_missing_architecture_never_calls_github(self):
        remote = FakeGitHub()
        with self.assertRaises(ValueError):
            self.publish(remote)
        self.assertEqual(remote.calls, [])

    def test_changed_remote_tag_never_creates_release(self):
        self.assets()
        remote = FakeGitHub(commit="b" * 40)
        with self.assertRaisesRegex(ValueError, "tag.*commit"):
            self.publish(remote)
        self.assertFalse(remote.created)
        self.assertFalse(remote.published)

    def test_published_release_is_never_overwritten(self):
        self.assets()
        remote = FakeGitHub(draft=False)
        with self.assertRaisesRegex(ValueError, "already published"):
            self.publish(remote)
        self.assertEqual(remote.uploaded, 0)
        self.assertFalse(remote.published)

    def test_interrupted_draft_can_be_resumed(self):
        self.assets()
        remote = FakeGitHub(draft=True)
        self.publish(remote)
        self.assertFalse(remote.created)
        self.assertTrue(remote.published)

    def test_unrelated_draft_is_not_overwritten(self):
        self.assets()
        remote = FakeGitHub(draft=True, marker="Manually written release")
        with self.assertRaisesRegex(ValueError, "different.*draft"):
            self.publish(remote)
        self.assertEqual(remote.uploaded, 0)

    def test_corrupt_upload_stays_draft(self):
        self.assets()
        remote = FakeGitHub(corrupt=True)
        with self.assertRaisesRegex(ValueError, "Uploaded asset"):
            self.publish(remote)
        self.assertFalse(remote.published)

    def test_failed_upload_stays_draft(self):
        self.assets()
        remote = FakeGitHub(fail_upload=True)
        with self.assertRaisesRegex(RuntimeError, "Upload failed"):
            self.publish(remote)
        self.assertFalse(remote.published)


class FakeGitHub:
    """An offline stand-in for the GitHub API; no account or release is accessed."""
    def __init__(self, draft=None, commit=COMMIT, marker=None, corrupt=False, fail_upload=False, visible_in_list=True):
        self.commit = commit
        self.release = None if draft is None else {
            "id": 7, "tag_name": TAG, "draft": draft, "assets": [],
            "body": marker if marker is not None else f"<!-- chat-bridge-release:{COMMIT} -->",
        }
        self.corrupt = corrupt
        self.fail_upload = fail_upload
        self.visible_in_list = visible_in_list
        self.created = self.published = self.checked_uploads = self.prerelease = False
        self.uploaded = 0
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        if args[0] == "api":
            endpoint = args[1]
            if "/commits/" in endpoint:
                return {"sha": self.commit}
            if "--paginate" in args:
                return [[self.release] if self.release and self.visible_in_list else []]
            if endpoint.endswith("/releases") and "POST" in args:
                payload = json.loads(Path(args[args.index("--input") + 1]).read_text())
                assert payload["draft"] and payload["prerelease"] and payload["generate_release_notes"]
                assert "ad-hoc" in payload["body"] and "not notarized" in payload["body"]
                self.created = True
                self.release = {"id": 7, "tag_name": payload["tag_name"], "draft": True,
                                "assets": [], "body": payload["body"]}
                return self.release
            if endpoint.endswith("/releases/7"):
                if "PATCH" in args:
                    assert self.checked_uploads, "Publishing must follow remote asset verification"
                    self.published = True
                    self.prerelease = "prerelease=true" in args
                    return self.release
                self.checked_uploads = self.uploaded == 3
                return self.release
        if args[:2] == ("release", "upload"):
            if self.fail_upload:
                raise RuntimeError("Upload failed")
            self.release["assets"] = []
            for name in args[3:]:
                if name.startswith("--"):
                    continue
                path = Path(name)
                if not path.is_file():
                    continue
                self.uploaded += 1
                self.release["assets"].append({"name": path.name, "size": path.stat().st_size,
                    "digest": "sha256:" + ("0" * 64 if self.corrupt else hashlib.sha256(path.read_bytes()).hexdigest())})
            return None
        raise AssertionError(f"Unexpected GitHub operation: {args}")


if __name__ == "__main__":
    unittest.main()

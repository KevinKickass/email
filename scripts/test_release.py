import json
from pathlib import Path
import tempfile
import unittest
from release import assemble, validate

VERSION = json.loads(Path("package.json").read_text())["version"]
TAG = f"v{VERSION}"


class ReleaseTests(unittest.TestCase):
    def fixtures(self, root):
        source = root / "artifacts"
        source.mkdir()
        for name in (f"email_{VERSION}_x64-setup.exe", f"email_{VERSION}_x86-setup.exe", f"email_{VERSION}_amd64.AppImage"):
            (source / name).write_bytes(b"package")
            (source / (name + ".sig")).write_text("signature-fixture")
        return source

    def test_complete_manifest_has_all_three_architectures_and_checksums(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assemble(TAG, self.fixtures(root), root / "release")
            manifest = json.loads((root / "release/latest.json").read_text())
            self.assertEqual(set(manifest["platforms"]), {"windows-x86_64", "windows-i686", "linux-x86_64"})
            self.assertEqual(len((root / "release/SHA256SUMS").read_text().splitlines()), 7)
            self.assertTrue(all(f"/{TAG}/" in p["url"] for p in manifest["platforms"].values()))

    def test_missing_signature_prevents_manifest_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.fixtures(root)
            (source / f"email_{VERSION}_x86-setup.exe.sig").unlink()
            with self.assertRaises(FileNotFoundError):
                assemble(TAG, source, root / "release")
            self.assertFalse((root / "release/latest.json").exists())

    def test_version_mismatch_and_prerelease_are_rejected(self):
        for tag in ("v99.0.0", "v0.1.1-beta.1", "v0.1.1;echo bad"):
            with self.assertRaises(ValueError):
                validate(tag)


if __name__ == "__main__":
    unittest.main()

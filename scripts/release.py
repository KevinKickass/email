"""Validate versions and assemble one complete, signed, stable updater release."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
from datetime import datetime, timezone


def validate(tag):
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Release tags must be stable versions, e.g. v0.1.1")
    version = tag[1:]
    for filename in ("package.json", "src-tauri/tauri.conf.json"):
        if json.loads(Path(filename).read_text())["version"] != version:
            raise ValueError(f"{filename} version does not match {tag}")
    cargo = Path("src-tauri/Cargo.toml").read_text()
    if re.search(r'^version = "([^"]+)"', cargo, re.M)[1] != version:
        raise ValueError("Cargo version does not match tag")
    if not Path(f"releases/{tag}.md").is_file():
        raise ValueError(f"Missing releases/{tag}.md")
    return version


def assemble(tag, source, destination):
    version = validate(tag)
    destination.mkdir(parents=True, exist_ok=False)
    platforms = {}
    patterns = {
        "windows-x86_64": f"email_{version}_x64-setup.exe",
        "windows-i686": f"email_{version}_x86-setup.exe",
        "linux-x86_64": f"email_{version}_amd64.AppImage",
    }
    for platform, pattern in patterns.items():
        matches = list(source.rglob(pattern))
        if len(matches) != 1:
            raise ValueError(f"Expected one {pattern}, got {len(matches)}")
        asset = matches[0]
        signature = Path(str(asset) + ".sig")
        sig = signature.read_text().strip()
        if not sig or asset.stat().st_size == 0:
            raise ValueError(f"Empty artifact or signature: {asset}")
        for file in (asset, signature):
            shutil.copy2(file, destination / file.name)
        platforms[platform] = {
            "signature": sig,
            "url": f"https://github.com/KevinKickass/email/releases/download/{tag}/{asset.name}",
        }
    manifest = {
        "version": version,
        "notes": Path(f"releases/{tag}.md").read_text(encoding="utf-8"),
        "pub_date": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "platforms": platforms,
    }
    (destination / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    sums = []
    for file in sorted(destination.iterdir()):
        with file.open("rb") as stream:
            checksum = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                checksum.update(chunk)
            digest = checksum.hexdigest()
        sums.append(f"{digest}  {file.name}")
    (destination / "SHA256SUMS").write_text("\n".join(sums) + "\n")


if __name__ == "__main__":
    if sys.argv[1] == "--validate":
        validate(sys.argv[2])
    else:
        assemble(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]))

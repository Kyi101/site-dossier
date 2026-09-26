#!/usr/bin/env python3
"""Build an allowlisted Chrome Web Store ZIP; --release adds provenance checks."""

import argparse
import io
import json
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "manifest.json",
    "background/background.js",
    "content/content.js",
    "content/banner.css",
    "popup/popup.html",
    "popup/popup.css",
    "popup/popup.js",
    "offscreen/offscreen.html",
    "offscreen/offscreen.js",
    "icons/16.png",
    "icons/48.png",
    "icons/128.png",
    "LICENSE",
)


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True)


def check_release_source():
    if not (ROOT / "LICENSE").is_file():
        raise SystemExit("Choose and add a LICENSE before building a public release.")
    status = git("status", "--porcelain").splitlines()
    dirty = [line for line in status if not line.startswith("??")]
    if dirty:
        raise SystemExit("Release requires a clean tracked tree; commit reviewed changes first.")
    tracked = set(git("ls-files").splitlines())
    missing = sorted((set(FILES) | {"LICENSE"}) - tracked)
    if missing:
        raise SystemExit(f"Release files are untracked: {', '.join(missing)}")
    subprocess.run(["node", "scripts/public-release-check.mjs"], cwd=ROOT, check=True)


def build_archive():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in FILES:
            source = ROOT / name
            if not source.is_file():
                raise FileNotFoundError(source)
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", action="store_true", help="require a clean, privacy-checked Git revision")
    args = parser.parse_args()
    if args.release:
        check_release_source()
    subprocess.run(["node", str(ROOT / "scripts/verify.mjs")], cwd=ROOT, check=True)
    version = json.loads((ROOT / "manifest.json").read_text())["version"]
    output = ROOT / "dist" / f"site-dossier-{version}.zip"
    archive = build_archive()
    if args.release and output.exists() and output.read_bytes() != archive:
        raise SystemExit(f"Refusing to replace a different {output.name}; bump the version or review the old artifact.")
    output.parent.mkdir(exist_ok=True)
    output.write_bytes(archive)
    print(output)
    print(f"Included {len(FILES)} allowlisted files.")
    if args.release:
        print("Manual Chrome smoke of this ZIP is still required before upload.")


if __name__ == "__main__":
    main()

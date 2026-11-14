#!/usr/bin/env python3
"""Builds the extension package WITHOUT Node — Python alone (stdlib only).

    python3 scripts/build.py chrome    # dist/longarm/  (+ dist/longarm.zip)

Same output, same validations as the Node builder (`scripts/pack.mjs`), because the per-browser
deltas come from the ONE data source both read: `scripts/browsers.json`. The zip is written with
Python's own `zipfile`, so the `zip` binary is not needed either.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STAGING = {"chrome": ROOT / "dist" / "longarm"}
ZIPS = {"chrome": ROOT / "dist" / "longarm.zip"}
DIRS = ["background", "content_scripts", "popup", "shared", "welcome", "instructions"]


def manifest_for(browser: str, canonical: dict, data: dict) -> dict:
    """The canonical manifest + the browser's delta from browsers.json, Chrome-only keys dropped."""
    delta = data["browsers"].get(browser)
    if delta is None:
        raise SystemExit(f"unknown browser: {browser} (known: {', '.join(data['browsers'])})")
    manifest = json.loads(json.dumps(canonical))  # a deep copy: the canonical manifest is never mutated
    if browser != "chrome":
        for key in data["chrome_only_keys"]:
            manifest.pop(key, None)
    manifest.update(delta)
    return manifest


def validate(browser: str, manifest: dict, out: Path) -> list[str]:
    """The checks the build must pass before anything is zipped (same rules as the Node builder)."""
    problems: list[str] = []
    background = manifest.get("background", {})
    if browser == "chrome":
        if not background.get("service_worker"):
            problems.append("background: Chrome needs a service worker")
    for cs in manifest.get("content_scripts", []):
        for js in cs.get("js", []):
            if not (out / js).exists():
                problems.append(f"missing content script: {js}")
    for js in background.get("scripts", []):
        if not (out / js).exists():
            problems.append(f"missing background script: {js}")
    for icon in (manifest.get("icons") or {}).values():
        if not (out / icon).exists():
            problems.append(f"missing icon: {icon}")
    if not manifest.get("version"):
        problems.append("no version")
    return problems


def build(browser: str) -> None:
    canonical = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    data = json.loads((ROOT / "scripts" / "browsers.json").read_text(encoding="utf-8-sig"))
    out = STAGING[browser]

    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    for directory in DIRS:
        shutil.copytree(ROOT / directory, out / directory)
    if (ROOT / "icons").exists():
        shutil.copytree(ROOT / "icons", out / "icons")

    manifest = manifest_for(browser, canonical, data)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    problems = validate(browser, manifest, out)
    if problems:
        for problem in problems:
            print(f"✘ {problem}", file=sys.stderr)
        sys.exit(1)

    zip_path = ZIPS[browser]
    zip_path.unlink(missing_ok=True)  # a stale zip would keep dead entries: rebuild it from scratch
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(out.rglob("*")):
            if path.is_file() and path.name != ".DS_Store":
                zf.write(path, path.relative_to(out).as_posix())

    print(f"  {zip_path.relative_to(ROOT)}")
    print(f"✔ {out.relative_to(ROOT)} — Chrome/Edge/Brave package (load unpacked from chrome://extensions)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the extension package without Node.")
    parser.add_argument("browser", choices=sorted(STAGING), help="which package to build")
    args = parser.parse_args()
    build(args.browser)
    return 0


if __name__ == "__main__":
    sys.exit(main())

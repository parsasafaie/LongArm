#!/usr/bin/env python3
"""Writes the extension icons into icons/ (16, 32, 48, 128) from the source mark.

    python3 scripts/make_icons.py

The source is `assets/logo.png` — the LongArm mark (a black rounded square with a white L whose
stem ends in a wrench). It needs Pillow, a dev-only dependency (nothing that runs in the
extension or the bridge uses it):

    pip install pillow

The manifest only loads these four files, and `pack.mjs` copies `icons/` alone, so `assets/`
stays out of the shipped packages.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "logo.png"
SIZES = (16, 32, 48, 128)


def main() -> int:
    if not SOURCE.is_file():
        raise SystemExit(f"the source mark is missing: {SOURCE}")
    mark = Image.open(SOURCE).convert("RGBA")
    for size in SIZES:
        icon = mark.resize((size, size), Image.LANCZOS)
        out = ROOT / "icons" / f"icon{size}.png"
        icon.save(out)
        print(f"  icons/icon{size}.png")
    print(f"✔ {len(SIZES)} icons written from {SOURCE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

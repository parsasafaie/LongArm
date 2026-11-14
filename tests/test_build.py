"""Pins the manifest layer of scripts/build.py (the no-Node builder) against browsers.json.

    python3 tests/test_build.py        (part of npm test, via scripts/run_python.mjs)

The JS side has the same rules pinned in tests/test_manifest.mjs; both read the ONE delta source
(scripts/browsers.json), so the two builders can never quietly disagree.
"""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("wmb_build", str(ROOT / "scripts/build.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)  # main() is guarded: importing only loads the helpers

canonical = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
data = json.loads((ROOT / "scripts/browsers.json").read_text(encoding="utf-8-sig"))

# Chrome IS the canonical manifest, untouched — including the Chrome-only key.
chrome = mod.manifest_for("chrome", canonical, data)
assert chrome == canonical, "the Chrome build must be the canonical manifest as it is"
assert chrome["minimum_chrome_version"] == canonical["minimum_chrome_version"], "the Chrome-only key stays in the Chrome build"

# The canonical manifest is never mutated by a build.
assert canonical["minimum_chrome_version"] == mod.manifest_for("chrome", canonical, data)["minimum_chrome_version"]
assert canonical["background"]["service_worker"] == "background/background.js"

# An unknown browser fails instead of silently building Chrome.
try:
    mod.manifest_for("safari", canonical, data)
except SystemExit:
    pass
else:  # pragma: no cover
    raise AssertionError("an unknown browser must fail")

print("ok test_build: all checks passed")

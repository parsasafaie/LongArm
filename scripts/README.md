# scripts/

Development-only tooling: the checks, the generators and the packagers. **Nothing here ships inside
the extension or runs on a user's machine** — the browser loads `manifest.json` and the folders next
to it, and the bridge runs `server/mcp_ws_bridge.py`. Delete this folder and the product still works;
what breaks is the repo's ability to be verified, regenerated and packaged.

The commands are also listed in the [README's Development section](../README.md#development); the
reasons behind the design are in [ARCHITECTURE.md](../ARCHITECTURE.md) (sections 5 and 6).

| File | Command | What it does |
|---|---|---|
| `check.mjs` | `npm run check` (also the first step of `npm test`) | The gate every change runs through: every JS file must parse; the Chrome build must match the canonical manifest; the version must agree across `manifest.json`, `package.json` and `WMB.VERSION`; every icon the manifest declares must exist; every relative link in the docs resolves (a file or a `#heading`). |
| `manifest.mjs` | (imported, not run) | The JS reader of the browser deltas. `manifest.json` at the root is canonical; the deltas live as pure data in `browsers.json` — ONE source shared with `build.py` — and this module applies them (`manifestFor(browser)`). Consumers: `check.mjs`, `pack.mjs`, `tests/test_manifest.mjs`. |
| `browsers.json` | (data, not run) | The per-browser manifest deltas as pure data, plus the Chrome-only keys to drop. Read by BOTH builders — `manifest.mjs` and `build.py` — so they can never drift. A new browser later is a new entry here. |
| `pack.mjs` | `npm run pack` | Builds the Chrome/Edge/Brave package: stages `background/`, `content_scripts/`, `popup/`, `shared/`, `welcome/`, `instructions/` and `icons/` into `dist/longarm/` with a freshly written manifest, then zips it as `dist/longarm.zip`. The staging dir is rebuilt from scratch every run (a plain copy would nest directories). |
| `build.py` | `python3 scripts/build.py chrome` | The same package without Node: pure stdlib, zip via Python's own `zipfile` (no `zip` binary needed). Same output and same validations as `pack.mjs`. This is the build path for someone who never installs Node.js. |
| `build_constants.mjs` | `npm run constants` | Regenerates `content_scripts/constants.js` from `shared/constants.js`. Content scripts are classic scripts and cannot import ES modules, so the shared values (settings defaults, permission labels, result statuses, timeouts) are written out as `WMB.defaults`. `tests/test_constants.mjs` runs this file and fails if the output differs. |
| `build_instructions.mjs` | `npm run instructions` | Regenerates `instructions/instructions.txt` by executing `WMB.instructionsText()` from `content_scripts/prompt_builder.js` in a sandbox — the installable rules and the parser can therefore never drift apart. `tests/test_prompt.mjs` fails if it is stale. |
| `run_python.mjs` | (part of `npm test`) | Runs the five Python test files with whatever interpreter this machine has (`python3` → `python` → `py -3`), so `npm test` works on every OS without an alias. |
| `release.mjs` | `npm run release` (or `node scripts/release.mjs 0.0.2`) | The one release command: bumps the version in its three homes (`manifest.json`, `package.json`, `WMB.VERSION`), regenerates the two generated files and runs `npm run check`. Accepts an explicit version or `major` / `minor` / `patch`. |
| `make_icons.py` | `python3 scripts/make_icons.py` | Writes `icons/icon16/32/48/128.png` from the source mark `assets/logo.png`. Needs Pillow (a dev-only dependency). |

## Conventions

- **Generated files are never edited by hand** — `instructions/instructions.txt` and
  `content_scripts/constants.js` are build outputs; edit their source and run the corresponding
  `npm run` command. The tests fail on stale copies.
- **One manifest**: never create a second manifest file for another browser — add an entry to
  `browsers.json`.
- **`assets/` never ships**: only the directories in the builders' `DIRS` (`pack.mjs` / `build.py`)
  plus `icons/` are packaged, so keep source art and demos out of those.

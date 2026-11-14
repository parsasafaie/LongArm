#!/usr/bin/env bash
# ============================================================================
#  LongArm - installs the launcher (Linux and macOS counterpart of install.cmd)
#
#  Run it once from a terminal:  bash server/install.sh
#
#  It calls install_service.py, which installs what is missing (websockets)
#  and registers the automatic start: a launchd agent on macOS, a user
#  systemd unit on Linux.
# ============================================================================
set -eu
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1 && python -c 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)' >/dev/null 2>&1; then
  PY=python
else
  echo
  echo " [X] Python 3 was not found on this computer."
  echo "     Install it with your package manager (or from https://www.python.org/downloads/)"
  echo "     and open this file again."
  echo
  exit 1
fi

"$PY" install_service.py

#!/usr/bin/env bash
# ============================================================================
#  LongArm - bridge control (start / restart / status / stop / reload)
#
#  From the terminal  -> ./bridge.sh start | restart | status | stop | reload
#  Without arguments  -> menu.
#
#  Linux and macOS counterpart of bridge.cmd: it finds Python, installs the
#  requirements (websockets) if they are missing, creates an empty
#  servers.json the first time and then drives mcp_ws_bridge.py.
# ============================================================================
set -u
cd "$(dirname "$0")"
BRIDGE="$(pwd)/mcp_ws_bridge.py"
CONFIG="$(pwd)/servers.json"
LOGF="$(pwd)/bridge.log"

# ---------- 1. Python ----------
PY=""
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1 && python -c 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)' >/dev/null 2>&1; then
  PY=python
fi
if [ -z "$PY" ]; then
  echo
  echo " [X] Python 3 was not found on this computer."
  echo "     Install it with your package manager (or from https://www.python.org/downloads/)"
  echo "     and open this file again."
  echo
  exit 1
fi
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 9) else 1)' >/dev/null 2>&1; then
  echo
  echo " [X] Python 3.9 or newer is required. Update it and try again."
  echo
  exit 1
fi

# ---------- 2. Requirements (installed automatically if missing) ----------
if ! "$PY" -c "from websockets.asyncio.server import serve" >/dev/null 2>&1; then
  echo " The bridge requirements are missing. Installing them (only once)..."
  "$PY" -m pip --version >/dev/null 2>&1 || "$PY" -m ensurepip --upgrade >/dev/null 2>&1
  # Plain install first; --user for restricted accounts; --break-system-packages for the
  # distributions (Debian 12+, recent Fedora) that block a system-wide pip (PEP 668).
  "$PY" -m pip install --disable-pip-version-check -r requirements.txt \
    || "$PY" -m pip install --user --disable-pip-version-check -r requirements.txt \
    || "$PY" -m pip install --break-system-packages --disable-pip-version-check -r requirements.txt
  if ! "$PY" -c "from websockets.asyncio.server import serve" >/dev/null 2>&1; then
    echo
    echo " [X] The requirements could not be installed. Try manually:"
    echo "     $PY -m pip install -r requirements.txt"
    echo
    exit 1
  fi
  echo " Requirements installed successfully."
  echo
fi

# ---------- 3. servers.json (created empty if it does not exist) ----------
# The servers kept in the mcp/ folder need no entry here: the bridge finds them by itself.
# This file is only for servers that live somewhere else (an npx package, a program of your own).
if [ ! -f "$CONFIG" ]; then
  printf '{\n  "servers": []\n}\n' > "$CONFIG"
  echo " servers.json was created empty — register your MCP servers in it."
fi

# ---------- 4. Action ----------
do_start() {
  echo
  echo " Starting the bridge (if it is already running, it only reloads servers.json)..."
  "$PY" "$BRIDGE" --config "$CONFIG" --log-file "$LOGF" --detach
}
do_restart() {
  echo
  "$PY" "$BRIDGE" --config "$CONFIG" --log-file "$LOGF" --restart
}
do_status() {
  echo
  "$PY" "$BRIDGE" --config "$CONFIG" --status
}
do_stop() {
  echo
  "$PY" "$BRIDGE" --config "$CONFIG" --stop
  echo " (If you installed automatic startup, the supervisor will bring it back up in a few seconds.)"
}
do_reload() {
  echo
  "$PY" "$BRIDGE" --config "$CONFIG" --reload
}

menu() {
  while true; do
    echo
    echo "  =============================="
    echo "    LongArm - Bridge"
    echo "  =============================="
    echo
    echo "    1. Start"
    echo "    2. Restart"
    echo "    3. Status"
    echo "    4. Stop"
    echo "    5. Reload servers.json"
    echo "    0. Exit"
    echo
    printf "  Pick an option: "
    read -r choice
    case "$choice" in
      1) do_start ;;
      2) do_restart ;;
      3) do_status ;;
      4) do_stop ;;
      5) do_reload ;;
      0) exit 0 ;;
    esac
  done
}

case "${1:-}" in
  start)   do_start ;;
  restart) do_restart ;;
  status)  do_status ;;
  stop)    do_stop ;;
  reload)  do_reload ;;
  "")      menu ;;
  *)       echo "Usage: bridge.sh [start | restart | status | stop | reload]"; exit 2 ;;
esac

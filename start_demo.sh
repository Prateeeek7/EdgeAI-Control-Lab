#!/usr/bin/env bash
# EdgeAI ControlLab — start everything for a demo in one go.
#
#   ./start_demo.sh            backend (ESP32 hardware mode) + dashboard, opens the browser
#   ./start_demo.sh --flash    flash the firmware first, then start everything
#   ./start_demo.sh --sim      no hardware: backend runs the built-in motor simulator
#
# Plugging the ESP32 in before or after starting is fine: the backend finds the board and
# reconnects on its own. Press Ctrl+C in this window to stop both servers.

set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
FIRMWARE="$ROOT/firmware"
LOGS="$ROOT/logs"
BACKEND_PORT=8088
FRONTEND_PORT=5180
URL="http://localhost:$FRONTEND_PORT"

FLASH=0
SIM=0
for arg in "$@"; do
  case "$arg" in
    --flash) FLASH=1 ;;
    --sim) SIM=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (use --flash, --sim or --help)"; exit 1 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
fail() { printf '\033[1;31mxx\033[0m  %s\n' "$*"; exit 1; }

mkdir -p "$LOGS"

# ---------------------------------------------------------------- checks
[ -x "$BACKEND/venv/bin/uvicorn" ] || fail "Backend virtualenv missing. Run: cd backend && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt"
command -v npm >/dev/null || fail "npm not found. Install Node.js first."
if [ ! -d "$FRONTEND/node_modules" ]; then
  say "Installing dashboard dependencies (first run only)..."
  (cd "$FRONTEND" && npm install) || fail "npm install failed"
fi
for port in $BACKEND_PORT $FRONTEND_PORT; do
  if lsof -iTCP:$port -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    fail "Port $port is already in use (an old backend/dashboard may still be running). Close it, or run: lsof -iTCP:$port -sTCP:LISTEN"
  fi
done

# ---------------------------------------------------------------- find the ESP32
ESP_PORT="$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)"
if [ "$SIM" -eq 0 ]; then
  if [ -n "$ESP_PORT" ]; then
    say "ESP32 found on $ESP_PORT"
  else
    warn "ESP32 not plugged in yet. Starting anyway: plug the USB cable in and the backend will connect."
    ESP_PORT="/dev/cu.usbmodem1101"
  fi
fi

# ---------------------------------------------------------------- optional flash
if [ "$FLASH" -eq 1 ]; then
  [ "$SIM" -eq 1 ] && fail "--flash needs the hardware; drop --sim"
  [ -e "$ESP_PORT" ] || fail "Plug the ESP32 in before flashing."
  PIO="$(command -v pio || echo "$HOME/.platformio/penv/bin/pio")"
  [ -x "$PIO" ] || fail "PlatformIO (pio) not found."
  say "Flashing firmware to $ESP_PORT ..."
  (cd "$FIRMWARE" && "$PIO" run -e esp32s3_usb -t upload --upload-port "$ESP_PORT") >"$LOGS/flash.log" 2>&1 \
    || fail "Flashing failed. See $LOGS/flash.log"
  say "Flash OK (the backend resets the board into the firmware if it stays in the bootloader)."
  sleep 2
  ESP_PORT="$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)"; ESP_PORT="${ESP_PORT:-/dev/cu.usbmodem1101}"
fi

# ---------------------------------------------------------------- start servers
PIDS=()
cleanup() {
  echo
  say "Stopping backend and dashboard..."
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  sleep 0.5
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null; done
  # npm starts vite as a child process: make sure nothing we started is left listening
  for port in $BACKEND_PORT $FRONTEND_PORT; do
    lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null
  done
  pkill -f "tail -n 0 -F $LOGS/backend.log" 2>/dev/null
  say "Stopped. (The ESP32 stops the motor by itself within 1.5 s once the backend is gone.)"
  exit 0
}
trap cleanup INT TERM

if [ "$SIM" -eq 1 ]; then
  say "Starting backend in SIMULATOR mode on port $BACKEND_PORT ..."
  (cd "$BACKEND" && PYTHONUNBUFFERED=1 exec ./venv/bin/uvicorn main:app --port $BACKEND_PORT) >"$LOGS/backend.log" 2>&1 &
else
  say "Starting backend in HARDWARE mode on port $BACKEND_PORT ..."
  (cd "$BACKEND" && CONTROLLAB_SERIAL="$ESP_PORT" PYTHONUNBUFFERED=1 exec ./venv/bin/uvicorn main:app --port $BACKEND_PORT) >"$LOGS/backend.log" 2>&1 &
fi
PIDS+=($!)

say "Starting dashboard on port $FRONTEND_PORT ..."
(cd "$FRONTEND" && exec npm run dev -- --port $FRONTEND_PORT --strictPort) >"$LOGS/frontend.log" 2>&1 &
PIDS+=($!)

# wait for both to answer
for i in $(seq 1 40); do
  curl -s "http://localhost:$BACKEND_PORT/api/status" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -s "http://localhost:$BACKEND_PORT/api/status" >/dev/null 2>&1 || { warn "Backend did not start. Last lines of $LOGS/backend.log:"; tail -20 "$LOGS/backend.log"; cleanup; }
for i in $(seq 1 40); do
  curl -s "$URL" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -s "$URL" >/dev/null 2>&1 || { warn "Dashboard did not start. Last lines of $LOGS/frontend.log:"; tail -20 "$LOGS/frontend.log"; cleanup; }

say "Backend:   http://localhost:$BACKEND_PORT  ($( [ "$SIM" -eq 1 ] && echo simulator || echo "ESP32 on $ESP_PORT" ))"
say "Dashboard: $URL"
[ -z "${NO_OPEN:-}" ] && open "$URL" 2>/dev/null

cat <<EOF

  Ready. Checklist:
    1. USB plugged in -> OLED on, dashboard header shows LIVE, inspector shows "ESP32 LINK: USB ...".
    2. Connect the 12 V supply -> supply voltage in the inspector rises to ~12 V.
    3. Dashboard tab: Run Excitation Step in PID mode, then switch to Adaptive AI.

  Logs: $LOGS   (backend.log, frontend.log)
  Press Ctrl+C here to stop everything.

EOF

# show hardware/link events from the backend while running
tail -n 0 -F "$LOGS/backend.log" 2>/dev/null | grep --line-buffered -E "Hardware bridge|ESP32 #|Error|Traceback" &
PIDS+=($!)
wait

#!/usr/bin/env bash
# stop-test-instance.sh — stop ONLY the throwaway DSH web instance on 127.0.0.1:3099.
#
# Never runs `pkill dsh` and never touches the machine's main DSH web service/unit:
#   1. resolve the listener PID from the test port (ss)
#   2. prove the process is the test instance three ways before signalling it:
#        - /proc/<pid>/cmdline contains "--port <TEST_PORT>"
#        - /proc/<pid>/environ carries DSH_HOME=$TEST_BASE/home
#        - its cwd is under $TEST_BASE
#   3. SIGTERM and wait for the listener to disappear (--force => SIGKILL after timeout)
#
# Usage: ./stop-test-instance.sh [--force]
set -euo pipefail

BASE="${TEST_BASE:-$HOME/session-bridge-test}"
PORT="${TEST_PORT:-3099}"
HOST="${TEST_HOST:-127.0.0.1}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

die() { echo "stop-test-instance: ERROR: $*" >&2; exit 1; }
info() { echo "stop-test-instance: $*"; }

[ "$PORT" = "3080" ] && die "TEST_PORT=3080 is the main DSH web service; refusing to stop it"

listener_line() { ss -tlnp 2>/dev/null | grep "${HOST}:${PORT} " || true; }
listener_pid() { listener_line | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1; }

PID="$(listener_pid)"
if [ -z "${PID:-}" ]; then
  info "nothing listening on ${HOST}:${PORT}; already stopped"
  rm -f "$BASE/test-instance.pid"
  exit 0
fi

# --- prove this PID is the isolated test instance before killing anything ----
[ -r "/proc/$PID/cmdline" ] || die "cannot read /proc/$PID/cmdline; refusing to signal pid $PID"
CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline")"
case "$CMDLINE" in
  *"dsh"*"--port $PORT"*) : ;;
  *) die "pid $PID on port $PORT does not look like the dsh test instance (cmdline: $CMDLINE); refusing" ;;
esac
ENVIRON="$(tr '\0' '\n' < "/proc/$PID/environ" 2>/dev/null || true)"
echo "$ENVIRON" | grep -qx "DSH_HOME=$BASE/home" \
  || die "pid $PID does not carry DSH_HOME=$BASE/home; refusing (main instance protection)"
CWD="$(readlink -f "/proc/$PID/cwd" 2>/dev/null || true)"
case "$CWD" in
  "$BASE"/*) : ;;
  *) die "pid $PID cwd ($CWD) is outside $BASE; refusing" ;;
esac

info "stopping test instance pid=$PID (home=$BASE/home, port=$PORT)"
kill -TERM "$PID" 2>/dev/null || die "SIGTERM failed for pid $PID"

for _ in $(seq 1 30); do
  [ -z "$(listener_pid)" ] && break
  sleep 0.5
done

if [ -n "$(listener_pid)" ]; then
  if [ "$FORCE" = "1" ]; then
    info "still listening after 15s; --force given, sending SIGKILL"
    kill -KILL "$PID" 2>/dev/null || true
    sleep 1
  else
    die "pid $PID still listening on $PORT after 15s; re-run with --force to SIGKILL"
  fi
fi

[ -z "$(listener_pid)" ] || die "port $PORT is still in use after stop"
rm -f "$BASE/test-instance.pid"
info "stopped; port $PORT is free. The machine's main DSH web service on 3080 was never addressed."

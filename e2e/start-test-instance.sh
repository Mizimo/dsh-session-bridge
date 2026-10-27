#!/usr/bin/env bash
# start-test-instance.sh — boot an ISOLATED, throwaway DSH web instance on the test machine.
#
#   host: 127.0.0.1:3099 (loopback only, never a firewall/tailnet port)
#   home: ~/session-bridge-test/home   (separate DSH_HOME; only copies provider credentials from ~/.dsh)
#   log:  ~/session-bridge-test/logs/test-instance.log
#
# Safe by construction:
#   - refuses to run at all if TEST_PORT is 3080 (the machine's main DSH web service)
#   - refuses if anything already listens on the test port
#   - uses DSH_BIN when set, otherwise the dsh executable on PATH
#
# Usage: ./start-test-instance.sh
set -euo pipefail

BASE="${TEST_BASE:-$HOME/session-bridge-test}"
PORT="${TEST_PORT:-3099}"
HOST="${TEST_HOST:-127.0.0.1}"
if [ "${DSH_BIN+x}" != x ]; then
  DSH_BIN="$(command -v dsh || true)"
fi
LOG="$BASE/logs/test-instance.log"

die() { echo "start-test-instance: ERROR: $*" >&2; exit 1; }
info() { echo "start-test-instance: $*"; }

[ "$PORT" = "3080" ] && die "TEST_PORT=3080 is the machine's main DSH web service port; refusing"
[ -n "$DSH_BIN" ] || die "dsh not found on PATH; set DSH_BIN=/absolute/path/to/dsh"
[ -x "$DSH_BIN" ] || die "dsh is not executable: $DSH_BIN; set DSH_BIN=/absolute/path/to/dsh"
command -v setsid >/dev/null || die "setsid not found"

# 0. Never start a second copy if the test port is already taken.
if ss -tln 2>/dev/null | grep -q "${HOST}:${PORT} "; then
  die "something already listens on ${HOST}:${PORT}; run stop-test-instance.sh or change TEST_PORT"
fi

# 1. Isolated layout.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$BASE/home" "$BASE/workspace" "$BASE/logs" "$BASE/bin"
chmod 700 "$BASE" "$BASE/home"
install -m 755 "$SCRIPT_DIR/stop-test-instance.sh" "$BASE/bin/stop-test-instance.sh"

# 2. Credentials for the isolated home: an owner-only COPY of the real provider
#    credentials, so the test instance never writes into ~/.dsh and the real
#    instance never reads anything from here. (The file contents are never printed.)
if [ ! -f "$BASE/home/.credentials.yaml" ]; then
  [ -f "$HOME/.dsh/.credentials.yaml" ] || die "no source credentials at ~/.dsh/.credentials.yaml"
  install -m 600 "$HOME/.dsh/.credentials.yaml" "$BASE/home/.credentials.yaml"
  info "copied provider credentials into isolated home (mode 600)"
fi

# 3. Auto-initialize the isolated 'web' profile from the shipped template
#    (~/session-bridge-test/home/profiles/web; needs no pnpm, no network).
if [ ! -f "$BASE/home/profiles/web/package.json" ]; then
  info "initializing isolated web profile from shipped template"
  ( cd "$BASE/workspace" \
    && DSH_HOME="$BASE/home" DSH_AGENTS_HOME="$BASE/home/agents" DSH_TELEMETRY_MODE=DISABLED \
       "$DSH_BIN" web --dump-default-config >"$BASE/logs/dump-default-config.yml" 2>"$BASE/logs/dump-default-config.err" ) \
    || die "profile initialization failed; see $BASE/logs/dump-default-config.err"
fi

# 3.5 HAPI hub client credentials for the host environment (optional, opt-in by
#     the presence of $BASE/hapi-token.env). The file is created OUTSIDE this
#     script with mode 600 and contains only `export` lines for CLI_API_TOKEN
#     and HAPI_API_URL; sourcing it lets the plugin's `hapiCompat: hub` row
#     authenticate against the loopback hub. Its contents are never printed,
#     copied or committed.
if [ -f "$BASE/hapi-token.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$BASE/hapi-token.env"
  set +a
  info "sourced HAPI hub env from $BASE/hapi-token.env (token not printed)"
fi

# 4. Launch detached: `setsid --fork` forks a new session and returns at once,
#    so this script never waits for (nor becomes the parent of) the server
#    process. Telemetry is off for the throwaway instance.
: > "$LOG"
( cd "$BASE/workspace" \
  && DSH_HOME="$BASE/home" DSH_AGENTS_HOME="$BASE/home/agents" DSH_TELEMETRY_MODE=DISABLED \
     setsid --fork "$DSH_BIN" web --no-open --host "$HOST" --port "$PORT" \
     >>"$LOG" 2>&1 < /dev/null )

# 5. Wait for readiness (GET / -> 200). Stock installs may still require a
#    browser-token exchange before the harness can call /api (see README.md).
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://${HOST}:${PORT}/" 2>/dev/null || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || { echo "--- $LOG ---"; tail -20 "$LOG"; die "test instance did not become ready"; }

# 6. Record the real listener PID (owned by this user; verified before stop).
PID="$(ss -tlnp 2>/dev/null | grep "${HOST}:${PORT} " | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)"
[ -n "${PID:-}" ] || die "listener pid not found (ss output unreadable?)"
echo "$PID" > "$BASE/test-instance.pid"
echo "$PORT" > "$BASE/test-instance.port"

info "running: http://${HOST}:${PORT}/  pid=$PID  home=$BASE/home  profile=$BASE/home/profiles/web"
info "log: $LOG"
info "stop with: $BASE/bin/stop-test-instance.sh"

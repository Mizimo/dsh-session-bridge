#!/usr/bin/env bash
# install-plugin-bundle.sh — install a LOCAL plugin bundle into the isolated test
# profile (~/session-bridge-test/home/profiles/web), for the later 2-session test.
#
# Usage:
#   ./install-plugin-bundle.sh /absolute/path/to/bundle-dir
#   ./install-plugin-bundle.sh file:/absolute/path/to/bundle-dir   # same thing
#   ./install-plugin-bundle.sh some-npm-package@1.2.3
#
# What it does:
#   DSH_HOME=~/session-bridge-test/home dsh plugin --profile web add <spec>
#   -> pnpm adds the package to the isolated profile, then dsh reconciles
#      dsh.profile.bundles from the installed state.
#
# IMPORTANT: bundle membership is read at startup, so restart the test instance
# afterwards (the plugin's cordis rows can hot-reload, but the bundle layer list
# cannot):
#   ./stop-test-instance.sh && ./start-test-instance.sh
#
# The bundle directory must be a pnpm package whose package.json declares:
#   "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
# A TypeScript-source bundle is installed without a build step for a link:/file:
# checkout (pnpm runs `prepare` only for git sources); build it before installing
# if the entry points are compiled artifacts.
set -euo pipefail

BASE="${TEST_BASE:-$HOME/session-bridge-test}"
DSH_BIN="${DSH_BIN:-$HOME/.npm/_npx/7eff65a5cfe9d1d1/node_modules/.bin/dsh}"
SPEC="${1:-}"

die() { echo "install-plugin-bundle: ERROR: $*" >&2; exit 1; }
info() { echo "install-plugin-bundle: $*"; }

[ -n "$SPEC" ] || die "usage: install-plugin-bundle.sh <abs-bundle-dir | file:<dir> | npm-spec>"
[ -d "$BASE/home/profiles/web" ] || die "isolated profile missing; run start-test-instance.sh first"
command -v pnpm >/dev/null 2>&1 || [ -x "$HOME/.local/bin/pnpm" ] || die "pnpm not found (needed by 'dsh plugin')"

# Anchor a relative local path to an absolute one, and use the file: protocol so
# pnpm links/copies the checkout instead of trying the npm registry.
case "$SPEC" in
  file:*|link:*|github:*|git+*|http*|@*/*|*@[0-9]*|dsh-*|[a-z0-9][a-z0-9-]*)
    : ;;
  *)
    ABS="$(cd "$(dirname "$SPEC")" && pwd)/$(basename "$SPEC")"
    [ -e "$ABS" ] || die "no such path: $ABS"
    SPEC="file:$ABS"
    ;;
esac

info "DSH_HOME=$BASE/home  profile=web  spec=$SPEC"
info "forwarding to: dsh plugin --profile web add $SPEC"
PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH" \
DSH_HOME="$BASE/home" DSH_AGENTS_HOME="$BASE/home/agents" DSH_TELEMETRY_MODE=DISABLED \
  "$DSH_BIN" plugin --profile web add "$SPEC"

info "installed. Current bundle list in $BASE/home/profiles/web/package.json:"
python3 - "$BASE/home/profiles/web/package.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
print(json.dumps(doc.get('dsh', {}).get('profile', {}).get('bundles', []), indent=2))
print('dependencies:', json.dumps(doc.get('dependencies', {}), indent=2))
PY
info "restart to load the new bundle: ./stop-test-instance.sh && ./start-test-instance.sh"

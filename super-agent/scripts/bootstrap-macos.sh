#!/usr/bin/env bash
# macOS handoff bootstrap for super-agent-auto-loop-runtime.
# Run from anywhere; the fork root is ../../ relative to this script.
#
#   bootstrap-macos.sh              preflight + config + green baseline, prints next steps
#   bootstrap-macos.sh render-plist [out.plist]   render the OPTIONAL LaunchAgent template
#
# IMPORTANT: Do NOT install a second LaunchAgent. The upstream hub installs its own
# ~/Library/LaunchAgents/agent-autoloop.plist when `agent-autoloop init` runs. Two agents
# running `up` fight over home/up.pid. Use the upstream service; render-plist is only for
# the deliberate `init --no-service` path (see docs/HANDOFF_MACOS.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGING="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$STAGING/.." && pwd)"
CONFIG="$STAGING/config/rules.example.json"
SUPER_CONFIG="$STAGING/config/super.example.json"
TEMPLATE="$STAGING/deploy/com.superagent.runtime.plist"
STATE_DIR="${AGENT_AUTOLOOP_HOME:-$HOME/.agent-autoloop}"
PORT="${AGENT_AUTOLOOP_PORT:-3350}"
MODE="${1:-bootstrap}"

# Homebrew's node@24 is deliberately not linked into the default PATH.
resolve_node() {
  if command -v brew >/dev/null 2>&1; then
    local prefix
    prefix="$(brew --prefix node@24 2>/dev/null || true)"
    if [[ -n "$prefix" && -x "$prefix/bin/node" ]]; then
      echo "$prefix/bin/node"
      return 0
    fi
  fi
  command -v node 2>/dev/null || true
}

NODE_BIN="$(resolve_node)"
[[ -n "$NODE_BIN" ]] || { echo "Node 24 not found. Install: brew install node@24"; exit 1; }

if [[ "$MODE" == "render-plist" ]]; then
  OUT="${2:-$STATE_DIR/com.superagent.runtime.plist}"
  mkdir -p "$(dirname "$OUT")"
  sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
      -e "s|__REPO_ROOT__|$ROOT|g" \
      -e "s|__HOME_DIR__|$HOME|g" \
      "$TEMPLATE" > "$OUT"
  echo "==> rendered $OUT"
  echo "    node: $NODE_BIN   repo: $ROOT"
  echo "    ONLY load this if the upstream agent-autoloop LaunchAgent is disabled."
  exit 0
fi

[[ "$MODE" == "bootstrap" ]] || { echo "unknown mode: $MODE (use bootstrap or render-plist)"; exit 2; }
[[ "$(uname -s)" == "Darwin" ]] || { echo "This bootstrap is for macOS; use dev-wsl.sh on Linux."; exit 1; }
[[ -f "$ROOT/package.json" ]] || { echo "no package.json at $ROOT; check the checkout layout"; exit 1; }

echo "==> runtime (fork root: $ROOT)"
NODE_VERSION="$("$NODE_BIN" --version)"
echo "    $NODE_BIN ($NODE_VERSION)"
echo "$NODE_VERSION" | grep -qE '^v(2[4-9]|[3-9][0-9])\.' || {
  echo "Node >=24 required. The repo has .nvmrc: 24."
  exit 1
}
# The upstream init/up must see the SAME Node 24, or the LaunchAgent will pin the wrong binary.
export PATH="$(dirname "$NODE_BIN"):$PATH"
command -v git >/dev/null || { echo "git required"; exit 1; }
command -v curl >/dev/null || { echo "curl required"; exit 1; }

echo "==> state dir + permissions"
mkdir -p "$STATE_DIR/logs" "$STATE_DIR/work" "$STATE_DIR/branches" "$STATE_DIR/audit"
chmod 0700 "$STATE_DIR"
find "$STATE_DIR" -maxdepth 1 -type f -exec chmod 0600 {} +

echo "==> install config (never overwrite an existing file)"
if [[ ! -f "$STATE_DIR/rules.json" ]]; then
  cp "$CONFIG" "$STATE_DIR/rules.json"
  echo "    wrote $STATE_DIR/rules.json (REVIEW IT: example ids and answerers)"
fi
# The super plane has its own file: protocol/rules.ts rejects unknown fields.
if [[ ! -f "$STATE_DIR/super.json" ]]; then
  cp "$SUPER_CONFIG" "$STATE_DIR/super.json"
  echo "    wrote $STATE_DIR/super.json (REVIEW IT: accept_mode, projects, schedule)"
fi

echo "==> baseline (authoritative full run is CI: ubuntu-latest + macos-latest)"
cd "$ROOT"
npm ci
npm run format:check
npm run typecheck
node --disable-warning=ExperimentalWarning --test \
  tests/purity.test.ts tests/ci-scope.test.ts tests/cron.test.ts tests/super-agent-kernel.test.ts \
  tests/super-agent-host.test.ts tests/super-agent-m3.test.ts tests/super-agent-m4.test.ts \
  tests/super-agent-m4-health.test.ts tests/super-agent-m4-projection.test.ts \
  tests/super-agent-m4-bridge.test.ts tests/super-agent-handoff.test.ts \
  tests/kernel.test.ts tests/hops.test.ts tests/projection.test.ts tests/schema.test.ts
npm run test:sim
# Full npm test needs a logged-in Agent CLI; CI provisions it via install-smoke.sh.
if [[ "${SUPER_FULL_TEST:-0}" == "1" ]]; then
  npm test
else
  echo "    skipped full npm test (set SUPER_FULL_TEST=1 after an Agent CLI is logged in)"
fi

echo ""
echo "==> bootstrap OK. Next steps on this Mac:"
echo "  1) Keep Node 24 in PATH for the service:"
echo "       export PATH=\"\$(dirname '$NODE_BIN'):\$PATH\""
echo "  2) Let the UPSTREAM hub install its own LaunchAgent (port $PORT):"
echo "       node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts init --port $PORT"
echo "     It writes ~/Library/LaunchAgents/agent-autoloop.plist and starts 'up'."
echo "  3) Verify the super plane:"
echo "       curl -s http://127.0.0.1:$PORT/v1/super/overview"
echo "       curl -s http://127.0.0.1:$PORT/v1/super/health"
echo "       curl -s http://127.0.0.1:$PORT/v1/super/schedule"
echo "       curl -s http://127.0.0.1:$PORT/v1/super/projects/routes"
echo "  4) Open super-agent/web/index.html and set API 地址 to http://127.0.0.1:$PORT"
echo "     Write commands need an owner key in the banner (agent-autoloop key new owner ...)."
echo "  5) Do NOT load deploy/com.superagent.runtime.plist alongside the upstream service."
echo "     Only for 'init --no-service': $SCRIPT_DIR/bootstrap-macos.sh render-plist"
echo ""
echo "  Full checklist: super-agent/docs/HANDOFF_MACOS.md"

#!/usr/bin/env bash
# WSL2 development bootstrap for super-agent-auto-loop-runtime.
# Run from anywhere. This script lives in super-agent/scripts/, so the fork root is ../.. .
# Keep everything inside the Linux filesystem: never drive the runtime from /mnt/c.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGING="$(cd "$SCRIPT_DIR/.." && pwd)"          # super-agent/
ROOT="$(cd "$STAGING/.." && pwd)"                # fork root (has package.json)
CONFIG="$STAGING/config/rules.example.json"
SUPER_CONFIG="$STAGING/config/super.example.json"
STATE_DIR="${AGENT_AUTOLOOP_HOME:-$HOME/.agent-autoloop}"

echo "==> checking runtime (fork root: $ROOT)"
node --version | grep -qE '^v(2[4-9]|[3-9][0-9])\.' || {
  echo "Node >=24 required. The repo has .nvmrc: run 'nvm use' or install Node 24."
  echo "Current: $(node --version)"
  exit 1
}
command -v git >/dev/null || { echo "git required"; exit 1; }
command -v curl >/dev/null || { echo "curl required"; exit 1; }
[[ -f "$ROOT/package.json" ]] || { echo "no package.json at $ROOT; check the checkout layout"; exit 1; }

echo "==> state dir + permissions"
mkdir -p "$STATE_DIR/logs" "$STATE_DIR/work" "$STATE_DIR/branches" "$STATE_DIR/audit"
chmod 0700 "$STATE_DIR"
find "$STATE_DIR" -maxdepth 1 -type f -exec chmod 0600 {} +

echo "==> install config (never overwrite an existing file)"
if [[ ! -f "$STATE_DIR/rules.json" ]]; then
  cp "$CONFIG" "$STATE_DIR/rules.json"
  echo "    wrote $STATE_DIR/rules.json (REVIEW IT: contains example ids and answerers)"
fi
# The super plane lives in its own file: the upstream rules validator rejects unknown fields.
if [[ ! -f "$STATE_DIR/super.json" ]]; then
  cp "$SUPER_CONFIG" "$STATE_DIR/super.json"
  echo "    wrote $STATE_DIR/super.json (REVIEW IT: accept_mode, projects, budgets)"
fi

echo "==> baseline (the authoritative full run is CI: ubuntu-latest + macos-latest)"
cd "$ROOT"
npm ci
npm run format:check
npm run typecheck
# M0/M1 pure-kernel checks, fast and platform-independent. See super-agent/docs/M0_BASELINE.md.
node --disable-warning=ExperimentalWarning --test \
  tests/purity.test.ts tests/ci-scope.test.ts tests/cron.test.ts tests/super-agent-kernel.test.ts
# Full suite. Needs the external Agent CLIs; on CI they are provisioned by install-smoke.sh.
npm test
node --disable-warning=ExperimentalWarning sim/random.ts 24301 20000
node --disable-warning=ExperimentalWarning sim/crash.ts 1000 12648430
node --disable-warning=ExperimentalWarning sim/mutate.ts

echo "==> start in foreground (Ctrl-C to stop)"
echo "    desktop notifications may report skipped-<card> in WSL; use CLI status"
exec node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts up

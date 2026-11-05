#!/usr/bin/env bash
# WSL2 development bootstrap for super-agent-auto-loop-runtime.
# Run from the fork root AFTER M0. Keeps everything inside the Linux filesystem.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${AGENT_AUTOLOOP_HOME:-$HOME/.agent-autoloop}"

echo "==> checking runtime"
node --version | grep -q '^v24' || { echo "Node 24 required"; exit 1; }
command -v git >/dev/null || { echo "git required"; exit 1; }
command -v curl >/dev/null || { echo "curl required"; exit 1; }

echo "==> state dir + permissions"
mkdir -p "$STATE_DIR/logs" "$STATE_DIR/work" "$STATE_DIR/branches" "$STATE_DIR/audit"
chmod 0700 "$STATE_DIR"
find "$STATE_DIR" -maxdepth 1 -type f -exec chmod 0600 {} +

echo "==> install config (never overwrite an existing rules.json)"
if [[ ! -f "$STATE_DIR/rules.json" ]]; then
  cp "$ROOT/config/rules.example.json" "$STATE_DIR/rules.json"
  echo "    wrote $STATE_DIR/rules.json (REVIEW IT: contains example ids and answerers)"
fi

echo "==> upstream baseline (must be green before any kernel change)"
cd "$ROOT"
npm ci
npm test
node sim/random.ts 24301 200000
node sim/crash.ts 1000 12648430
node sim/mutate.ts

echo "==> start in foreground (Ctrl-C to stop)"
echo "    desktop notifications will report skipped-<card> in WSL; use CLI status"
exec node --disable-warning=ExperimentalWarning bin/agent-autoloop.ts up

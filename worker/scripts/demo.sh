#!/usr/bin/env bash
# scripts/demo.sh — boot anvil, deploy two factories, run the full direct-swap
# demo + reservation race/crash tests, then tear down.
#
#   bash scripts/demo.sh
#
# Env overrides: ANVIL_RPC (reuse an existing anvil), ANVIL_PORT (default 8545).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

export PATH="$HOME/.foundry/bin:$PATH"
ANVIL_PORT="${ANVIL_PORT:-8545}"
ANVIL_RPC="${ANVIL_RPC:-http://127.0.0.1:${ANVIL_PORT}}"

rpc_alive() {
  curl -s -m 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "$ANVIL_RPC" | grep -q '"result"'
}

STARTED_ANVIL=0
if rpc_alive; then
  echo "== reusing existing anvil at $ANVIL_RPC"
else
  echo "== booting anvil on port $ANVIL_PORT"
  anvil --port "$ANVIL_PORT" > /tmp/xcm-anvil.log 2>&1 &
  ANVIL_PID=$!
  STARTED_ANVIL=1
  for i in $(seq 1 30); do
    rpc_alive && break
    sleep 0.5
  done
  rpc_alive || { echo "anvil failed to start; see /tmp/xcm-anvil.log"; exit 1; }
fi

cleanup() {
  if [ "$STARTED_ANVIL" = 1 ]; then
    echo "== tearing down anvil (pid $ANVIL_PID)"
    kill "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Extract the throwaway test private keys anvil printed at startup, so every
# script uses keys matching THIS anvil instance (foundry's default mnemonic
# has changed across versions — never hardcode them).
if [ "$STARTED_ANVIL" = 1 ]; then
  echo "== extracting anvil test keys"
  awk '/^Private Keys/{f=1;next} f && /^\(/{print $2} f && NF==0 && ++c>1{exit}' /tmp/xcm-anvil.log \
    | head -8 | python3 -c "import json,sys; ks=[l.strip() for l in sys.stdin if l.strip().startswith('0x')]; assert len(ks)>=5 and all(len(k)==66 for k in ks), ks; json.dump(ks, open('$ROOT/.anvil-keys.json','w'))" \
    && echo "   wrote $ROOT/.anvil-keys.json ($(python3 -c "import json; print(len(json.load(open('$ROOT/.anvil-keys.json'))))") keys)"
  export ANVIL_KEYS_FILE="$ROOT/.anvil-keys.json"
elif [ -z "${ANVIL_KEYS_FILE:-}" ] && [ ! -f "$ROOT/.anvil-keys.json" ]; then
  echo "NOTE: reusing external anvil but no key file found."
  echo "Set ANVIL_KEYS_FILE to a JSON array of that anvil's throwaway private keys."
  exit 1
else
  export ANVIL_KEYS_FILE="${ANVIL_KEYS_FILE:-$ROOT/.anvil-keys.json}"
fi

echo "== deploying factories (chain A / chain B)"
ANVIL_RPC="$ANVIL_RPC" node scripts/deploy.js

echo "== full direct swap demo (happy path + refund path)"
ANVIL_RPC="$ANVIL_RPC" node scripts/demo.js --fresh

echo "== reservation race + crash-recovery tests"
node scripts/test-reservations.js

echo "== watcher restart-recovery tests (chain-truth re-derivation)"
ANVIL_RPC="$ANVIL_RPC" node scripts/test-recovery.js --data ./data-recovery

echo
echo "== ALL DONE (exit $?)"

#!/usr/bin/env bash
# scripts/smoke.sh — end-to-end smoke test for the relay.
# Starts the server on a scratch data dir, runs the full flow:
#   post offer (signed) → commitment → commitment-ack (advisory reservation)
#   → lock proofs → watcher confirmations → open auction → ticks
#   → 3 signed acceptances → outcome → signed Merkle checkpoint
# asserts the deterministic §8 winner rule by hand, verifies tick chains,
# acceptance signatures, the checkpoint, and the log chain, then kills the
# server. Must exit 0.
set -euo pipefail

RELAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"
DATA_DIR="$(mktemp -d)"
export DATA_DIR

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ FAIL: $1" >&2; exit 1; }

# json extractor: jget '.offerId' reads JSON from stdin
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

echo "== relay smoke test =="
echo "   relay dir: $RELAY_DIR"
echo "   data dir:  $DATA_DIR"

# --- start server ---
node "$RELAY_DIR/server.js" >"$DATA_DIR/server.log" 2>&1 &
SRV_PID=$!
cleanup() { kill "$SRV_PID" 2>/dev/null || true; wait "$SRV_PID" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 50); do
  if curl -sf "$BASE/v1/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
  if ! kill -0 "$SRV_PID" 2>/dev/null; then echo "server died:"; cat "$DATA_DIR/server.log"; exit 1; fi
done
curl -sf "$BASE/v1/health" >/dev/null || fail "server did not come up"
pass "server up on :$PORT"

PUBKEY=$(curl -sf "$BASE/v1/health" | jget "d['relay']['publicKeyDerHex']")
[ -n "$PUBKEY" ] && pass "relay identity: ed25519 pubkey ${PUBKEY:0:16}…"

NOW=$(date +%s)
EXPIRY=$((NOW + 86400))

# --- helper: build a signed offer via node (ed25519 + solana-style + evm stub) ---
# usage: make_offer <offerId> <makerAddrKind:ed25519|solana> ; prints the offer JSON on stdout
make_offer() {
  OFFER_ID="$1" KIND="$2" node -e "
const crypto = require('node:crypto');
const { canonicalize } = require('$RELAY_DIR/src/canonical');
const { offerSignBytes, base58Encode } = require('$RELAY_DIR/src/offer_sigs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const raw = publicKey.export({format:'der',type:'spki'});
const raw32 = raw.subarray(raw.length - 32);
const offerId = process.env.OFFER_ID, kind = process.env.KIND, expiry = Number(process.env.EXPIRY);
const offer = { version: 1, offerId, fillMode: 'solver',
  giveChain: 'base-sepolia', giveAsset: 'native', giveAmount: '1000000',
  wantChain: 'robinhood-testnet', wantAsset: 'native', wantAmount: '300000',
  minFillAmount: '1000',
  makerAddr: kind === 'solana' ? base58Encode(raw32) : '0xmaker000000000000000000000000000000000001',
  makerRecvAddr: '0xmakerrecv00000000000000000000000000000002',
  takerAddr: null, takerCredential: null, arbiter: null, fiatLeg: null,
  makerTimelockSec: 7200, takerTimelockSec: 3600, commitWindowSec: 3600,
  auctionWindowSec: 60, auctionFloorBps: 500,
  expiry, nonce: 'smoke-nonce-1', signatures: {} };
const bytes = offerSignBytes(offer);
const sig = crypto.sign(null, bytes, privateKey).toString('hex');
if (kind === 'solana') offer.signatures.solana = sig;
else offer.signatures.ed25519 = { pubkey: publicKey.export({format:'der',type:'spki'}).toString('hex'), sig };
offer.signatures.evm = '0xdeadbeef'; // EIP-712 shape only — honestly UNVERIFIED (agents verify locally)
console.log(JSON.stringify(offer));
"
}

# --- 1. post an ed25519-signed offer (fillMode solver so we can auction it) ---
OFFER=$(EXPIRY=$EXPIRY make_offer smoke-offer-1 ed25519)
RESP=$(curl -sf -X POST "$BASE/v1/offers" -H 'Content-Type: application/json' -d "$OFFER")
echo "$RESP" | jget "d['offerId']" | grep -q '^smoke-offer-1$' || fail "offerId mismatch"
echo "$RESP" | jget "d['signatureStatuses']['ed25519']" | grep -q '^VERIFIED$' || fail "ed25519 offer sig must be VERIFIED"
echo "$RESP" | jget "d['signatureStatuses']['evm']" | grep -q '^UNVERIFIED$' || fail "evm sig must stay honestly UNVERIFIED"
pass "offer posted: ed25519 sig VERIFIED, evm honestly UNVERIFIED (agents verify locally)"

# --- 1b. post a Solana-style offer (makerAddr = base58 pubkey, ed25519 sig) ---
OFFER_SOL=$(EXPIRY=$EXPIRY make_offer smoke-offer-sol solana)
RESP_SOL=$(curl -sf -X POST "$BASE/v1/offers" -H 'Content-Type: application/json' -d "$OFFER_SOL")
echo "$RESP_SOL" | jget "d['signatureStatuses']['solana']" | grep -q '^VERIFIED$' || fail "solana offer sig must be VERIFIED"
pass "solana-style offer: sig VERIFIED against base58 makerAddr"

# --- 1c. tampered offer signature must be rejected ---
BAD_OFFER=$(echo "$OFFER" | python3 -c "import json,sys; o=json.load(sys.stdin); o['giveAmount']='9999999'; print(json.dumps(o))")
if curl -sf -X POST "$BASE/v1/offers" -H 'Content-Type: application/json' -d "$BAD_OFFER" >/dev/null 2>&1; then
  fail "offer with tampered sig was accepted"
fi
pass "offer with invalid ed25519 sig rejected (400)"

# --- 2. taker commitment + maker's signed ack mirror (advisory reservation) ---
COMMIT='{"f":"200000","fillNonce":"smoke-n1","takerAddrs":{"giveChain":"base-sepolia","wantChain":"robinhood-testnet"}}'
FILL_ID=$(curl -sf -X POST "$BASE/v1/offers/smoke-offer-1/commitments" -H 'Content-Type: application/json' -d "$COMMIT" | jget "d['fillId']")
[ -n "$FILL_ID" ] || fail "no fillId from commitment"
ACK="{\"fillNonce\":\"smoke-n1\",\"f\":\"200000\",\"reservedUntil\":$((NOW + 3600)),\"makerSig\":\"0xmakersig\"}"
ACK_RESP=$(curl -sf -X POST "$BASE/v1/offers/smoke-offer-1/acks" -H 'Content-Type: application/json' -d "$ACK")
echo "$ACK_RESP" | jget "d['reservedAmount']" | grep -q '^200000$' || fail "reservedAmount != 200000"
echo "$ACK_RESP" | jget "d['remainingAmount']" | grep -q '^800000$' || fail "remainingAmount != 800000"
pass "commitment + ack mirrored: reserved=200000 remaining=800000 (advisory)"

# over-reserve must be rejected on the advisory side too
BIG_ACK="{\"fillNonce\":\"smoke-n2\",\"f\":\"900000\",\"reservedUntil\":$((NOW + 3600))}"
if curl -sf -X POST "$BASE/v1/offers/smoke-offer-1/acks" -H 'Content-Type: application/json' -d "$BIG_ACK" >/dev/null 2>&1; then
  fail "over-reservation was accepted"
fi
pass "over-reservation rejected (advisory atomic check-and-reserve)"

# --- 3. lock proofs: mirrored UNCONFIRMED, then watcher-confirmed ---
H="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
TXM="0xmakertx0000000000000000000000000000000000000000000000000000000001"
TXT="0xtakertx0000000000000000000000000000000000000000000000000000000002"
LP_M="{\"fillId\":\"$FILL_ID\",\"chain\":\"base-sepolia\",\"txid\":\"$TXM\",\"h\":\"$H\",\"side\":\"maker\"}"
LP_T="{\"fillId\":\"$FILL_ID\",\"chain\":\"robinhood-testnet\",\"txid\":\"$TXT\",\"h\":\"$H\",\"side\":\"taker\"}"
LP_M_RESP=$(curl -sf -X POST "$BASE/v1/lock-proofs" -H 'Content-Type: application/json' -d "$LP_M")
echo "$LP_M_RESP" | jget "d['chainVerified']" | grep -q '^False$' || fail "mirrored proof must start chainVerified=false"
echo "$LP_M_RESP" | jget "d['fill']['verification']['maker']['status']" | grep -q '^unconfirmed$' || fail "maker proof must be unconfirmed"
FILLED=$(curl -sf -X POST "$BASE/v1/lock-proofs" -H 'Content-Type: application/json' -d "$LP_T" | jget "d['filledAmount']")
[ "$FILLED" = "200000" ] || fail "filledAmount != 200000 (got $FILLED)"
pass "lock proofs mirrored: filled=200000, chainVerified=false (unconfirmed)"

# watcher confirmations carry txid + blockHeight + hash evidence (spec §12)
CONF_M="{\"fillId\":\"$FILL_ID\",\"side\":\"maker\",\"chain\":\"base-sepolia\",\"txid\":\"$TXM\",\"blockHeight\":1234567,\"h\":\"$H\",\"watcherId\":\"smoke-watcher\"}"
CONF_T="{\"fillId\":\"$FILL_ID\",\"side\":\"taker\",\"chain\":\"robinhood-testnet\",\"txid\":\"$TXT\",\"blockHeight\":7654321,\"h\":\"$H\",\"watcherId\":\"smoke-watcher\"}"
CONF_M_RESP=$(curl -sf -X POST "$BASE/v1/lock-proofs/confirm" -H 'Content-Type: application/json' -d "$CONF_M")
echo "$CONF_M_RESP" | jget "d['fill']['chainVerified']" | grep -q '^False$' || fail "chainVerified must stay false until BOTH sides confirm"
echo "$CONF_M_RESP" | jget "d['fill']['verification']['maker']['status']" | grep -q '^confirmed$' || fail "maker proof must be confirmed"
CONF_T_RESP=$(curl -sf -X POST "$BASE/v1/lock-proofs/confirm" -H 'Content-Type: application/json' -d "$CONF_T")
echo "$CONF_T_RESP" | jget "d['fill']['chainVerified']" | grep -q '^True$' || fail "chainVerified must be true after both confirmations"
echo "$CONF_T_RESP" | jget "d['fill']['verification']['taker']['evidence']['blockHeight']" | grep -q '^7654321$' || fail "evidence blockHeight missing"
pass "watcher confirmations: chainVerified=false→true, txid+blockHeight+hash evidence stored"

# confirmation with mismatched h must be rejected
CONF_BAD="{\"fillId\":\"$FILL_ID\",\"side\":\"maker\",\"chain\":\"base-sepolia\",\"txid\":\"$TXM\",\"blockHeight\":1,\"h\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"watcherId\":\"smoke-watcher\"}"
if curl -sf -X POST "$BASE/v1/lock-proofs/confirm" -H 'Content-Type: application/json' -d "$CONF_BAD" >/dev/null 2>&1; then
  fail "confirmation with mismatched h was accepted"
fi
# confirmation with a different txid than the mirrored one must be rejected
CONF_BADTX="{\"fillId\":\"$FILL_ID\",\"side\":\"maker\",\"chain\":\"base-sepolia\",\"txid\":\"0xothertx0000000000000000000000000000000000000000000000000000000003\",\"blockHeight\":1,\"h\":\"$H\",\"watcherId\":\"smoke-watcher\"}"
if curl -sf -X POST "$BASE/v1/lock-proofs/confirm" -H 'Content-Type: application/json' -d "$CONF_BADTX" >/dev/null 2>&1; then
  fail "confirmation with mismatched txid was accepted"
fi
# confirmation for unknown fillId must 404
CONF_UNKNOWN="{\"fillId\":\"nope\",\"side\":\"maker\",\"chain\":\"base-sepolia\",\"txid\":\"$TXM\",\"blockHeight\":1,\"h\":\"$H\",\"watcherId\":\"smoke-watcher\"}"
if curl -sf -X POST "$BASE/v1/lock-proofs/confirm" -H 'Content-Type: application/json' -d "$CONF_UNKNOWN" >/dev/null 2>&1; then
  fail "confirmation for unknown fillId was accepted"
fi
pass "bad confirmations rejected (h mismatch, txid mismatch, unknown fillId)"

# --- 4. open auction ---
AUC_RESP=$(curl -sf -X POST "$BASE/v1/auctions" -H 'Content-Type: application/json' \
  -d '{"offerId":"smoke-offer-1","startPrice":"0.000300","auctionWindowSec":60,"auctionFloorBps":500,"lockWindowSec":120}')
AUCTION_ID=$(echo "$AUC_RESP" | jget "d['auctionId']")
[ -n "$AUCTION_ID" ] || fail "no auctionId"
pass "auction opened: $AUCTION_ID"

# --- 5. three ticks (relay advances price, signed + hash-chained) ---
TICK1=$(curl -sf -X POST "$BASE/v1/auctions/$AUCTION_ID/ticks")
TICK2=$(curl -sf -X POST "$BASE/v1/auctions/$AUCTION_ID/ticks")
TICK3=$(curl -sf -X POST "$BASE/v1/auctions/$AUCTION_ID/ticks")
P1=$(echo "$TICK1" | jget "d['tick']['price']")
P2=$(echo "$TICK2" | jget "d['tick']['price']")
P3=$(echo "$TICK3" | jget "d['tick']['price']")
SIG1=$(echo "$TICK1" | jget "d['tick']['relaySig']")
[ -n "$SIG1" ] || fail "tick missing relaySig"
python3 - "$P1" "$P2" "$P3" <<'EOF' || fail "tick prices not decaying"
import sys
p1, p2, p3 = map(float, sys.argv[1:4])
assert p1 > p2 > p3, f"not decaying: {p1} {p2} {p3}"
assert abs(p1 - 0.00029975) < 1e-12, f"tick1 price wrong: {p1}"
EOF
pass "3 ticks: price decaying 0.000300 → $P3, relay-signed, hash-chained"

# --- 5b. tick chain verifies live (hash recompute + linkage + relaySigs) ---
TICKCHAIN_OK=$(curl -sf "$BASE/v1/auctions/$AUCTION_ID" | jget "d['tickChain']['ok']")
[ "$TICKCHAIN_OK" = "True" ] || fail "tickChain did not verify"
pass "tick chain verified live: hashes + linkage + relay signatures"

# --- 6. signed acceptances: A@tick3, B@tick1, C@tick1 ---
# node mints 3 filler keypairs and signs each acceptance core
FILLERS_JSON=$(AUCTION_ID="$AUCTION_ID" P1="$P1" P3="$P3" node -e "
const crypto = require('node:crypto');
const { canonicalize } = require('$RELAY_DIR/src/canonical');
const { acceptanceCore } = require('$RELAY_DIR/src/auctions');
const aid = process.env.AUCTION_ID;
const defs = [
  { tick: 3, price: process.env.P3, fillerAddr: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  { tick: 1, price: process.env.P1, fillerAddr: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
  { tick: 1, price: process.env.P1, fillerAddr: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' },
];
const out = defs.map((d) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const fillerPubkey = publicKey.export({format:'der',type:'spki'}).toString('hex');
  const body = { tick: d.tick, price: d.price, f: '400000', fillerAddr: d.fillerAddr, fillerPubkey };
  body.sig = crypto.sign(null, Buffer.from(canonicalize(acceptanceCore(aid, body)), 'utf8'), privateKey).toString('hex');
  return body;
});
console.log(JSON.stringify(out));
")
FA="0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
FB="0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
FC="0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
i=0
echo "$FILLERS_JSON" | python3 -c "import json,sys; [print(json.dumps(x)) for x in json.load(sys.stdin)]" | while read -r ACC; do
  R=$(curl -sf -X POST "$BASE/v1/auctions/$AUCTION_ID/acceptances" -H 'Content-Type: application/json' -d "$ACC")
  echo "$R" | jget "d['acceptance']['sigStatus']" | grep -q '^VERIFIED$' || fail "acceptance sig must be VERIFIED"
  i=$((i+1)); echo "  ✓ acceptance $i signature VERIFIED (ed25519)"
done
# tampered acceptance (price changed after signing) must be rejected
TAMPERED=$(echo "$FILLERS_JSON" | python3 -c "
import json,sys
a = json.load(sys.stdin)[0]; a['price'] = '0.000300'
print(json.dumps(a))")
if curl -sf -X POST "$BASE/v1/auctions/$AUCTION_ID/acceptances" -H 'Content-Type: application/json' -d "$TAMPERED" >/dev/null 2>&1; then
  fail "tampered acceptance was accepted"
fi
# unsigned acceptance must be rejected
if curl -sf -X POST "$BASE/v1/auctions/$AUCTION_ID/acceptances" -H 'Content-Type: application/json' \
    -d "{\"tick\":3,\"price\":\"$P3\",\"f\":\"1\",\"fillerAddr\":\"$FA\"}" >/dev/null 2>&1; then
  fail "unsigned acceptance was accepted"
fi
# below-tick-price acceptance must be rejected (Dutch rule)
if curl -sf -X POST "$BASE/v1/auctions/$AUCTION_ID/acceptances" -H 'Content-Type: application/json' \
    -d "{\"tick\":3,\"price\":\"0.00000001\",\"f\":\"1\",\"fillerAddr\":\"$FA\",\"sig\":\"$(python3 -c "print('ab'*64)")\",\"fillerPubkey\":\"00\"}" >/dev/null 2>&1; then
  fail "below-tick-price acceptance was accepted"
fi
pass "3 acceptances recorded (sigs VERIFIED); tampered/unsigned/below-tick-price rejected"

# --- 7. outcome: assert deterministic winner rule by hand ---
OUTCOME=$(curl -sf "$BASE/v1/auctions/$AUCTION_ID/outcome")
WINNER=$(echo "$OUTCOME" | jget "d['outcome']['winner']")
WTICK=$(echo "$OUTCOME" | jget "d['outcome']['winningTick']")
EW_S=$(echo "$OUTCOME" | jget "d['outcome']['exclusiveWindow']['start']")
EW_E=$(echo "$OUTCOME" | jget "d['outcome']['exclusiveWindow']['end']")
[ $((EW_E - EW_S)) -eq 120 ] || fail "exclusiveWindow != 120s"
EXPECTED=$(FB="$FB" FC="$FC" python3 - <<'EOF'
import hashlib, os
fb, fc = os.environ["FB"], os.environ["FC"]
# rule: (tick ASC, sha256(fillerAddr) ASC); B and C both at tick 1 < A at tick 3
hb, hc = hashlib.sha256(fb.encode()).hexdigest(), hashlib.sha256(fc.encode()).hexdigest()
print(fb if hb < hc else fc)
EOF
)
[ "$WINNER" = "$EXPECTED" ] || fail "winner $WINNER != expected $EXPECTED"
[ "$WTICK" = "1" ] || fail "winningTick != 1"
pass "outcome: winner=$WINNER at tick 1 (rule recomputed by hand: sha256 tiebreak between tick-1 bids)"

# --- 8. verify the outcome record's ed25519 relay signature with node ---
node -e "
const { RelaySigner } = require('$RELAY_DIR/src/signer');
const key = require('$DATA_DIR/relay-key.json');
const https = require('node:http');
https.get('$BASE/v1/auctions/$AUCTION_ID/outcome', (res) => {
  let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
    const o = JSON.parse(b).outcome;
    const { relaySig, ...record } = o;
    const ok = RelaySigner.verifyWith(record, relaySig, key.publicKeyDerHex);
    if (!ok) { console.error('outcome relaySig INVALID'); process.exit(1); }
    console.log('  ✓ outcome record relay signature valid (ed25519)');
  });
}).on('error', (e) => { console.error(e); process.exit(1); });
"

# --- 9. signed Merkle checkpoint over the log ---
CP_RESP=$(curl -sf -X POST "$BASE/v1/checkpoints")
CP_ID=$(echo "$CP_RESP" | jget "d['checkpoint']['checkpointId']")
[ -n "$CP_ID" ] || fail "no checkpointId"
# verify independently: recompute the Merkle root from /v1/log and check the relaySig
RELAY_DIR="$RELAY_DIR" DATA_DIR="$DATA_DIR" BASE="$BASE" CP_ID="$CP_ID" node -e "
const { RelaySigner } = require(process.env.RELAY_DIR + '/src/signer');
const { verifyCheckpoint } = require(process.env.RELAY_DIR + '/src/checkpoints');
const key = require(process.env.DATA_DIR + '/relay-key.json');
const http = require('node:http');
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(process.env.BASE + path, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => resolve(JSON.parse(b)));
      res.on('error', reject);
    }).on('error', reject);
  });
}
(async () => {
  const cps = await get('/v1/checkpoints');
  const cp = cps.checkpoints.find((c) => c.checkpointId === process.env.CP_ID);
  if (!cp) { console.error('checkpoint not listed'); process.exit(1); }
  // pull the full log range the checkpoint commits to
  const log = await get('/v1/log?offset=0&limit=500');
  const v = verifyCheckpoint(cp, log.entries, key.publicKeyDerHex);
  if (!v.ok) { console.error('checkpoint INVALID:', v.error); process.exit(1); }
  console.log('  ✓ checkpoint ' + cp.checkpointId + ': Merkle root recomputed from log (' + cp.entryCount + ' entries), relaySig valid');
})().catch((e) => { console.error(e); process.exit(1); });
"
# a second checkpoint commits to the first checkpoint's own anchor event
# (hash-linked checkpoint chain)
CP2_RESP=$(curl -sf -X POST "$BASE/v1/checkpoints")
echo "$CP2_RESP" | jget "d['checkpoint']['entryCount']" | grep -q '^1$' || fail "chained checkpoint should cover 1 entry (the anchor event)"
echo "$CP2_RESP" | jget "d['checkpoint']['prevCheckpoint']" | grep -q "$(echo "$CP_RESP" | jget "d['checkpoint']['merkleRoot']")" || fail "checkpoint chain not linked"
# a third checkpoint chains again (every anchor adds exactly one new entry,
# so the 409 empty-range path is unreachable via the API — it stays as a
# defensive guard inside buildCheckpoint)
CP3_RESP=$(curl -sf -X POST "$BASE/v1/checkpoints")
echo "$CP3_RESP" | jget "d['checkpoint']['entryCount']" | grep -q '^1$' || fail "chained checkpoint should cover 1 entry"
echo "$CP3_RESP" | jget "d['checkpoint']['prevCheckpoint']" | grep -q "$(echo "$CP2_RESP" | jget "d['checkpoint']['merkleRoot']")" || fail "checkpoint chain not linked"
CP_COUNT=$(curl -sf "$BASE/v1/checkpoints" | jget "d['count']")
[ "$CP_COUNT" = "3" ] || fail "expected 3 checkpoints listed (got $CP_COUNT)"
pass "checkpoints: POST anchors signed Merkle root, GET lists, hash-chained"

# --- 10. log chain verifies (hash chain + all relay sigs) ---
LOG_TOTAL=$(curl -sf "$BASE/v1/log?limit=1" | jget "d['total']")
node "$RELAY_DIR/scripts/verify-chain.js" "$DATA_DIR" || fail "log chain verification failed"
echo "  ✓ log chain verified ($LOG_TOTAL entries: seq, prevHash, hash, relaySig all valid)"

echo ""
echo "SMOKE OK — all assertions passed"

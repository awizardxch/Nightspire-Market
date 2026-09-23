# Nightspire Cross-Chain Marketplace — Relay Skeleton

Off-chain relay for the non-custodial HTLC marketplace (spec: `~/workspace/specs/cross-chain-marketplace/SPEC.md` — the spec is **read-only**, never edited from here).
The relay is an **order book + auctioneer + watcher**, and per spec §12 it is
**NEVER a custodian**: no keys, no escrowed assets, no chain writes. Rule zero:
*chain state is truth; relay data is a hint.*

Zero external npm dependencies — Node.js 24 built-ins only (`node:http`, `node:crypto`, `node:fs`).

## Run

```bash
cd ~/workspace/cross-chain-marketplace/relay
node server.js            # listens on :8787 (PORT env override)
PORT=8788 DATA_DIR=/tmp/relay-data node server.js   # scratch instance
```

Boot behavior: the hash-chained log is fully verified (seq continuity,
prevHash linkage, hash recomputation, ed25519 relaySig) — a broken chain
**refuses to boot** (fail closed). State is restored from the snapshot plus a
log replay; expired advisory reservations are swept back to the pool.

## What's REAL vs what's STUBBED

**REAL (working, verified by smoke test):**
- **Relay identity** (`src/signer.js`): real ed25519 keypair via `node:crypto`,
  generated on first boot to `data/relay-key.json` (0600). Every relay message
  (log entries, auction ticks, auction outcomes) is signed. Agents pin the
  pubkey (`GET /v1/health` / `GET /v1/relay-pubkey`); rotation is out-of-band
  only (spec §12).
- **Append-only hash-chained log** (`src/log.js`): `data/log.jsonl`, one entry
  per line, fsync after every append (write-ahead). Entry:
  `{seq, prevHash, type, payload, hash, relaySig}` with
  `hash = sha256(prevHash || canonicalJson(payload))` (canonical = sorted-key
  JSON, no whitespace) and `relaySig = ed25519(canonicalJson({seq, prevHash,
  hash, type, payload}))`. Genesis prevHash is `"GENESIS"`. Verify offline any
  time: `node scripts/verify-chain.js [dataDir]`.
- **Advisory reservation mirror** (`src/store.js`): per-offer **serial queue**
  (promise-chain mutex) makes check-and-reserve atomic *within this process* —
  the §7 pattern on the advisory side. Over-reservation is rejected; expired
  reservations are swept. Read the label: the authoritative ledger lives in
  the maker's worker; the relay only mirrors, and the maker's signed
  commitment-ack is authoritative.
- **Dutch auction ticks** (`src/auctions.js`): discrete signed ticks
  `{auctionId, tick, price, prevTickHash, tickHash, ts, relaySig}`, hash-chained
  so price history can't be rewritten silently. Linear decay from ask to
  reserve floor (`auctionFloorBps`) over `auctionWindowSec` ticks.
  `verifyTickChain()` recomputes every tickHash, checks prevTickHash linkage
  and every relaySig — run on boot replay (corrupt ticks dropped fail-closed)
  and served live on `GET /v1/auctions/:id`.
- **Acceptance signatures VERIFIED** (`src/auctions.js`): fillers sign canonical
  `{auctionId, tick, price, f, fillerAddr}` with ed25519; the relay verifies
  against `fillerPubkey` and REJECTS unsigned/badly-signed bids (spec §8, §12).
- **Offer signature verification** (`src/offer_sigs.js`): ed25519 and
  Solana-style (base58 `makerAddr`) signatures verified in stdlib; offers with
  INVALID signatures are rejected. EIP-712/Chia-BLS honestly marked
  UNVERIFIED with reasons.
- **Signed Merkle checkpoints** (`src/checkpoints.js`): `POST /v1/checkpoints`
  commits to a contiguous log range — Merkle root over entry hashes, ed25519
  relaySig, hash-linked to the previous checkpoint. Anyone can recompute the
  root from `/v1/log` and verify.
- **Lock-proof chainVerified plumbing** (`src/store.js`): mirrored proofs start
  `unconfirmed` (`chainVerified: false`); `POST /v1/lock-proofs/confirm`
  (the watcher's local stand-in) promotes them with txid+blockHeight+hash
  evidence cross-checked against the mirrored proof; both sides confirmed ⇒
  `chainVerified: true`.
- **Deterministic winner rule** (spec §8): valid acceptances (tick exists,
  `price >= tick.price`) sorted by `(tick ASC, sha256(fillerAddr) ASC)` — the
  first entry wins. `sha256(fillerAddr)` = sha256 over the UTF-8 bytes of the
  fillerAddr hex string, compared as hex ascending. Anyone can recompute it from
  the tick chain + acceptance set. The signed outcome record
  `{auctionId, offerId, winner, winningTick, winningPrice, f,
  exclusiveWindow:{start,end}, acceptancesConsidered, decidedAt, relaySig}` is
  the §8 slashing evidence base.
- **Advisory accounting**: `filledAmount` / `reservedAmount` / `remainingAmount`
  served per offer, clearly labeled `chainVerified: false`, unsigned.
- **Durability**: snapshot to `data/state.json` every 10 appends + on graceful
  shutdown; boot replays the verified log. Survives `kill -9` (tested).

**STUBBED (honest markers in code + responses):**
- EIP-712 / Chia BLS offer signatures → `UNVERIFIED` with reasons (need
  keccak256+secp256k1-recovery / BLS12-381 — not in Node stdlib). Agents MUST
  verify these locally (spec §12).
- Chain watcher (`src/watcher.js`) — interface only (`pollLeg`, `onLockSeen`,
  `onClaimSeen`, `submitClaim`, `watchFill`); every method throws. Never called.
  `POST /v1/lock-proofs/confirm` is its local stand-in: production watchers
  re-verify from their own trusted RPCs before confirming.
- Public checkpoint ANCHORING (Nostr note / cheap on-chain log) — checkpoints
  are produced and served; anchoring is an external publisher's job.
- Preimage forwarding (`src/preimage.js`) — throws; production forwards `s` to
  the claim pipeline. Never called.

**Signature contracts (byte-for-byte):**
- Offer: `signBytes = UTF-8(canonicalize(offer minus "signatures"))`
  (canonical = sorted-key JSON, no whitespace). `signatures.ed25519 =
  {pubkey: <SPKI DER hex>, sig}` or `signatures.solana = <hex>` (verified
  against base58 `makerAddr`). Invalid signatures → the offer is REJECTED.
- Acceptance: `core = {auctionId, tick, price, f, fillerAddr}` (price as the
  submitted string); `sig = ed25519(UTF-8(canonicalize(core)))`, verified
  against `fillerPubkey` (ed25519 SPKI DER hex). Unsigned/badly-signed bids
  are REJECTED — posting requires valid signatures (spec §8, §12).

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/health`, `/v1/relay-pubkey` | liveness + pinned relay identity |
| POST | `/v1/offers` | CrossChainOffer (§4); structural validation incl. fillMode enum, chain enum, base-unit amounts, T1 > T2 iron rule. ed25519/Solana sigs verified (INVALID → 400). Returns `offerId`, `signatureStatuses{ed25519,solana,evm,chia}`. |
| GET | `/v1/offers` | board, each with `advisory{filled,reserved,remaining}` + `badges{mediated, fiatLeg, kycGated, directed}` + `signatureStatuses` |
| GET | `/v1/offers/:id` | single offer + advisory + badges |
| POST | `/v1/offers/:id/commitments` | taker fill commitment; advisory range check; returns `fillId = sha256("offerId\|\|fillNonce")` |
| POST | `/v1/offers/:id/acks` | advisory mirror of maker's signed commitment-ack `{fillNonce, f, reservedUntil[, makerSig]}`; atomic check-and-reserve via serial queue |
| POST | `/v1/lock-proofs` | `{fillId, chain, txid, h, side}` advisory mirror; starts `unconfirmed` (`chainVerified: false`); both legs ⇒ fill counts as filled |
| POST | `/v1/lock-proofs/confirm` | watcher confirmation `{fillId, side, chain, txid, blockHeight, h, watcherId}`; evidence cross-checked vs mirrored proof; both sides ⇒ `chainVerified: true` |
| POST | `/v1/auctions` | `{offerId, startPrice, auctionWindowSec?, auctionFloorBps?, lockWindowSec?}` → `auctionId` (offer must be `solver`/`any`) |
| GET | `/v1/auctions/:id` | ticks + acceptances + outcome + live `tickChain` verification |
| POST | `/v1/auctions/:id/ticks` | relay advances price, appends signed tick |
| POST | `/v1/auctions/:id/acceptances` | `{tick, price, f, fillerAddr, sig, fillerPubkey}`; sig VERIFIED (ed25519), unsigned/invalid rejected; tick exists + price ≥ tick.price |
| GET | `/v1/auctions/:id/outcome` | deterministic winner, **ed25519-signed** outcome record |
| GET | `/v1/log?offset&limit` | paginated hash-chained event log |
| POST | `/v1/checkpoints` | anchor a signed Merkle checkpoint over new log entries (409 if none) |
| GET | `/v1/checkpoints` | list of signed checkpoints |

Badges: `mediated` when `arbiter != null` (venue UI MUST badge, spec §5),
`fiatLeg` when `fiatLeg != null` (fiat never settles atomically, spec §3.3).

## Full flow (curl)

```bash
B=http://127.0.0.1:8787
EXP=$(($(date +%s)+86400))

# 1. maker posts an offer (solver mode so it can be auctioned)
curl -s -X POST $B/v1/offers -H 'Content-Type: application/json' -d "{
  \"version\":1,\"offerId\":\"demo-1\",\"fillMode\":\"solver\",
  \"giveChain\":\"base-sepolia\",\"giveAsset\":\"native\",\"giveAmount\":\"1000000\",
  \"wantChain\":\"robinhood-testnet\",\"wantAsset\":\"native\",\"wantAmount\":\"300000\",
  \"minFillAmount\":\"1000\",
  \"makerAddr\":\"0xmaker1\",\"makerRecvAddr\":\"0xmakerrecv1\",
  \"makerTimelockSec\":7200,\"takerTimelockSec\":3600,\"commitWindowSec\":3600,
  \"auctionWindowSec\":60,\"auctionFloorBps\":500,
  \"expiry\":$EXP,\"nonce\":\"demo-nonce\",
  \"signatures\":{\"evm\":\"0x…\"}}"

# 2. taker commits, maker acks (relay mirrors the reservation, advisory)
curl -s -X POST $B/v1/offers/demo-1/commitments -H 'Content-Type: application/json' \
  -d '{"f":"200000","fillNonce":"fill-1","takerAddrs":{"giveChain":"base-sepolia","wantChain":"robinhood-testnet"}}'
curl -s -X POST $B/v1/offers/demo-1/acks -H 'Content-Type: application/json' \
  -d "{\"fillNonce\":\"fill-1\",\"f\":\"200000\",\"reservedUntil\":$(($(date +%s)+3600)),\"makerSig\":\"0x…\"}"

# 3. relay opens the Dutch auction
AUC=$(curl -s -X POST $B/v1/auctions -H 'Content-Type: application/json' \
  -d '{"offerId":"demo-1","startPrice":"0.000300","auctionWindowSec":60,"auctionFloorBps":500}')
AID=$(echo "$AUC" | python3 -c "import json,sys;print(json.load(sys.stdin)['auctionId'])")

# 4. relay publishes ticks (price decays: 0.000300 → 0.000285)
P1=$(curl -s -X POST $B/v1/auctions/$AID/ticks | python3 -c "import json,sys;print(json.load(sys.stdin)['tick']['price'])")
P3=$(curl -s -X POST $B/v1/auctions/$AID/ticks >/dev/null; \
     curl -s -X POST $B/v1/auctions/$AID/ticks | python3 -c "import json,sys;print(json.load(sys.stdin)['tick']['price'])")
echo "tick1=$P1 tick3=$P3"   # tick1=0.00029975 tick3=0.00029925

# 5. two fillers accept: C at tick 3 (earlier bid, lower price), B at tick 1
curl -s -X POST $B/v1/auctions/$AID/acceptances -H 'Content-Type: application/json' \
  -d "{\"tick\":3,\"price\":\"$P3\",\"f\":\"400000\",\"fillerAddr\":\"0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\",\"sig\":\"0x…\"}"
curl -s -X POST $B/v1/auctions/$AID/acceptances -H 'Content-Type: application/json' \
  -d "{\"tick\":1,\"price\":\"$P1\",\"f\":\"400000\",\"fillerAddr\":\"0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\",\"sig\":\"0x…\"}"

# 6. deterministic outcome — tick 1 beats tick 3, so 0xBBBB… wins
curl -s $B/v1/auctions/$AID/outcome | python3 -m json.tool

# verify the winner rule by hand: the only thing that matters is the sort
# (tick ASC, sha256(fillerAddr) ASC). Any tick-1 acceptance beats any tick-3
# acceptance, regardless of filler address. Ties on tick break on
# sha256(fillerAddr) hex ascending:
python3 -c "
import hashlib
for a in ['0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB','0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC']:
    print(a, hashlib.sha256(a.encode()).hexdigest()[:16])"

# 7. log chain verifies offline (hashes + all relay signatures)
node scripts/verify-chain.js
```

## Smoke test

```bash
bash scripts/smoke.sh
```

Starts the server on a scratch `DATA_DIR`, runs the whole flow above plus the
advisory reservation checks (over-reserve rejected, lock-proof mirroring +
watcher confirmations with evidence, below-tick-price rejection), asserts the
§8 winner rule by recomputing it in Python, verifies the outcome record's
ed25519 signature in Node, verifies every tick chain + acceptance signature,
anchors and independently re-verifies a signed Merkle checkpoint, verifies the
full log chain, then kills the server. Must exit 0.

## Spec ambiguities hit (decisions made here, open to revision)

1. **`hash = sha256(prevHash||canonicalJson)`**: taken literally, the hash binds
   prevHash + payload only. `relaySig` additionally signs `{seq, prevHash, hash,
   type, payload}`, so ordering is still bound — documented in `src/log.js`.
2. **`fillId = sha256(offerId||fillNonce)`**: fixed as UTF-8 of the literal
   string `"offerId||fillNonce"` with a `||` separator (`src/store.js`). On-chain
   contracts and workers must use the same encoding.
3. **`sha256(fillerAddr)` sort key**: sha256 over the UTF-8 bytes of the
   fillerAddr hex string; hex digests compared ascending (`src/auctions.js`).
4. **Acceptance `f`**: carried as stated by the filler; the auction covers the
   whole window, so `f` is informational in v1 — enforcement is a venue/worker
   concern.
5. **`exclusiveWindow`**: `{start: decidedAt, end: start + lockWindowSec}`
   (default 120s); sits inside W per spec §9.
6. **Tick price units**: decimal string (want-per-give ratio); compared
   numerically. The skeleton does not do exact decimal arithmetic — production
   should use integer base-unit ratios.
7. **Multi-relay / checkpoint anchoring**: checkpoints are produced and served
   (signed, hash-linked, verifiable against the log); PUBLIC ANCHORING
   (Nostr note / cheap on-chain log) is an external publisher's job and is
   out of scope here.
8. **Acceptance signing bytes**: `sig = ed25519(UTF-8(canonicalize(
   {auctionId, tick, price, f, fillerAddr})))` with price as the submitted
   string; `fillerPubkey` is ed25519 SPKI DER hex. The signature binds the
   payout address to the pubkey holder — the §8 slashing evidence.
9. **Offer signing bytes**: `UTF-8(canonicalize(offer minus "signatures"))`.
   EIP-712 and Chia BLS stay UNVERIFIED (reasons in `src/offer_sigs.js`) —
   agents MUST verify those locally (spec §12); the relay check is edge
   anti-spam, never the trust root.

## Threat-model notes (spec §12)

- A malicious relay operator here can delay or censor discovery (single relay,
  no multiplicity yet) but cannot forge signatures, invent auction winners
  (winner rule is recomputed from the published chain + acceptance set), or
  touch funds (no keys, no chain access — by construction, not just policy).
- History rewrites break the hash chain and are caught at boot and by
  `verify-chain.js`.
- Equivocation (split views) is NOT prevented in the skeleton — that needs the
  public checkpoints (stubbed) + multiple relays.
- Agents must verify offer/commitment/acceptance signatures locally; this relay
  explicitly does not (marked UNVERIFIED everywhere).

## Layout

```
relay/
  server.js               HTTP server + routes + boot replay + snapshots
  src/
    signer.js             REAL ed25519 relay identity (data/relay-key.json, 0600)
    canonical.js          canonical JSON for hashing/signing
    log.js                REAL hash-chained JSONL log, fsync-per-append, boot verify
    store.js              offers, commitments, advisory reservations + serial queue
    auctions.js           REAL signed ticks + §8 deterministic winner rule
    watcher.js            STUB — chain watcher interface (throws, never called)
    preimage.js           STUB — preimage forwarder interface (throws, never called)
  scripts/
    smoke.sh              end-to-end smoke test (must pass)
    verify-chain.js       offline log-chain verifier (hashes + relay sigs)
  data/                   created at runtime: relay-key.json, log.jsonl, state.json
  package.json            zero dependencies
```

# Nightspire cross-chain marketplace — agent worker + chain watcher (local demo)

Off-chain Spellbook-worker-style loop that runs direct HTLC swaps per the
[marketplace spec](../../specs/cross-chain-marketplace/SPEC.md) §3.1 (7-step direct
flow), §7 (reservation protocol), §9 (timelocks), §10 (watcher duties + restart
recovery). Backed by **real local chain reads/writes against anvil** — no mocks
in the swap path.

> **Spec is read-only.** Nothing under `../../specs/` was touched.

## Quick start

```bash
bash scripts/demo.sh
```

That single command: boots anvil (or reuses one at `$ANVIL_RPC`), extracts its
throwaway test keys, deploys **two** `HTLCFactory` instances (simulating chain A
/ chain B), runs the full direct-swap demo (happy path **and** refund path),
then the reservation race / crash tests and the watcher restart-recovery tests,
and tears anvil down. Expected result: `16/16 + 17/17 + 9/9 checks passed`.

Individual pieces:

| command | what |
|---|---|
| `node scripts/deploy.js [--rpc URL]` | deploy the two factories → `deployments.json` |
| `node scripts/demo.js [--fresh]` | full swap demo: happy path + refund path (needs anvil + deployments) |
| `node scripts/test-reservations.js` | §7 race, single-writer lease, kill -9, stale-expiry, fillNonce replay |
| `node scripts/test-recovery.js` | §10 restart recovery: chain-truth re-derivation |
| `node scripts/worker-node.js` | helper: lease-holding worker subprocess for the kill -9 tests |

## Architecture

```
worker/
  src/
    chain.js         viem clients, HTLCFactory/HTLCEscrow wrappers, event
                     queries, anvil time-warp. Keys loaded from the key file
                     demo.sh extracts from the live anvil instance.
    reservations.js  §7 durable ledger: JSONL write-ahead + fsync per record,
                     per-offer serial promise queue (atomic check-and-reserve),
                     restart recovery with stale-reservation expiry,
                     single-writer lease file (second instance, same maker id,
                     refuses with ELEASE_HELD). fillNonce single-use per offer
                     (anti-replay). markFilled/release idempotent.
    watcher.js       §10 state machine per fillId:
                     committed → makerLocked → takerLocked → claimed | refunded
                     (+ expired). JSONL swap store, fsync'd. On restart,
                     re-derives every in-flight swap from CHAIN reads (role-aware:
                     Withdrawn-on-B is terminal for the maker, preimage-only for
                     the taker) — persisted phase is only a hint.
    maker.js         role flow: verify taker commitment sig → atomic reserve →
                     signed ack → fresh (s,h) → newContract on A (T1) → lock proof →
                     tick: verify taker lock on B → withdraw(s) on B (reveals s) /
                     refund() on A after T1 / release reservation on W expiry.
    taker.js         role flow: sign commitment → verify HTLC_A on-chain
                     (amount, hashlock, timelock, receiver, refundAddr, fillId,
                     arbiter==0) → newContract on B (T2<T1, same h) →
                     tick: read s from Withdrawn event → withdraw(s) on A /
                     refund() on B after T2.
    util.js          fillId = sha256("offerId||fillNonce") as UTF-8, fresh secrets,
                     canonical JSON, pro-rata math.
  scripts/           deploy / demo / tests (above)
  data/              per-worker durable state (gitignored): <makerId>/reservations.jsonl,
                     <workerId>/swaps.jsonl, leases/<makerId>.json
```

The demo wires maker + taker workers in one process and passes commitments and
lock proofs by direct call — standing in for the relay (see STUB below).

## Timelocks (test-only)

Spec §9 wants 6h/3h. The local demo uses **T1=120s / T2=60s / W=300–600s** so the
refund path is exercisable. The refund test warps chain time with anvil's
`evm_increaseTime` + `evm_mine` — that RPC exists only on a dev node and is
clearly marked TEST ONLY in code and logs.

## What's REAL vs STUB

**Real:**
- Chain reads and writes via viem against anvil: factory deploys, `newContract`
  (native, `msg.value == amount`), `withdraw(preimage)`, `refund()`, all escrow
  field reads, `ContractCreated` / `Withdrawn` / `Refunded` event scans.
- Event-driven claims: the taker learns `s` only from the on-chain `Withdrawn`
  event; the maker discovers the taker lock by scanning factory events by
  `fillId`. No out-of-band secret passing.
- Durable ledger: every reservation/swap mutation is JSONL-appended and
  `fsync`'d **before** any signature is produced; torn lines from `kill -9`
  are skipped on replay.
- Atomic check-and-reserve: per-offer serial queue; the worker never signs a
  commitment it hasn't reserved (race test: 2×0.8 ETH vs 1.0 ETH → exactly one
  signed ack, one signed rejection).
- Single-writer lease: live holder → second instance refuses; `kill -9` →
  dead pid → lease retaken, no phantom state.
- Restart recovery: stale reservations expire; swap phases re-derived from
  chain (a tampered `committed` phase is corrected to `makerLocked` from the
  fillId scan); claims re-submitted idempotently; terminal swaps reconciled
  with the ledger without double-counting.

**Stub (documented, next slices):**
- **No EIP-712.** Commitments/acks/rejections are `personal_sign`-style
  `signMessage` signatures over canonical JSON. Spec §4 wants EIP-712 typed
  offers/commitments — signature *verification* is real (wrong-key commits are
  rejected), the typed-data envelope is the stub.
- **No relay.** Workers talk directly in-process; the relay's order book,
  hash-chained log, Dutch auctions, and preimage forwarding are not
  implemented. Lock "proofs" are return values, not relay messages.
- **One anvil simulates two chains.** Two factory instances on one node; same
  address space, same clock. A true two-chain run needs a second anvil (or
  testnet) with per-chain RPCs — `chainEndpoint` already takes separate
  `rpcUrl`s, so this is a config change plus cross-instance funding.
- **Native-only, EVM-only.** ERC-20 path (`safeTransferFrom`) is in the
  contracts but not exercised; no Solana/Chia legs (contracts don't exist yet
  per spec §16 build order).
- **No solver network, auctions, slashing, arbitration, fiat legs, KYC.**
  Direct mode only, `arbiter == address(0)` (pure HTLC), no bonds.
- **No Spellbook integration.** Keys are anvil throwaways, signing is local,
  no standing-approval caps/velocity limits (§14) — the `settleAccount`
  separation (claim/refund gas paid by a third account, proving refund never
  assumes `msg.sender`) is the hook point.
- **Polling watcher** (1s in demo, spec says ≤60s) rather than subscriptions;
  fine for local, subscriptions for production.

## Keys

**Local anvil ONLY. No testnet/mainnet, no real private keys.** `demo.sh`
extracts the started anvil's own printed throwaway keys into `.anvil-keys.json`
(gitignored); scripts refuse to run without that file (or `$ANVIL_KEYS_FILE`)
rather than guessing keys — foundry's default mnemonic has changed across
versions, so hardcoded "well-known" keys were wrong. Never commit this file.

## Spec ambiguities hit (and calls made)

1. **fillId encoding** (§5): "sha256(offerId||fillNonce)" — implemented as
   SHA-256 over the UTF-8 bytes of the literal string `"offerId||fillNonce"`
   (per the task's contract notes), distinct from the factory's keccak
   `computeId` salt. On-chain it's an opaque `bytes32` either way.
2. **Taker terminal state** (§10): `Withdrawn` on chain B is terminal for the
   *maker* (it revealed `s`) but only preimage-evidence for the *taker*.
   `derivePhase` is role-aware; the task's `claimed` phase means "my leg's
   claim is done" per role.
3. **fillNonce reuse** (§7): the spec implies nonces are per-fill unique but
   never says single-use explicitly. Implemented as single-use per
   `(offerId, fillNonce)` — a nonce that was ever reserved is rejected
   forever (prevents replay/fillId confusion); takers retry with a fresh nonce.
   Found and fixed via a failing rerun test.
4. **Who may call refund/withdraw** — anyone (payout is hardcoded). The demo
   routes maker claim/refund gas through a dedicated `settleAccount` to prove
   the point and keep balance assertions exact.
5. **`remaining` and expired reservations**: `remaining = total − filled − Σ
   active reservations`; expiry is lazy (on read/restart), which matches "a
   crash can only strand f until reservedUntil".

## Deltas from a naive reading (bugs caught by the tests)

- `recoverMessageAddress` is exported from `viem`, not `viem/accounts`.
- Swap records contain BigInts — JSON needs a replacer.
- The taker's "timelock in the future" check compared the escrow's timelock
  against itself; it must compare against current chain time.
- `waitForLine`-style harness race: READY and ENTERING_ATOMIC can arrive in
  one stdout chunk — the watcher now uses one accumulating buffer per child.
- Duplicate-`fillNonce` re-reservation after fill (above) — the rerun test
  caught it; now covered by a dedicated regression test.

## Natural next slice

1. **Second anvil instance** for a true two-chain run (separate `rpcUrl`s per
   `chainEndpoint`, cross-fund role accounts) — the code is already shaped for it.
2. **EIP-712** typed commitments/acks per spec §4 offer format.
3. **Relay integration**: order book + commitment/lock-proof message transport
   replacing the in-process calls; hash-chained log.
4. **ERC-20 leg** (approve + `safeTransferFrom` path) and partial-fill
   choreography across two fills on one offer.
5. Solver-mode auction + exclusive claim windows (§8), then Solana/Chia legs
   per the §16 build order.

# Nightspire Chia HTLC

Cross-chain HTLC puzzles for the Nightspire marketplace (spec §5c).
**Local artifacts only — no chain interaction, no mints, no persisted keys.**

Two variants, one shared branch core (`htlc_common.clsp`):

| File | Variant | Arbitrate branch |
|---|---|---|
| `htlc.clsp` → `htlc.hex` | arbiter-capable | mode 2, gated on non-null `ARBITER_PK` |
| `htlc_noarb.clsp` → `htlc_noarb.hex` | pure HTLC | none — mode 2 (and any other non-0/1) raises |

Use the pure variant whenever the offer names no arbiter (the default).
The arbiter variant's mode 2 is **mediated mode**: whoever holds the arbiter
key can unilaterally reassign the escrow — only curry a key the offer
explicitly opts into (spec §5 trust note).

## Roles

The puzzle has **no maker/taker semantics** — only explicit keys and
addresses. Spec §5's role table decides which key/address fills each slot
per leg (e.g. on the maker's first leg the claimer is the taker/filler and
the refunder is the maker; on the second leg they swap).

## Parameters

Curried positionally, in this exact order:

```
HASHLOCK            32 bytes   sha256(s), committed by the maker at lock time
TIMELOCK_SECONDS    int        refund opens this many seconds after the lock
                               (ASSERT_SECONDS_RELATIVE — relative semantics)
CLAIMER_PK          48 bytes   BLS key authorised to claim with the preimage
REFUNDER_PK         48 bytes   BLS key authorised to refund after the timelock
CLAIM_PUZZLE_HASH   32 bytes   claim pays here
REFUND_PUZZLE_HASH  32 bytes   refund pays here
FILL_ID             32 bytes   sha256(offerId || fillNonce) — binds the fill
ARBITER_PK          48 bytes | ()   arbiter key, or () for a dead mode 2
                               (arbiter variant only)
```

Solution (uncurried, supplied at spend time):

```
(MODE PAYLOAD AMOUNT)
  MODE 0 — CLAIM:     PAYLOAD = preimage s
  MODE 1 — REFUND:    PAYLOAD = () (ignored)
  MODE 2 — ARBITRATE: PAYLOAD = ((puzzle_hash amount) ...) payout vector
                      (arbiter variant only)
```

`AMOUNT` is the coin's amount, supplied by the spender's wallet — CLVM has
no amount opcode. Every signed message commits to it, so a wrong amount
invalidates the signature (fail-closed; it can only ever burn the
spender's own claim, never redirect funds).

## Timelocks (spec §9)

Any↔Chia schedule: **12h (43200s) first/maker leg, 6h (21600s) second leg**,
via `ASSERT_SECONDS_RELATIVE`. The puzzle takes `TIMELOCK_SECONDS` as a
curried parameter — the worker curries 43200 for the maker's leg and 21600
for the second leg. The maker locks first with the longer timelock.

## Signed messages (must be mirrored byte-exact by the signing wallet)

Integers encode as CLVM minimal big-endian (`600000` → `09 27 c0`).

```
claim:     sha256("NS-HTLC-v1" || FILL_ID || "claim"     || dest_ph || amount)
refund:    sha256("NS-HTLC-v1" || FILL_ID || "refund"    || dest_ph || amount)
arbitrate: sha256("arbitrate"  || FILL_ID || payout_digest)

payout_digest: fold over ((ph_1 amt_1) (ph_2 amt_2) ...):
    d_0 = ""
    d_{i+1} = sha256(d_i || ph_i || amt_i)
```

Consensus verifies each `AGG_SIG_ME` as
`AugSchemeMPL.verify(pk, msg || coin_id || genesis_challenge, sig)`.
The arbitrate message deliberately commits to the payout *vector*, not the
amount: created coins come from the signed vector, and the solution amount
only gates the over-creation check (`total > amount` raises). Lying upward
about the amount cannot create value — consensus still caps outputs at the
coin's real value.

## Conditions emitted

* **Claim** — `CREATE_COIN CLAIM_PUZZLE_HASH amount`, `AGG_SIG_ME CLAIMER_PK
  msg`, `CREATE_PUZZLE_ANNOUNCEMENT sha256(FILL_ID || "claim")`.
  Requires `sha256(s) == HASHLOCK`.
* **Refund** — `ASSERT_SECONDS_RELATIVE TIMELOCK_SECONDS`,
  `CREATE_COIN REFUND_PUZZLE_HASH amount`, `AGG_SIG_ME REFUNDER_PK msg`,
  `CREATE_PUZZLE_ANNOUNCEMENT sha256(FILL_ID || "refund")`.
* **Arbitrate** — `AGG_SIG_ME ARBITER_PK msg`,
  `CREATE_PUZZLE_ANNOUNCEMENT sha256(FILL_ID || "arbitrate")`,
  one `CREATE_COIN` per payout pair. Refuses `total > amount`.

Announcements are **broadcasts, not authorizations** (spec §5c): they let
off-chain watchers attribute the spend to its fill; they gate nothing.

**Fees: none** (spec §13). Every branch moves the full amount; no output is
skimmed. An arbiter-signed payout vector totalling *less* than the coin
burns the remainder — that is the arbiter's signed choice in mediated mode,
not a fee. (The empty vector burns everything; sign one only deliberately.)

**Duplicate outputs:** two identical `(ph, amt)` pairs in a payout vector
would be rejected by consensus as `DUPLICATE_OUTPUT`. The off-chain
composer (relay/worker) MUST merge same-recipient payouts before the
arbiter signs.

## Build & test

Requires `clvm_tools` 0.4.10, `blspy`, `chia_rs` (user-space pip is fine):

```sh
cd contracts/chia
python3 run_tests.py        # compiles both puzzles, runs 36 checks
```

`run_tests.py` compiles from source on every run, executes branches with
`brun`, and verifies real throwaway BLS signatures. Keys are generated
fresh in-process and never persisted.

**Coverage boundary (be honest about it):** `brun` checks condition
*structure*; it does not enforce BLS signatures or wall-clock timelocks.
Signature validity is proven by real `blspy` sign/verify against
byte-exact messages; timelock *semantics* (relative, consensus-enforced)
need testnet11. Mainnet stays gated on testnet11 validation and the
Familiar `clvmPuzzleAudit.md` pass.

## Toolchain notes

* `clvm_tools` 0.4.10 compiles each `defun` **closed**: a defun body cannot
  see the mod's curried parameters (they silently compile to quoted
  garbage). All helpers in `htlc_common.clsp` therefore take every value
  as an explicit parameter — no hidden captures, which is also the
  auditable shape.
* The same version's constant optimizer crashes on a bare `(a)` anywhere
  in the source (`apply requires exactly 2 parameters`), so the solution
  is destructured via named mod parameters (`MODE PAYLOAD AMOUNT`), not
  manual `(f (a))` peeling.
* `sha256tree` is unavailable in this toolchain; the payout digest is a
  deterministic recursive `sha256` fold instead (documented above — the
  signer must implement the same fold).

## Files

* `htlc.clsp` / `htlc.hex` — arbiter-capable source and compiled program
* `htlc_noarb.clsp` / `htlc_noarb.hex` — pure variant source and program
* `htlc_common.clsp` — shared branch logic (compile-time include)
* `run_tests.py` — 36-check local test suite (36/36 passing, 2026-09-23)
* `cat_usage.md` — composing the HTLC as a CAT2 inner puzzle
* `spend_bundle_template.json` — unsigned example spend bundle

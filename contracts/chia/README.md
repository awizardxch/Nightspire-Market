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
                               (ASSERT_SECONDS_RELATIVE) and the claim closes
                               at the same instant (ASSERT_BEFORE_SECONDS_RELATIVE)
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
  MODE 0 — CLAIM:     PAYLOAD = preimage s, EXACTLY 32 bytes
  MODE 1 — REFUND:    PAYLOAD = () (required; anything else raises)
  MODE 2 — ARBITRATE: PAYLOAD = ((puzzle_hash amount) ...) payout vector
                      (arbiter variant only; each puzzle_hash 32 bytes,
                      each pair exactly two elements)
```

**Preimage width is a cross-chain invariant: `|s| == 32`.** The EVM leg's
`withdraw(bytes32 preimage)` and the Solana leg's `preimage: [u8; 32]` can
only ever accept a 32-byte secret, and a hashlock reveals nothing about the
width of its preimage. The Chia claim branch therefore checks
`(strlen s) == 32` *before* comparing `sha256(s)` to `HASHLOCK`; a secret of
any other width can take neither this leg nor the other one, so a maker
cannot claim the Chia leg with a secret the taker cannot use.

`AMOUNT` is the coin's amount, supplied by the spender's wallet — CLVM has
no amount opcode. Every branch emits `ASSERT_MY_AMOUNT AMOUNT`, so a wrong
`AMOUNT` is refused by consensus (`ASSERT_MY_AMOUNT_FAILED`) instead of
quietly burning the difference to fees. Every signed message commits to it
as well (fail-closed; a mismatch can never redirect funds).

Unread solution fields are pinned: `AGG_SIG_ME` covers the message, not the
solution, so anything the puzzle did not read could be rewritten by a
relayer under the same signature (a different bundle identity, inflated
cost). The refund `PAYLOAD` must be `()` and each arbitrate payout pair must
be exactly `(puzzle_hash amount)`.

## Timelocks (spec §9)

Any↔Chia schedule: **12h (43200s) first/maker leg, 6h (21600s) second leg**.
The puzzle takes `TIMELOCK_SECONDS` as a curried parameter — the worker
curries 43200 for the maker's leg and 21600 for the second leg. The maker
locks first with the longer timelock.

The two branches are gated by a complementary pair of relative conditions
on the same `TIMELOCK_SECONDS`:

* claim: `ASSERT_BEFORE_SECONDS_RELATIVE TIMELOCK_SECONDS` (opcode 84)
* refund: `ASSERT_SECONDS_RELATIVE TIMELOCK_SECONDS` (opcode 80)

Both are judged against the timestamp of the **previous transaction
block** relative to the coin's birth, so in any block exactly one of
claim/refund is valid for a coin — there is no window in which a late
claim and a refund can race each other for the same coin. Two consequences
worth knowing:

* Chia time is block time. The boundary falls in whichever block the
  farmer's timestamp first reaches `birth + TIMELOCK_SECONDS`; neither
  spender chooses it. The claimer should treat the deadline as soft by a
  block or two.
* A relative `BEFORE` condition is forbidden on an **ephemeral** coin (one
  created and spent in the same bundle — `EPHEMERAL_RELATIVE_CONDITION`).
  The lock and the claim are therefore always separate bundles, which they
  are in any real cross-chain flow anyway (the counterparty must see the
  lock confirmed before revealing anything). `spend_bundle_template.json`
  shows the two bundles.

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
only gates the over-creation check (`total > amount` raises). The amount
itself is pinned to the coin by `ASSERT_MY_AMOUNT`, so neither lying upward
(would be `MINTING_COIN` anyway) nor downward (would burn the difference)
gets past consensus.

## Conditions emitted

* **Claim** — `ASSERT_MY_AMOUNT amount`,
  `ASSERT_BEFORE_SECONDS_RELATIVE TIMELOCK_SECONDS`,
  `CREATE_COIN CLAIM_PUZZLE_HASH amount (CLAIM_PUZZLE_HASH)`,
  `AGG_SIG_ME CLAIMER_PK msg`,
  `CREATE_PUZZLE_ANNOUNCEMENT sha256(FILL_ID || "claim")`.
  Requires `(strlen s) == 32` and `sha256(s) == HASHLOCK`.
* **Refund** — `ASSERT_MY_AMOUNT amount`,
  `ASSERT_SECONDS_RELATIVE TIMELOCK_SECONDS`,
  `CREATE_COIN REFUND_PUZZLE_HASH amount (REFUND_PUZZLE_HASH)`,
  `AGG_SIG_ME REFUNDER_PK msg`,
  `CREATE_PUZZLE_ANNOUNCEMENT sha256(FILL_ID || "refund")`.
  Requires `PAYLOAD == ()`.
* **Arbitrate** — `ASSERT_MY_AMOUNT amount`, `AGG_SIG_ME ARBITER_PK msg`,
  `CREATE_PUZZLE_ANNOUNCEMENT sha256(FILL_ID || "arbitrate")`,
  one `CREATE_COIN ph amt (ph)` per payout pair. Refuses `total > amount`,
  any pair that is not exactly two elements, and any `ph` that is not
  32 bytes.

Every `CREATE_COIN` repeats its destination puzzle hash as the first memo —
the **hint** CAT2 wallets use to discover coins (see `cat_usage.md`). For
plain XCH it is redundant and harmless.

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

Requires `clvm_tools` 0.4.10, `blspy`, `chia_rs` — all pinned in
`requirements.txt` (user-space pip is fine):

```sh
cd contracts/chia
python3 run_tests.py              # compiles both puzzles, runs 63 checks
python3 run_tests.py --write-hex  # ...and regenerates the committed artefacts
```

`run_tests.py` compiles from source on every run **into memory** and fails
with a clear message if the committed `htlc.hex` / `htlc_noarb.hex` differ
from the build: the committed hex is the canonical artefact (the
counterparty verifies its tree hash on chain), so drift must be a deliberate
act. After an intended source change run `--write-hex`, which rewrites both
`.hex` files and the real `puzzle_hash` / `puzzle_reveal` / `solution`
fields of `spend_bundle_template.json`, then commit them together. The
suite then executes every branch with `brun` and verifies real throwaway
BLS signatures. Keys are generated fresh in-process and never persisted.

**Coverage boundary (be honest about it):** `brun` checks condition
*structure*; it does not enforce BLS signatures, `ASSERT_MY_AMOUNT` or the
timelock pair. Signature validity is proven by real `blspy` sign/verify
against byte-exact messages. Consensus behaviour is covered by the
simulator lane:

```sh
python3 sim_tests.py              # needs chia-blockchain (see below)
```

`sim_tests.py` runs the committed `htlc.hex` on `chia._tests.util.spend_sim`
— chia-blockchain's real mempool manager and coin store, in process, no
network — with real `AGG_SIG_ME` signatures, and pins the refusal code of
every attack beside its honest control: 33-/1-byte preimages, non-nil
refund payloads and malformed payout pairs (`GENERATOR_RUNTIME_ERROR`),
under-/over-stated `AMOUNT` (`ASSERT_MY_AMOUNT_FAILED`), a claim after the
timelock (`ASSERT_BEFORE_SECONDS_RELATIVE_FAILED`), a refund before it
(`ASSERT_SECONDS_RELATIVE_FAILED`), a lock and claim in one bundle
(`EPHEMERAL_RELATIVE_CONDITION`), and hint-based discovery of every created
coin. It needs **chia-blockchain** (tested with 2.5.6), which is a full-node
package and is deliberately *not* in `requirements.txt`; install it in a
separate venv (`pip install chia-blockchain==2.5.6`). Without it the script
exits **2** with a message — never 0 — so a missing simulator can't read
as a pass. Mainnet stays gated on testnet11 validation and the Familiar
`clvmPuzzleAudit.md` pass.

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
* The payout digest is a flat recursive `sha256` fold rather than
  `sha256tree`. `sha256tree` is an ordinary library `defun` (not an
  operator) and would work here; the fold was kept because it is simpler
  for the signing wallet to mirror byte-for-byte (documented above). The
  fold hashes raw concatenations, so the inputs it folds are validated
  separately: every payout pair must be exactly `(ph amt)` with a 32-byte
  `ph` (checked in `payout-conditions`, which every arbitrate spend
  evaluates), and consensus refuses non-canonical amounts.

## Files

* `htlc.clsp` / `htlc.hex` — arbiter-capable source and compiled program
* `htlc_noarb.clsp` / `htlc_noarb.hex` — pure variant source and program
* `htlc_common.clsp` — shared branch logic (compile-time include)
* `run_tests.py` — 63-check local test suite with hex drift detection
  (63/63 passing, 2026-10-07); `--write-hex` regenerates the artefacts
* `sim_tests.py` — 24-check simulator suite (chia-blockchain required;
  24/24 passing on 2.5.6, 2026-10-07)
* `main.sym` — symbol table written by the compiler (toolchain artefact)
* `cat_usage.md` — composing the HTLC as a CAT2 inner puzzle
* `spend_bundle_template.json` — unsigned example: the lock bundle and the
  separate claim bundle

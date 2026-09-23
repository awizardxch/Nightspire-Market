# HTLC as a CAT2 inner puzzle

Spec §5c: *"XCH: coin at the HTLC puzzle hash. CATs: same logic as the CAT2
inner puzzle — one design covers both."* This note describes the
composition. It is a **design document** — the HTLC programs here have been
tested standalone (see `run_tests.py`); the CAT wrapping itself has not
been executed locally and, like everything else, awaits testnet11.

## Roles of the three layers

| Layer | Program | Governs |
|---|---|---|
| TAIL | canonical bridge-TAIL curried with `("XCM-WRAP-v1" \|\| evmChainId \|\| tokenAddress)` | **issuance**: who may mint/melt (spec §6.3: issuer bridge key only) |
| CAT outer puzzle | standard CAT2 `cat.clsp` | **accounting**: CAT conservation across the spend, lineage proofs |
| **inner puzzle** | **`htlc.hex` / `htlc_noarb.hex` (curried)** | **spending**: claim / refund / arbitrate branches |

Nothing about the HTLC changes between XCH and CAT use. The CAT outer
puzzle runs the inner puzzle with the inner solution and wraps every
`CREATE_COIN` the inner puzzle emits into a CAT child coin of the same
asset. The HTLC's `AMOUNT` is then denominated in **CAT base units**, and
every signed message commits to CAT amounts — the signer must use the
post-decimals amount (spec §6.2: keep CAT decimals identical to the EVM
token where possible so base units match 1:1).

## Constructing the CAT coin

```
tail_hash   = tree_hash(canonical_bridge_TAIL.curry(token_identifier))
inner       = htlc_curried            # either variant, 8 (or 7) args curried
cat_puzzle  = CAT_MOD.curry(tail_hash, inner)
coin.puzzle_hash = tree_hash(cat_puzzle)
```

The puzzle hash commits to the TAIL (hence the asset), the exact HTLC
parameters (hashlock, keys, addresses, fill id, timelock), and the
variant — any change rehashes, so a coin cannot be "re-pointed" at
different terms.

## Spending a CAT HTLC coin

The CAT coin's solution carries the standard CAT2 outer solution
(lineage proof, etc.) with the **inner solution** being exactly the
HTLC solution documented in `README.md`:

```
inner_solution = (MODE PAYLOAD AMOUNT)
```

The outer puzzle enforces, independently of the HTLC branches:

* every input CAT's TAIL matches (no cross-asset mixing),
* total CAT out == total CAT in (the HTLC cannot mint or melt; only the
  TAIL's mint path can create supply),
* the announcement-based lineage the wallet needs for the next spend.

The HTLC branches keep their exact semantics: the claim branch's
`CREATE_COIN CLAIM_PUZZLE_HASH amount` becomes a CAT coin of `amount`
base units at that puzzle hash; refund and arbitrate likewise. The
`ASSERT_SECONDS_RELATIVE` timelock and all three `AGG_SIG_ME` checks
apply unchanged.

## What the HTLC does NOT do

* **No issuance.** The HTLC never mints: it only reassigns coins that
  already exist. Minting is the TAIL's job (issuer bridge key, spec §6.3).
  No mint was performed in building or testing these artifacts.
* **No asset binding.** The HTLC is asset-agnostic — the assetId comes
  from the TAIL hash in the outer puzzle. Per spec §6.1 every
  `chiaAssetId` in the relay registry is **provisional** until the
  canonical bridge-TAIL is constructed and hash-stability verified on
  testnet11 (including check (c): the resulting CAT works as an
  inner-puzzle HTLC coin). The venue UI must not quote 1:1 swaps against
  unvalidated entries.

## Worked shape (placeholders — not a real spend)

Locking 600000 base units of CAT `<assetId>` as the maker's first leg:

1. Curry `htlc.hex` (or `htlc_noarb.hex`) with the 8 fill parameters
   (`TIMELOCK_SECONDS = 43200`).
2. Build `cat_puzzle = CAT_MOD.curry(tail_hash, htlc_curried)`.
3. In one spend bundle (see `spend_bundle_template.json` for the XCH
   shape), spend the maker's CAT coin(s): `600000` base units to
   `tree_hash(cat_puzzle)`, remainder to change — atomically, exactly
   like native offers (spec §5c "Change").
4. Claim/refund/arbitrate exactly as for XCH, with the inner solution
   `(MODE PAYLOAD AMOUNT)` embedded in the CAT outer solution.

## Open validation items (testnet11)

* CAT outer puzzle accepts the HTLC inner program (size/cost within limits).
* End-to-end CAT lock → claim and lock → refund on testnet11.
* Canonical bridge-TAIL hash-stability (spec §6.1 a–c).
* Familiar `clvmPuzzleAudit.md` pass over the composed spend, not just the
  inner puzzle in isolation.

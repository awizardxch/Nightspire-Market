# Audit Prep Runbook — DOCS ONLY

> **⛔ DO NOT EXECUTE without Speechless's explicit approval.**
> This runbook freezes the audit scope and packages the evidence. No auditor
> has been engaged, no audit has started, no scope has been sent to anyone.

## Scope freeze (commit-pinned at engagement time)

| Component | Sources | Status |
|-----------|---------|--------|
| Solana program | `contracts/solana/programs/xcm_htlc` (+ vendored `vendor/`) | IN SCOPE |
| Chia CLVM puzzles | `contracts/chia/htlc.clsp`, `htlc_common.clsp`, `htlc_noarb.clsp` | IN SCOPE |
| EVM contracts | `contracts/evm/src/HTLCFactory.sol`, `HTLCEscrow.sol`, Dutch auction | IN SCOPE |
| Relay (`relay/`) | order book, auctions, checkpoints | OUT OF SCOPE (advisory only; explicitly not a trust root) |
| Worker (`worker/`) | fill agent | OUT OF SCOPE (operator tooling) |
| Venue API (`venue-api/`) | read-only contract | OUT OF SCOPE |

The freeze commit is the exact SHA the auditors receive. Any code change after
the freeze restarts scoping.

## Known VALIDATION REQUIRED items (must be shown to auditors as open)

1. **Chia**: testnet11/mainnet consensus enforcement of AGG_SIG_ME and
   ASSERT_SECONDS_RELATIVE — the local suite proves branch logic via `brun`
   only; time-wall behavior of the relative timelock is unproven.
2. **Chia**: canonical bridge-TAIL construction drill on testnet11 — not
   performed (see `docs/runbooks/testnet-pilot.md`).
3. **Cross-chain**: slash verifier set + dispute drill — specified, never
   executed (no testnet, no mainnet).
4. **Solana**: IDL at `target/idl/xcm_htlc.json` is hand-maintained and
   UNVERIFIED until `idl-build` regenerates it — auditors must treat it as
   untrusted input, not ground truth.
5. **EVM**: `arbitrate` is MEDIATED (unilateral arbiter redirect) — a trust
   assumption, not a bug; auditors should confirm the labeling is sufficient.
6. **Relay**: EIP-712 and Chia BLS offer signatures are NOT verified by the
   relay (marked UNVERIFIED); acceptance tickets are ed25519-only. The relay
   is advisory — chain state is truth.
7. **All chains**: no mainnet deployment has occurred; all test evidence is
   from local simulators.

## Artifact inventory (what the auditors get)

- [ ] Frozen git SHA + `git diff` empty attestation
- [ ] Contract sources (in scope per above)
- [ ] Build artifacts: Foundry `out/` hashes, `target/deploy/*.so` sha256,
      compiled `.hex` puzzles
- [ ] Test evidence: CI logs for the frozen commit (EVM 16/16, Chia 36/36,
      Solana 12/12, relay smoke, worker demo 9/9, venue validation)
- [ ] This repo's `docs/ARCHITECTURE.md` (spec → code map)
- [ ] Threat model focus (below)
- [ ] Open questions for auditors (below)

## Threat-model focus (what we most want broken)

1. **Hashlock binding**: can a filler claim with a preimage that wasn't the
   maker's `s`? (Cross-VM: EVM sha256 precompile vs Solana `hash::hash` vs
   Chia `sha256` — byte-identity is asserted by the cross-VM test vector.)
2. **Timelock inversion**: can leg B expire before leg A (T1 > T2 violated)?
   What happens if a chain reorgs across the timelock boundary?
3. **Exclusive-claimer bypass**: can a non-winner claim inside the exclusive
   window on any chain?
4. **Arbiter overreach**: `arbitrate` requires exact-sum payouts (no fee
   skim) — confirm there is no path to redirect more than the escrowed
   amount, and that `arbiter == 0` truly means pure HTLC.
5. **Fill-id confusion**: is `fillId = sha256(offerId||fillNonce)` bound
   into every escrow on every chain, so a preimage can't be replayed across
   fills?
6. **Chia coin-spend malleability**: can a co-spend condition be added that
   the puzzle doesn't constrain (e.g. extra CREATE_COIN draining value)?

## Auditor questions (to include in the brief)

1. Is the MEDIATED arbitration labeling sufficient for users, or does the
   mechanism need restructuring?
2. Are the timelock durations in spec §9 safe against the worst-case
   finality/reorg behavior of each chain?
3. Does the Chia puzzle leak value through any unasserted condition?
4. Is committing the Solana `.so` fixtures (rather than rebuilding in CI)
   an acceptable supply-chain posture, given the vendored-crate diffs?
5. Any objection to the relay's "advisory only" posture — i.e., is there any
   place where venue UI or worker code treats relay data as authoritative?

## Current state

**No audit has been commissioned.** This runbook is the prep package, not a
record. The record begins when Speechless approves an auditor and freezes
the scope commit.

# Testnet Pilot Runbook — DOCS ONLY

> **⛔ DO NOT EXECUTE without Speechless's explicit approval.**
> This runbook is planning documentation. No step below has been performed.
> No contracts have been deployed to any public testnet, no tokens have been
> minted, no bridge transactions have been broadcast. Everything in this repo
> has been validated on local simulators only (anvil, bankrun, brun).

## Pilot phases (approved order)

| Phase | Leg A | Leg B | Status |
|-------|-------|-------|--------|
| 1 | Robinhood testnet (chain 46630) | Base Sepolia (84532) | NOT STARTED |
| 2 | Robinhood testnet | Chia testnet11 | NOT STARTED |
| 3 | Base Sepolia | Chia testnet11 | NOT STARTED |
| 4 | Solana devnet | (pairs TBD by phase 1–3 outcome) | NOT STARTED |

Phases run strictly in order. A phase begins only after the previous phase's
exit criteria are met AND Speechless approves the next phase explicitly.

## Entry criteria (every phase)

- [ ] All CI suites green on the exact commit being piloted
- [ ] Contract artifacts frozen: record bytecode hashes + git SHA in the pilot log
- [ ] Funded throwaway pilot keys ONLY (never reuse mainnet or personal keys)
- [ ] Relay + worker pointed at the phase's chains; watcher RPCs are the
      chains' public testnet endpoints (read-only; the relay never signs)
- [ ] Arbiter key for the phase generated fresh, stored per the custody plan
- [ ] Kill-switch documented: who can halt the relay/worker, and how

## Per-phase drill (each phase)

1. **Direct swap (EVM↔EVM)**: maker posts offer on the relay → taker commits →
   maker locks leg A (T1) → taker locks leg B (T2 < T1) → maker claims B with
   preimage `s` → taker claims A with `s`. Assert on-chain: both escrows
   settled, no residue, timelocks respected (T1 > T2).
2. **Refund path**: lock one leg, let the timelock expire, refund. Assert the
   other leg was never locked / or was refunded too.
3. **Dutch auction (solver mode)**: open auction → ticks → 2+ signed
   acceptances → outcome. Assert the winner matches the §8 rule recomputed
   off-chain, and the exclusive-claimer window is enforced on-chain.
4. **Dispute drill** (see below).

## Canonical Chia bridge-TAIL construction + testnet11 validation (phase 2/3)

The Chia leg of phases 2 and 3 uses the canonical bridge TAIL (Token and
Asset Issuance Limitation) from the spec. Before ANY testnet11 value moves:

1. Construct the TAIL puzzle from the audited `htlc.clsp` source (frozen
   commit), curried with the bridge parameters. Record the puzzle hash.
2. Validate on testnet11 with dust amounts first: mint → lock in HTLC →
   claim with preimage → assert settlement. Then the refund path.
3. Independently recompute every AGG_SIG_ME message (the local suite already
   byte-matches them via `brun`; testnet11 proves consensus enforcement).
4. **VALIDATION REQUIRED**: testnet11 does not prove mainnet consensus. The
   mainnet pilot is a separate approval.

## Cross-chain slash verifier set + dispute drill (every phase)

1. Stand up the verifier set: N watchers (target: 3-of-5) each running
   independent RPC reads on both legs of every pilot fill.
2. Dispute drill: deliberately publish a conflicting lock proof (wrong `h`)
   for a pilot fill. Verifiers must: detect the mismatch, refuse to confirm
   (`chainVerified` stays false), and raise the dispute.
3. Slashing evidence: the relay's signed tick/acceptance/checkpoint log is
   the evidence base — export the log range covering the drill and verify
   the Merkle checkpoint independently.
4. **VALIDATION REQUIRED**: the verifier set's slashing mechanics are
   specified but the on-chain slash execution has not been drilled anywhere.

## Exit criteria (every phase)

- [ ] All four drills above completed with on-chain evidence recorded
- [ ] No unexplained `chainVerified: false` fills left open
- [ ] Relay log exported + checkpoint-verified for the phase
- [ ] Incident log: every anomaly, however small, written up
- [ ] Speechless reviews the phase report and explicitly approves the next phase

## Current state

**No public execution has been performed.** This runbook is the plan, not a
record. The record begins when Speechless approves Phase 1.

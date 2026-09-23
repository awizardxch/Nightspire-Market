# Architecture — EVM contracts slice

Spec: [`../specs/cross-chain-marketplace/SPEC.md`](../specs/cross-chain-marketplace/SPEC.md) (v1, 2026-09-22).
This doc maps spec sections to code in this repo and states what's working vs stubbed.

## Spec § → code map

| Spec | Subject | Code |
|------|---------|------|
| §3.1 | Direct swap 7-step flow (maker-owned secret) | `contracts/evm/test/DirectSwapE2E.t.sol::test_directSwap_fullFlow` — both agents simulated, preimage forwarded via the `Withdrawn` event, full settlement asserted |
| §4 | Offer format (`fillId`, timelocks, `arbiter`, exclusive windows) | Consumed as parameters; `fillId = sha256(offerId \|\| fillNonce)` bound into every escrow id (`HTLCFactory.computeId` includes it) |
| §5 / §5a | EVM escrow: `newContract`, `withdraw`, `refund`, `arbitrate` | `src/HTLCFactory.sol`, `src/HTLCEscrow.sol` |
| §5 trust note | Arbitrate branch is MEDIATED (unilateral arbiter redirect) | Natspec on `HTLCEscrow.arbitrate` is explicitly labeled MEDIATED; `arbiter == address(0)` = pure HTLC |
| §7 | Partial fills: per-fill independent HTLC pair, fillId binding | `fillId` in the CREATE2 salt → unique escrow per fill; `test_determinism`, `test_doubleLock_sameFill_reverts` |
| §8 | Exclusive claim windows (solver mode) | `exclusiveClaimer` / `exclusiveUntil` immutables; `withdraw` enforces during window; `test_exclusiveWindow*` |
| §9 | Timelocks: first-locked leg expires last (T1 > T2) | Enforced off-chain in the flow; `withdraw` requires `t < timelock`, `refund` requires `t >= timelock`; E2E asserts T1 > T2 |
| §13 | No fee skim | Escrows pay the full `AMOUNT` — no fee variable, no treasury, no cut in factory or escrow |
| §17 | Immutability: no proxies, no admin keys | All escrow terms are `immutable`; no upgrade path, no owner, no pause |

## What's working

- `HTLCFactory` — `newContract(receiver, refundAddr, hashlock, timelock, token,
  amount, fillId, arbiter, exclusiveClaimer, exclusiveUntil)`:
  - ERC-20 variant pulls via `safeTransferFrom` (caller approves first);
    native variant is payable and requires `msg.value == amount`;
    `token == address(0)` means native.
  - CREATE2 deploy, salt = `keccak256(abi.encode(all params))` — deterministic,
    recomputable via `computeId(...)`; `predictAddress(...)` previews the address
    without deploying; `getContract(id)` resolves deployed escrows.
  - Guards: zero receiver/refund/hlock/amount rejected; timelock must be future;
    exclusive window without a claimer rejected; same-fill double-lock rejected.
  - Emits `ContractCreated` (watcher index) with all lock parameters.
- `HTLCEscrow` (deployed per fill):
  - `withdraw(preimage)` — `sha256(preimage) == hashlock`, `t < timelock`;
    during `exclusiveUntil` only `exclusiveClaimer` may call; pays `receiver`.
    Emits `Withdrawn` **including the preimage** so the counterparty's watcher
    can forward `s` (spec §3.1 step 6 / §10).
  - `refund()` — `t >= timelock`, pays `refundAddr` (never `msg.sender`),
    callable by any third party. Emits `Refunded`.
  - `arbitrate(recipients, amounts, sig)` — only when `arbiter != address(0)`;
    verifies arbiter ECDSA signature over the raw digest
    `keccak256(abi.encode(address(this), contractId, recipients, amounts))`;
    requires `sum(amounts) == amount` (no stranded dust); executes immediately.
    Emits `Arbitrated`. Natspec labels it MEDIATED per spec §5.
  - Reentrancy-guarded (`nonReentrant` on all three branches); SHA-256 via
    precompile `0x02` (byte-compatible with Solana/Chia legs per spec §1).
- Tests: 16 passing — ERC-20 + native happy paths, third-party-triggered refund,
  wrong-preimage / post-timelock / pre-timelock reverts, arbiter valid/bad/missing
  sig + partial-split guard, exclusive-window revert/winner/after-window,
  determinism + double-lock, and the full 7-step direct flow E2E.

## What's stubbed / out of scope for this slice

- **Relay** (`relay/`) — order book, commitments, Dutch auctions, preimage
  forwarding, hash-chained log: sibling agent's slice, untouched here.
- **Venue API** (`venue-api/`) — sibling agent's slice, untouched here.
- **Solana program** (spec §5b) — not started.
- **Chia CLVM puzzle** (spec §5c) — not started.
- **Stake registry / slashing** (spec §8) — suggested next contracts slice.
- **Offer signing (EIP-712)** (spec §4) — offer layer lives in the relay slice.
- **Deploy scripts** — `contracts/evm/script/` is reserved but empty; no
  deployments per hard constraints.
- **Audits** — code follows audited patterns (OZ guards) but has not been audited.

## Notes / spec ambiguities resolved

1. **Signature scheme for `arbitrate`**: spec says "verifies arbiter signature over
   `(contractId, payouts)`" without specifying the envelope. Implemented as the
   raw 32-byte digest `keccak256(abi.encode(address(this), contractId, recipients,
   amounts))` — `address(this)` binds the sig to one escrow instance (no
   cross-escrow replay), no EIP-191 prefix (documented in natspec; the arbiter
   signs the exact digest). If the venue later wants EIP-191/EIP-712, that's a v2
   factory (spec §17: new versions deploy alongside).
2. **`exclusiveClaimer`/`exclusiveUntil` in `newContract`**: spec §5a lists the
   factory signature without them, but §8 requires exclusive claim windows — the
   task's signature (with both params) is implemented; they're part of the salt.
3. **`Withdrawn` event carries the preimage**: not explicitly required by the
   spec, but §3.1 step 6 / §10 need the taker's watcher to learn `s`; emitting it
   makes the relay/watcher design concrete and is proven by the E2E test.
4. **Refund before vs at timelock**: `withdraw` requires `t < timelock`,
   `refund` requires `t >= timelock` — at exactly `timelock` only refund is live
   (no overlap window where both branches are callable).
5. **Partial arbitrate splits rejected**: `sum(amounts)` must equal `amount` so a
   mediated split can't strand dust in the escrow.

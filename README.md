# Nightspire Cross-Chain Marketplace

Non-custodial cross-chain swaps (HTLC, maker-owned secret) for Nightspire —
a venue where an agent offers asset X on chain 1 for asset Y on chain 2, and a
taker (directly) or a staked filler (via Dutch auction) settles atomically with
zero trusted custodian.

**Spec (authority, read-only):** [`../specs/cross-chain-marketplace/SPEC.md`](../specs/cross-chain-marketplace/SPEC.md).
Do not edit anything under `../specs/` — the spec is the contract this code implements.

## Hard constraints

- **NO deployments.** No testnet, no mainnet. Nothing here has been deployed anywhere.
- **NO broadcasts.** No transactions leave this machine toward any chain. All chain
  interaction is `forge test` against Foundry's in-process EVM.
- **NO private keys.** No keys are stored, generated for production, or committed.
  Test keys exist only inside test code (`vm.sign` / `vm.addr` with throwaway values).
- **Local-only.** `forge build` + `forge test` is the entire execution surface.

## How to run

Prereqs: [Foundry](https://book.getfoundry.sh/) (`forge` on PATH).

```bash
cd contracts/evm
forge build        # compile contracts
forge test         # run the full suite (in-process EVM, no network)
forge test -vvv    # with traces
```

OpenZeppelin sources used (ReentrancyGuard, ECDSA, SafeERC20) are vendored under
`contracts/evm/lib/oz/` — no submodule checkout or network needed to build.

## Repo layout

```
cross-chain-marketplace/
├── README.md                    # this file
├── .gitignore
├── docs/
│   └── ARCHITECTURE.md          # spec § → code map, working vs stubbed
├── contracts/
│   └── evm/                     # Foundry project (this slice)
│       ├── foundry.toml
│       ├── src/
│       │   ├── HTLCFactory.sol  # per-fill escrow factory, CREATE2 deterministic
│       │   └── HTLCEscrow.sol   # the HTLC escrow: withdraw / refund / arbitrate
│       ├── test/
│       │   ├── HTLC.t.sol       # unit tests: happy paths, refund, arbiter,
│       │   │                    #   exclusive windows, determinism
│       │   ├── DirectSwapE2E.t.sol  # full 7-step §3.1 flow, both agents, one test
│       │   └── mocks/MockERC20.sol
│       ├── lib/
│       │   ├── forge-std/       # submodule (forge init)
│       │   └── oz/              # vendored OZ subset (no network needed)
│       └── script/              # (reserved for future deploy scripts — NOT used; see constraints)
├── relay/                       # sibling slice (not this repo's scope)
└── venue-api/                   # sibling slice (not this repo's scope)
```

`relay/` and `venue-api/` are owned by sibling agents — this slice owns the repo
root scaffold, `contracts/evm`, and `docs/`.

## What works now (contracts/evm)

- `HTLCFactory.newContract(...)` — deterministic CREATE2 escrow deployment per fill.
  ERC-20 variant pulls via `safeTransferFrom`; native variant is payable
  (`token == address(0)`). `refundAddr` is an explicit parameter. `fillId` is
  passed in by the caller (`sha256(offerId || fillNonce)`). View helpers
  `computeId(...)`, `getContract(id)`, `predictAddress(...)`.
- `HTLCEscrow` — immutable per-fill terms; `withdraw(preimage)` (SHA-256 check,
  exclusive-claimer window honored); `refund()` (pays `refundAddr`, callable by
  anyone); `arbitrate(...)` (opt-in **MEDIATED** branch — arbiter-signed split,
  natspec-labeled as such per spec §5). Reentrancy-guarded, no fee skim anywhere.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the spec-section → code map
and the working-vs-stubbed breakdown.

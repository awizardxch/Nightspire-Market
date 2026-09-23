# Nightspire Cross-Chain Marketplace

Non-custodial cross-chain swaps (HTLC, maker-owned secret) for Nightspire —
a venue where an agent offers asset X on chain 1 for asset Y on chain 2, and a
taker (directly) or a staked filler (via Dutch auction) settles atomically with
zero trusted custodian.

**Spec (authority, read-only):** [`../specs/cross-chain-marketplace/SPEC.md`](../specs/cross-chain-marketplace/SPEC.md).
Do not edit anything under `../specs/` — the spec is the contract this code implements.

## Hard constraints

- **NO deployments.** No testnet, no mainnet. Nothing here has been deployed anywhere.
- **NO broadcasts.** No transactions leave this machine toward any chain.
- **NO private keys.** No production keys are stored, generated, or committed.
  Throwaway test keys exist only inside test code and local runtime state
  (gitignored).
- **Local-only.** Every suite below runs against a local simulator:
  Foundry's in-process EVM / anvil, Solana bankrun, Chia `brun`, and the
  relay/worker harnesses. External validation (testnet pilots, audits) is
  planned in `docs/runbooks/` and has NOT been performed.

## How to run

Prereqs: [Foundry](https://book.getfoundry.sh/) (`forge`, `anvil` on PATH),
Node 24+, Python 3.12.

### EVM contracts (16 tests)

```bash
cd contracts/evm
forge build
forge test          # in-process EVM, no network
```

OpenZeppelin sources used (ReentrancyGuard, ECDSA, SafeERC20) are vendored
under `contracts/evm/lib/oz/` — no submodule checkout or network needed.

### Chia puzzles (36 tests)

```bash
pip install -r contracts/chia/requirements.txt   # blspy, clvm, clvm_tools (pinned)
python3 contracts/chia/run_tests.py              # compiles with clvm_tools, runs with brun
```

Local only: proves branch logic and BLS message bytes, NOT testnet11/mainnet
consensus. See `contracts/chia/README.md`.

### Solana program (12 tests)

```bash
cd contracts/solana
npm ci
npm run test:bankrun   # 12 bankrun tests: local validator simulation, no network
```

Tests load the committed fixtures `target/deploy/{xcm_htlc,spl_token}.so` and
`target/idl/xcm_htlc.json` — no Solana toolchain build needed. To rebuild the
program binary: `cargo build-sbf` (see `contracts/solana/README.md`).

### Relay smoke test (~30 assertions)

```bash
cd relay
npm run smoke       # boots the server on a scratch dir, runs the full flow
```

No dependencies — pure Node stdlib. Covers: signed offers (ed25519 +
Solana-style verified, invalid rejected), commitment/ack reservation, lock
proofs + watcher confirmations (`chainVerified` false→true with evidence),
auction ticks (hash-chained, live-verified), signed acceptances (tampered /
unsigned / below-tick rejected), deterministic winner rule recomputed by hand,
signed Merkle checkpoints (root recomputed from the log), full log-chain
verification.

```bash
node server.js      # run the relay (DATA_DIR env overrides the data dir)
```

### Worker demo (9 assertions)

```bash
cd worker
npm ci
npm run demo        # boots anvil, deploys two factories, runs the full
                    # direct-swap demo + reservation race/crash tests
```

Local anvil only.

### Venue API validation

```bash
pip install -r venue-api/requirements.txt        # pyyaml, jsonschema (pinned)
python3 venue-api/validate.py                    # openapi.yaml + 25 examples validated
```

### Full CI-equivalent local run

```bash
# from the repo root — mirrors .github/workflows/ci.yml step for step:
(cd contracts/evm    && forge build && forge test)
python3 contracts/chia/run_tests.py
(cd contracts/solana && npm ci && npm test)
(cd relay            && npm run smoke)
(cd worker           && npm ci && npm run demo)
python3 venue-api/validate.py
```

## Repo layout

```
cross-chain-marketplace/
├── README.md
├── .github/workflows/ci.yml   # all suites above, local-only, no secrets
├── docs/
│   ├── ARCHITECTURE.md         # spec § → code map, working vs stubbed
│   └── runbooks/               # DOCS ONLY — do not execute without approval
│       ├── testnet-pilot.md    # 4-phase pilot plan (not started)
│       └── audit-prep.md       # audit scope freeze + evidence list (not started)
├── contracts/
│   ├── evm/                    # Foundry: HTLCFactory + HTLCEscrow + Dutch auction
│   ├── solana/                 # Anchor: xcm_htlc program + bankrun tests
│   └── chia/                   # CLVM puzzles + brun test suite
├── relay/                      # order-book relay: offers, auctions, checkpoints
├── worker/                     # fill worker: commit → lock → claim/refund + recovery
└── venue-api/                  # read-only venue contract (openapi.yaml + examples)
```

## What works now

- **EVM** (`contracts/evm`): `HTLCFactory` (deterministic CREATE2 escrows,
  ERC-20 + native, `fillId`-bound) and `HTLCEscrow` (`withdraw` with SHA-256
  preimage + exclusive-claimer window, `refund` to explicit `refundAddr`,
  opt-in **MEDIATED** `arbitrate`). No fee skim, no proxies, no admin keys.
- **Solana** (`contracts/solana`): `xcm_htlc` program —
  initialize/withdraw/refund/arbitrate with PDA escrows, timelocks,
  exclusive-claimer window. Cross-VM SHA-256 test vector included.
- **Chia** (`contracts/chia`): HTLC-style CLVM puzzles with hashlock/timelock
  escrow, refund paths, arbiter split; every branch proven via `brun`.
- **Relay** (`relay/`): signed offers (ed25519 + Solana-style verified;
  EIP-712/Chia-BLS honestly UNVERIFIED — agents verify locally), signed
  acceptance tickets (invalid rejected), hash-chained Dutch ticks
  (live-verified), lock-proof `chainVerified` plumbing with watcher evidence,
  signed Merkle checkpoints, append-only hash-chained log. Advisory only —
  chain state is truth.
- **Worker** (`worker/`): fill lifecycle with crash recovery.
- **Venue API** (`venue-api/`): read-only offer-board contract, schema-validated.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the spec-section → code
map and the working-vs-stubbed breakdown, and each component's README for
component-level detail.

## What's NOT done (explicitly pending Speechless's approval)

- Testnet pilots (Robinhood testnet ↔ Base Sepolia → Chia testnet11 → Solana
  devnet) — planned in `docs/runbooks/testnet-pilot.md`, **not started**.
- Canonical Chia bridge-TAIL construction / testnet11 drill — **not performed**.
- Cross-chain slash verifier set + dispute drill — **not performed**.
- Audits (Solana program, Chia puzzles, EVM contracts) — **not commissioned**;
  scope freeze drafted in `docs/runbooks/audit-prep.md`.

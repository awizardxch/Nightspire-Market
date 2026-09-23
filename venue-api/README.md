# Nightspire Marketplace Venue API

**Status:** static contract — no implementation yet. Schema/contract only.

## Purpose

This directory defines the JSON/OpenAPI surface the marketplace **relay** serves
and **cast.awizard.dev** consumes as the marketplace venue UI:

- **Offer board** — `GET /v1/offers` (filters: give/want chain + asset, fillMode, mediated, fiatOnly, pagination)
- **Per-offer fill/remaining tracking** — `GET /v1/offers/{offerId}` (offer + `fills[]` with HTLC phase views)
- **1:1 quotes** for canonical bridged tokens — `GET /v1/quotes`
- **Filler auction views** — `GET /v1/auctions/{auctionId}` (hash-chained ticks, acceptances, signed outcome) and `GET /v1/fillers/{address}` (stake + reputation)
- **Token registry** — `GET /v1/tokens`
- **Relay transparency log** — `GET /v1/log/checkpoints` (signed Merkle checkpoints; may 501 in early relay)

The relay never touches funds. The venue UI never touches funds. All settlement is
in on-chain HTLC contracts (spec §5); the venue is a read-only window onto the
order book plus advisory accounting.

## Files

| File | What it is |
|---|---|
| `openapi.yaml` | OpenAPI 3.1 contract, title "Nightspire Marketplace Venue API", version `1.0.0-draft`. The normative contract. |
| `examples/offer-partial-fill.json` | `GET /v1/offers` response: an open partial-fill offer (10 TOKEN on Robinhood ↔ 10 on Chia), 4 filled + 1 reserved + 5 remaining, `status: filling`, provisional want-leg badge. |
| `examples/offer-mediated-arbiter.json` | `GET /v1/offers/{offerId}` response: solver-mode Base→Solana offer with `arbiter` set (badged `isMediated: true`), KYC credential gate, `minFillerStanding`, and one in-flight fill at `makerLocked` phase. |
| `examples/auction-outcome.json` | `GET /v1/auctions/{auctionId}` response: 3-tick hash-chained Dutch auction with two acceptances — FillerB accepted at tick 1, FillerA at tick 2 — so FillerB wins under `sort (tick ASC, sha256(fillerAddr) ASC)` (tick-ASC decides; the sha256 tiebreak only bites on same-tick acceptances). |
| `validate.py` | Structural check: openapi.yaml parses as valid OpenAPI 3.1, expected endpoints/schemas exist, and all examples parse and validate against their schemas. |

## Versioning

Venue API **v1 tracks spec v1**. Changes are **additive only**: new optional
fields, new query params, new endpoints. Never rename, remove, or change the
meaning of an existing field in v1. Breaking changes ship as `/v2` alongside v1;
in-flight swaps and booked quotes always resolve under the version they started
on (mirrors the spec §17 factory-immutability principle at the API layer).

## Badge requirements — the UI MUST enforce

These are not styling suggestions; they are spec-mandated disclosures. The
contract carries the signals as `badges` on every offer so the UI cannot miss them:

1. **Mediated (arbiter) — `badges.isMediated`** (spec §5).
   `isMediated = true` iff `arbiter != null`. Naming an arbiter converts the swap
   from trustless to **mediated**: the arbiter can unilaterally redirect escrowed
   funds before timelock expiry on its signature alone. The UI MUST badge these
   offers as mediated/trusted. Rogue-arbiter risk affects ONLY offers that opted
   in — the user consented to this trust by taking a badged offer.
2. **Fiat leg — `badges.hasFiatLeg`** (spec §3.3).
   GUARANTEE: fiat legs NEVER settle atomically. Only the crypto leg(s) are
   HTLC-atomic; the fiat leg is a mediated, reputation-based exchange with
   signed receipts. The UI MUST badge fiat-leg offers as mediated, MUST surface
   the ramp provider's standing **before** a taker commits, and MUST NOT present
   the fiat side as atomic/settlement-guaranteed.
3. **Provisional token — `badges.validationStatus` / `QuoteResponse.validationStatus`** (spec §6.1).
   A canonical-token leg with `validationStatus: provisional` has NOT yet had its
   bridge-TAIL constructed and hash-stability verified on testnet. The UI MUST
   flag provisional legs and MUST NOT quote 1:1 swaps against unvalidated
   entries (`oneToOneQuotable: false` on quotes). `unregistered` legs (native or
   arbitrary tokens) are not canonical bridged legs at all.

Plus the advisory-data rule (spec §12, rule zero): **chain state is truth; relay
data is a hint.** `advisory.filledAmount/reservedAmount/remainingAmount` are
unsigned mirrors derived from verified on-chain locks. The maker's signed
commitment-ack is authoritative for reservations.

## How the relay serves this

- Read-only REST under `/v1`, JSON. The relay pins its identity key and signs
  ticks, auction outcomes, and checkpoints; agents verify signatures locally
  (spec §12).
- `GET /v1/log/checkpoints` returns **501 `checkpoints_not_ready`** until the
  relay publishes and anchors its first checkpoint. UIs must handle 501 as
  "not yet available", not as a failure.
- Hosting is still undecided (spec §18 Q3); the `servers` URL in openapi.yaml is
  a placeholder until the relay has a real base URL.

## Future additions (documented, not implemented)

- **Websocket tick stream** — live auction tick/acceptance/outcome feed for the
  auction view (currently: poll `GET /v1/auctions/{auctionId}`).
- **Fill-phase push** — websocket or SSE for `FillView.phase` transitions on
  watched offers/fills.
- **POST endpoints are out of scope for the venue contract** — commitments,
  acceptances, and lock proofs are signed messages exchanged maker↔taker/filler
  (over the relay as a channel, per spec §3); the venue API stays read-only.

## Validation

```bash
python3 validate.py
```

Checks: openapi.yaml parses and has valid OpenAPI structure (openapi/info/paths/
components, all `$ref`s resolve); the seven endpoints and key schemas exist;
every example JSON parses and validates against its response schema via
`jsonschema`.

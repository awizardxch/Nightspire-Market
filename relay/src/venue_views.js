'use strict';

/**
 * src/venue_views.js — OpenAPI view adapters for the venue UI.
 *
 * Transforms internal relay state into the response shapes documented in
 * venue-api/openapi.yaml (the Nightspire Marketplace Venue API contract)
 * for the UI-facing read endpoints:
 *
 *   GET /v1/offers             -> OfferList   {offers, page, limit, total}
 *   GET /v1/offers/{offerId}   -> OfferDetail  {offer, fills}
 *   GET /v1/auctions/{auctionId} -> AuctionView {auctionId, offerId, status, ticks, acceptances, outcome, winnerRule}
 *
 * The internal store views (offerView/boardView, raw auction objects) keep
 * their existing shapes — these adapters are a pure projection layer on top.
 *
 * Type conformance notes (openapi.yaml is the authority):
 * - CrossChainOffer.expiry is `type: string` (unix timestamp as a string);
 *   the store keeps it as an integer, so the adapter stringifies it.
 * - OfferAdvisory.status follows the enum exactly: open | filling | filled |
 *   expired | cancelled. The relay has no cancel path, so 'cancelled' is
 *   never emitted — status derivation is documented below.
 * - OfferBadges.validationStatus is {give, want} of LegValidationStatus.
 *   The relay holds NO token registry (spec §6.1), so both legs report
 *   'unregistered' — "asset not in the registry" — which is the honest value
 *   until a registry is wired in. The UI must not quote 1:1 against these.
 * - FillPhase: committed | makerLocked | takerLocked | claimed | refunded.
 *   The relay never observes a refund path, so 'refunded' is never emitted.
 * - AuctionView.status maps the internal 'decided' -> 'settled' (outcome
 *   published). Ticks carry the internal prevTickHash value ('GENESIS' for
 *   tick 0), which the tick-chain verification consumes.
 */

const AUCTION_WINNER_RULE = 'sort (tick ASC, sha256(fillerAddr) ASC)';

/** ISO-8601 timestamp for updatedAt fields. */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Relay-computed advisory offer status (OfferStatus enum):
 *   filled  = filledAmount == giveAmount
 *   expired = past expiry with remaining > 0
 *   filling = active reservations or in-flight (unfilled) fills exist
 *   open    = remaining > 0, nothing reserved or in flight
 * 'cancelled' is never emitted: the relay has no cancel path.
 */
function offerStatusFor(store, state, nowSec) {
  const offer = state.offer;
  if (state.cancelled) return 'cancelled';
  const giveAmount = BigInt(offer.giveAmount);
  if (state.filledAmount >= giveAmount) return 'filled';
  if (typeof offer.expiry === 'number' && nowSec > offer.expiry) return 'expired';
  const inFlight = [...state.fills.values()].some((f) => !f.filled);
  if (state.reservations.length > 0 || inFlight) return 'filling';
  return 'open';
}

/** OfferAdvisory for an offer state. */
function advisoryFor(store, state) {
  const reserved = store.reservedAmount(state);
  const offer = state.offer;
  const remaining = BigInt(offer.giveAmount) - state.filledAmount - reserved;
  return {
    filledAmount: state.filledAmount.toString(),
    reservedAmount: reserved.toString(),
    remainingAmount: remaining.toString(),
    status: offerStatusFor(store, state, Math.floor(Date.now() / 1000)),
    updatedAt: nowIso(),
  };
}

/**
 * OfferBadges for an offer. isMediated = arbiter set (venue UI MUST badge
 * arbiter-enabled offers, spec §5); hasFiatLeg = fiat leg present (fiat legs
 * never settle atomically, spec §3.3); validationStatus is 'unregistered' for
 * both legs because the relay holds no token registry (see module docstring).
 */
function badgesFor(offer) {
  return {
    isMediated: offer.arbiter != null,
    hasFiatLeg: offer.fiatLeg != null,
    validationStatus: { give: 'unregistered', want: 'unregistered' },
  };
}

/**
 * CrossChainOffer passthrough with OpenAPI type conformance:
 * expiry is serialized as a string (the contract's type).
 */
function offerShape(offer) {
  const out = { ...offer };
  if (typeof out.expiry === 'number') out.expiry = String(out.expiry);
  return out;
}

/** OfferWithAdvisory = signed offer + advisory + badges (+ signatureStatuses passthrough). */
function offerWithAdvisory(store, state) {
  return {
    ...offerShape(state.offer),
    advisory: advisoryFor(store, state),
    badges: badgesFor(state.offer),
    signatureStatuses:
      state.offer.signatureStatuses || { ed25519: 'absent', solana: 'absent', evm: 'absent', chia: 'absent' },
  };
}

/** Query filters for GET /v1/offers (all optional, exact match). */
function offerMatchesFilters(offer, q) {
  if (q.giveChain && offer.giveChain !== q.giveChain) return false;
  if (q.wantChain && offer.wantChain !== q.wantChain) return false;
  if (q.giveAsset && offer.giveAsset !== q.giveAsset) return false;
  if (q.wantAsset && offer.wantAsset !== q.wantAsset) return false;
  if (q.fillMode && offer.fillMode !== q.fillMode) return false;
  if (q.mediated === 'true' && offer.arbiter == null) return false;
  if (q.mediated === 'false' && offer.arbiter != null) return false;
  if (q.fiatOnly === 'true' && offer.fiatLeg == null) return false;
  return true;
}

/**
 * OfferList {offers, page, limit, total} with optional filters and pagination.
 * states: array of internal offer states; q: parsed query object.
 */
function offerList(store, states, q) {
  const filtered = states.filter((s) => {
    if (s.cancelled && q.includeCancelled !== 'true') return false;
    return offerMatchesFilters(s.offer, q);
  });
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const total = filtered.length;
  const start = (page - 1) * limit;
  const offers = filtered.slice(start, start + limit).map((s) => offerWithAdvisory(store, s));
  return { offers, page, limit, total };
}

/** FillPhase for a fill record. */
function fillPhase(fill) {
  if (fill.filled) return 'claimed';
  if (fill.takerLocked) return 'takerLocked';
  if (fill.makerLocked) return 'makerLocked';
  return 'committed';
}

/** LockProof view: {txid, blockHeight} | null from a mirrored proof. */
function lockProofView(proof) {
  if (!proof) return null;
  const blockHeight =
    proof.verification && proof.verification.evidence
      ? proof.verification.evidence.blockHeight ?? null
      : null;
  return { txid: proof.txid, blockHeight };
}

/**
 * FillView for a fill record. counterpartyAddr is null: the relay's
 * commitment records carry chain names, not taker addresses — honest null
 * rather than a fabricated address. reservedUntil comes from the maker's
 * ack reservation when the fill is still reserved.
 */
function fillView(offer, fillId, fill, state) {
  const reservation = state.reservations.find((r) => r.fillNonce === fill.fillNonce);
  const makerProof = fill.proofs && fill.proofs.maker;
  return {
    fillId,
    offerId: offer.offerId,
    f: fill.f.toString(),
    hashlock: makerProof && makerProof.h ? makerProof.h : null,
    makerTimelockSec: offer.makerTimelockSec,
    takerTimelockSec: offer.takerTimelockSec,
    phase: fillPhase(fill),
    counterpartyAddr: null,
    reservedUntil: reservation ? reservation.reservedUntil : null,
    lockProofs: {
      makerLock: lockProofView(makerProof),
      takerLock: lockProofView(fill.proofs && fill.proofs.taker),
    },
  };
}

/** OfferDetail {offer, fills} for an offer state. */
function offerDetail(store, state) {
  const fills = [...state.fills.entries()].map(([fillId, fill]) =>
    fillView(state.offer, fillId, fill, state)
  );
  return { offer: offerWithAdvisory(store, state), fills };
}

/** AuctionTick passthrough: keeps the required fields plus ts/tickHash. */
function tickView(t) {
  return {
    auctionId: t.auctionId,
    tick: t.tick,
    price: t.price,
    prevTickHash: t.prevTickHash,
    relaySig: t.relaySig,
    ts: t.ts,
    tickHash: t.tickHash,
  };
}

/** Acceptance passthrough: required fields plus internal tracking extras. */
function acceptanceView(a) {
  return {
    auctionId: a.auctionId,
    tick: a.tick,
    price: a.price,
    f: a.f,
    fillerAddr: a.fillerAddr,
    sig: a.sig,
    sigStatus: a.sigStatus,
    receivedAt: a.receivedAt,
    valid: a.valid,
  };
}

/** AuctionOutcome projection: exactly the contract's required fields. */
function outcomeView(o) {
  if (!o) return null;
  return {
    winner: o.winner,
    winningTick: o.winningTick,
    f: o.f,
    exclusiveWindow: o.exclusiveWindow,
    relaySig: o.relaySig,
  };
}

/** AuctionView for an internal auction record. */
function auctionView(auction) {
  const statusMap = { open: 'open', decided: 'settled' };
  return {
    auctionId: auction.auctionId,
    offerId: auction.offerId,
    status: statusMap[auction.status] || auction.status,
    ticks: auction.ticks.map(tickView),
    acceptances: auction.acceptances.map(acceptanceView),
    outcome: outcomeView(auction.outcome),
    winnerRule: AUCTION_WINNER_RULE,
  };
}

module.exports = {
  AUCTION_WINNER_RULE,
  offerStatusFor,
  advisoryFor,
  badgesFor,
  offerWithAdvisory,
  offerList,
  fillView,
  offerDetail,
  auctionView,
  outcomeView,
};

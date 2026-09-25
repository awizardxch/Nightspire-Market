'use strict';

/**
 * src/store.js — offer book, fill commitments, and the ADVISORY reservation
 * mirror (spec §7).
 *
 * READ THE LABEL: the reservation LEDGER lives in the MAKER's worker; the
 * maker's signed commitment-ack is authoritative. The relay only mirrors
 * reservations as advisory so takers see liveness. This module demonstrates
 * the §7 atomicity pattern on the advisory side anyway: all reservation
 * mutations for one offer run through a per-offer serial queue (promise-chain
 * mutex), so check-and-reserve is atomic within this process — two racing
 * acks for the same offer cannot both slip past the remaining check.
 *
 * Advisory accounting (all unsigned, relay-computed — spec §4):
 *   remaining = total − filled − Σ active reservations
 * Reservations with reservedUntil <= now are expired back to the pool on
 * every mutation and on boot (bounded stranding, spec §7).
 */
const crypto = require('node:crypto');

const CHAINS = [
  'robinhood',
  'robinhood-testnet',
  'base',
  'base-sepolia',
  'ethereum',
  'ethereum-sepolia',
  'solana',
  'solana-devnet',
  'chia',
  'chia-testnet11',
];
const FILL_MODES = ['direct', 'solver', 'any'];
const AMOUNT_RE = /^\d+$/;

function fillIdFor(offerId, fillNonce) {
  // Spec §5: fillId = sha256(offerId||fillNonce). Byte concatenation of two
  // free-form strings is ambiguous, so we fix it: UTF-8 of "offerId||fillNonce"
  // with a literal "||" separator, documented so contracts/workers match it.
  return crypto.createHash('sha256').update(`${offerId}||${fillNonce}`, 'utf8').digest('hex');
}

function isFutureTs(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > Date.now() / 1000;
}

/** Fresh per-fill lock-proof slots. Each side: {chain, txid, h, mirroredAt, chainVerified, verification}. */
function newProofs() {
  return { maker: null, taker: null };
}

/** Advisory fill summary served to clients (no BigInts — JSON safe). */
function fillSummary(fillId, fill) {
  return {
    fillId,
    makerLocked: fill.makerLocked,
    takerLocked: fill.takerLocked,
    filled: fill.filled,
    chainVerified: !!(fill.proofs.maker && fill.proofs.maker.chainVerified && fill.proofs.taker && fill.proofs.taker.chainVerified),
    verification: {
      maker: fill.proofs.maker ? fill.proofs.maker.verification : { status: 'unconfirmed' },
      taker: fill.proofs.taker ? fill.proofs.taker.verification : { status: 'unconfirmed' },
    },
  };
}

/** Structural validation of a CrossChainOffer (§4). Signatures are shape-checked only. */
function validateOffer(o) {
  const errors = [];
  const req = (k, pred, why) => {
    if (!(k in o)) errors.push(`missing required field: ${k}`);
    else if (!pred(o[k])) errors.push(`invalid ${k}: ${why}`);
  };
  req('version', (v) => v === 1, 'must be 1');
  req('fillMode', (v) => FILL_MODES.includes(v), `must be one of ${FILL_MODES.join('|')}`);
  req('giveChain', (v) => CHAINS.includes(v), `must be one of ${CHAINS.join('|')}`);
  req('wantChain', (v) => CHAINS.includes(v), `must be one of ${CHAINS.join('|')}`);
  req('giveAsset', (v) => typeof v === 'string' && v.length > 0, 'non-empty string');
  req('wantAsset', (v) => typeof v === 'string' && v.length > 0, 'non-empty string');
  req('giveAmount', (v) => typeof v === 'string' && AMOUNT_RE.test(v) && BigInt(v) > 0n, 'base-unit integer string > 0');
  req('wantAmount', (v) => typeof v === 'string' && AMOUNT_RE.test(v) && BigInt(v) > 0n, 'base-unit integer string > 0');
  req('minFillAmount', (v) => typeof v === 'string' && AMOUNT_RE.test(v) && BigInt(v) > 0n, 'base-unit integer string > 0');
  req('makerAddr', (v) => typeof v === 'string' && v.length > 0, 'non-empty string');
  req('makerRecvAddr', (v) => typeof v === 'string' && v.length > 0, 'non-empty string');
  req('makerTimelockSec', (v) => Number.isInteger(v) && v > 0, 'positive integer seconds (T1)');
  req('takerTimelockSec', (v) => Number.isInteger(v) && v > 0, 'positive integer seconds (T2)');
  req('commitWindowSec', (v) => Number.isInteger(v) && v > 0, 'positive integer seconds (W)');
  req('expiry', isFutureTs, 'unix seconds in the future');
  req('nonce', (v) => typeof v === 'string' && v.length > 0, 'non-empty string');
  if ('takerAddr' in o && o.takerAddr !== null && typeof o.takerAddr !== 'string')
    errors.push('takerAddr must be a string or null');
  if ('arbiter' in o && o.arbiter !== null && typeof o.arbiter !== 'string')
    errors.push('arbiter must be a string or null');
  if ('fiatLeg' in o && o.fiatLeg !== null && (typeof o.fiatLeg !== 'object' || !o.fiatLeg.currency))
    errors.push('fiatLeg must be null or {currency, rails, providerId}');
  if ('signatures' in o && o.signatures !== null && typeof o.signatures !== 'object')
    errors.push('signatures must be an object (shape-checked only — UNVERIFIED)');
  if (BigInt(o.minFillAmount || '0') > BigInt(o.giveAmount || '0'))
    errors.push('minFillAmount cannot exceed giveAmount');
  if (o.makerTimelockSec <= o.takerTimelockSec)
    errors.push('iron rule: makerTimelockSec (T1, locked first) must exceed takerTimelockSec (T2)');
  return errors;
}

function badgesFor(offer) {
  return {
    mediated: offer.arbiter != null, // venue UI MUST badge arbiter-enabled offers (spec §5)
    fiatLeg: offer.fiatLeg != null, // fiat legs never settle atomically (spec §3.3)
    kycGated: offer.takerCredential != null,
    directed: offer.takerAddr != null,
  };
}

class OfferStore {
  constructor() {
    this.offers = new Map(); // offerId -> { offer, filledAmount:BigInt, reservations:[], fills:Map(fillId->...), commitments:[] }
    this.queues = new Map(); // offerId -> promise chain (serial mutex)
  }

  /** Per-offer serial queue: fn runs only after all prior fns for this offer settled. */
  forOffer(offerId, fn) {
    const prev = this.queues.get(offerId) || Promise.resolve();
    const next = prev.then(fn, fn); // run even if the previous step rejected
    this.queues.set(offerId, next.catch(() => {}));
    return next;
  }

  has(offerId) {
    return this.offers.has(offerId);
  }

  addOffer(offer) {
    const state = {
      offer,
      filledAmount: 0n,
      reservations: [], // { fillNonce, f:BigInt, reservedUntil (unix sec), mirroredAt }
      fills: new Map(), // fillId -> { fillNonce, f:BigInt, makerLocked, takerLocked, filled, proofs:{maker,taker} }
      commitments: [],
    };
    this.offers.set(offer.offerId, state);
    return state;
  }

  getState(offerId) {
    return this.offers.get(offerId) || null;
  }
  /** Maker cancellation: marks the offer cancelled (advisory). Serialized per offer. */
  cancelOffer(offerId, cancelledAt) {
    return this.forOffer(offerId, () => {
      const state = this.offers.get(offerId);
      if (!state) return { ok: false, code: 404, error: 'offer_not_found' };
      if (state.cancelled) return { ok: false, code: 409, error: 'already_cancelled' };
      state.cancelled = true;
      state.cancelledAt = cancelledAt;
      return { ok: true };
    });
  }

  sweepExpired(state) {
    const nowSec = Math.floor(Date.now() / 1000);
    const before = state.reservations.length;
    state.reservations = state.reservations.filter((r) => r.reservedUntil > nowSec);
    return before - state.reservations.length;
  }

  reservedAmount(state) {
    this.sweepExpired(state);
    return state.reservations.reduce((a, r) => a + r.f, 0n);
  }

  remainingAmount(state) {
    return BigInt(state.offer.giveAmount) - state.filledAmount - this.reservedAmount(state);
  }

  /**
   * Advisory mirror of the maker's signed commitment-ack {fillNonce, f, reservedUntil}.
   * Runs inside the per-offer serial queue: atomic check-and-reserve on the
   * advisory side (the maker's own ledger is authoritative — spec §7).
   */
  mirrorAck(offerId, ack) {
    return this.forOffer(offerId, () => {
      const state = this.getState(offerId);
      if (!state) return { ok: false, code: 404, error: 'offer not found' };
      const expired = this.sweepExpired(state);
      const f = BigInt(ack.f);
      const remaining = this.remainingAmount(state);
      if (f <= 0n) return { ok: false, code: 400, error: 'f must be > 0' };
      if (f > remaining)
        return { ok: false, code: 409, error: 'insufficient remaining (advisory)', remaining: remaining.toString() };
      if (state.reservations.some((r) => r.fillNonce === ack.fillNonce))
        return { ok: false, code: 409, error: 'fillNonce already reserved (advisory)' };
      state.reservations.push({
        fillNonce: ack.fillNonce,
        f,
        reservedUntil: ack.reservedUntil,
        makerSig: ack.makerSig || null,
        makerSigStatus: ack.makerSig ? 'UNVERIFIED' : 'absent',
        mirroredAt: Math.floor(Date.now() / 1000),
      });
      const fillId = fillIdFor(offerId, ack.fillNonce);
      if (!state.fills.has(fillId))
        state.fills.set(fillId, { fillNonce: ack.fillNonce, f, makerLocked: false, takerLocked: false, filled: false, proofs: newProofs() });
      return {
        ok: true,
        fillId,
        reservedAmount: this.reservedAmount(state).toString(),
        remainingAmount: this.remainingAmount(state).toString(),
        expiredSwept: expired,
      };
    });
  }

  /** Taker fill commitment (structural checks only, advisory remaining check). */
  recordCommitment(offerId, c) {
    return this.forOffer(offerId, () => {
      const state = this.getState(offerId);
      if (!state) return { ok: false, code: 404, error: 'offer not found' };
      const errors = [];
      if (!c || typeof c !== 'object') errors.push('body must be an object');
      else {
        if (typeof c.f !== 'string' || !AMOUNT_RE.test(c.f)) errors.push('f: base-unit integer string required');
        if (typeof c.fillNonce !== 'string' || !c.fillNonce) errors.push('fillNonce: non-empty string required');
        if (!c.takerAddrs || typeof c.takerAddrs.giveChain !== 'string' || typeof c.takerAddrs.wantChain !== 'string')
          errors.push('takerAddrs: {giveChain, wantChain} strings required');
      }
      if (errors.length) return { ok: false, code: 400, error: 'invalid commitment', details: errors };
      const f = BigInt(c.f);
      const min = BigInt(state.offer.minFillAmount);
      const remaining = this.remainingAmount(state);
      if (f < min || f > remaining)
        return {
          ok: false,
          code: 409,
          error: `f out of range: minFillAmount=${min} remaining=${remaining} (advisory — maker's signed ack is authoritative)`,
        };
      const fillId = fillIdFor(offerId, c.fillNonce);
      state.commitments.push({
        fillId,
        fillNonce: c.fillNonce,
        f: f.toString(),
        takerAddrs: c.takerAddrs,
        takerSig: c.takerSig || null,
        takerSigStatus: 'UNVERIFIED',
        receivedAt: Math.floor(Date.now() / 1000),
      });
      if (!state.fills.has(fillId))
        state.fills.set(fillId, { fillNonce: c.fillNonce, f, makerLocked: false, takerLocked: false, filled: false, proofs: newProofs() });
      return { ok: true, fillId, f: f.toString() };
    });
  }

  /**
   * Advisory mirror of a lock proof {fillId, chain, txid, h, side}.
   * Spec §12 rule zero: chain state is truth, relay data is a hint. A mirrored
   * proof starts UNCONFIRMED (chainVerified=false); a chain watcher promotes it
   * via confirmLockProof() once it re-verifies the lock from its own trusted
   * RPC — carrying txid + block height + hash per the §12 evidence rule.
   * When both legs are mirrored for a fill, the fill counts toward advisory
   * filledAmount.
   */
  mirrorLockProof(p) {
    const errors = [];
    if (!p || typeof p !== 'object') errors.push('body must be an object');
    else {
      if (typeof p.fillId !== 'string' || !p.fillId) errors.push('fillId required');
      if (!CHAINS.includes(p.chain)) errors.push(`chain must be one of ${CHAINS.join('|')}`);
      if (typeof p.txid !== 'string' || !p.txid) errors.push('txid required');
      if (typeof p.h !== 'string' || !p.h) errors.push('h (sha256 of secret) required');
      if (!['maker', 'taker'].includes(p.side)) errors.push('side must be maker|taker');
    }
    if (errors.length) return Promise.resolve({ ok: false, code: 400, error: 'invalid lock proof', details: errors });
    // Find the fill across offers (fillIds are globally unique).
    for (const [offerId, state] of this.offers) {
      const fill = state.fills.get(p.fillId);
      if (!fill) continue;
      return this.forOffer(offerId, () => {
        if (p.side === 'maker') fill.makerLocked = true;
        if (p.side === 'taker') fill.takerLocked = true;
        fill.proofs[p.side] = {
          chain: p.chain,
          txid: p.txid,
          h: p.h,
          mirroredAt: Math.floor(Date.now() / 1000),
          chainVerified: false,
          verification: { status: 'unconfirmed', confirmedAt: null, evidence: null },
        };
        if (!fill.filled && fill.makerLocked && fill.takerLocked) {
          fill.filled = true;
          state.filledAmount += fill.f;
          // A filled reservation no longer counts as reserved.
          state.reservations = state.reservations.filter((r) => r.fillNonce !== fill.fillNonce);
        }
        return {
          ok: true,
          chainVerified: false,
          note: 'lock proof mirrored but NOT chain-verified yet — a watcher confirmation (POST /v1/lock-proofs/confirm) promotes it once re-verified from a trusted RPC (spec §12)',
          fill: fillSummary(p.fillId, fill),
          filledAmount: state.filledAmount.toString(),
          remainingAmount: this.remainingAmount(state).toString(),
        };
      });
    }
    // Unknown fillId: still log it (advisory), but it affects nothing.
    return Promise.resolve({
      ok: true,
      chainVerified: false,
      note: 'lock proof mirrored but NOT chain-verified; fillId unknown to this relay — advisory only',
    });
  }

  /**
   * Watcher confirmation of a mirrored lock proof. In production the watcher
   * re-verifies the lock from its OWN trusted RPC (spec §12 assumptions) and
   * only then confirms; this endpoint is the local plumbing for that signal.
   * Evidence (chain, txid, blockHeight, h) is cross-checked against the
   * mirrored proof — a mismatch is rejected. Idempotent: re-confirming an
   * already-confirmed proof is a no-op success.
   */
  confirmLockProof(c) {
    const errors = [];
    if (!c || typeof c !== 'object') errors.push('body must be an object');
    else {
      if (typeof c.fillId !== 'string' || !c.fillId) errors.push('fillId required');
      if (!['maker', 'taker'].includes(c.side)) errors.push('side must be maker|taker');
      if (!CHAINS.includes(c.chain)) errors.push(`chain must be one of ${CHAINS.join('|')}`);
      if (typeof c.txid !== 'string' || !c.txid) errors.push('txid required');
      if (!Number.isInteger(c.blockHeight) || c.blockHeight < 0) errors.push('blockHeight: non-negative integer required');
      if (typeof c.h !== 'string' || !/^[0-9a-fA-F]{64}$/.test(c.h)) errors.push('h: 64-hex-char sha256 required');
      if (typeof c.watcherId !== 'string' || !c.watcherId) errors.push('watcherId required');
    }
    if (errors.length) return Promise.resolve({ ok: false, code: 400, error: 'invalid confirmation', details: errors });
    for (const [offerId, state] of this.offers) {
      const fill = state.fills.get(c.fillId);
      if (!fill) continue;
      return this.forOffer(offerId, () => {
        const proof = fill.proofs[c.side];
        if (!proof)
          return { ok: false, code: 409, error: `no mirrored lock proof for side ${c.side} — mirror it first` };
        if (proof.chain !== c.chain)
          return { ok: false, code: 409, error: `chain mismatch: mirrored ${proof.chain}, confirmation says ${c.chain}` };
        if (proof.h.toLowerCase() !== c.h.toLowerCase())
          return { ok: false, code: 409, error: 'h mismatch: confirmation does not match the mirrored proof' };
        if (proof.txid.toLowerCase() !== c.txid.toLowerCase())
          return { ok: false, code: 409, error: 'txid mismatch: confirmation must reference the mirrored txid' };
        if (!proof.chainVerified) {
          proof.chainVerified = true;
          proof.verification = {
            status: 'confirmed',
            confirmedAt: Math.floor(Date.now() / 1000),
            evidence: { chain: c.chain, txid: c.txid, blockHeight: c.blockHeight, h: c.h, watcherId: c.watcherId },
          };
        }
        return {
          ok: true,
          fill: fillSummary(c.fillId, fill),
          note: 'watcher-confirmed (advisory — agents re-verify from their own trusted RPCs, spec §12)',
        };
      });
    }
    return Promise.resolve({ ok: false, code: 404, error: 'fillId unknown to this relay' });
  }

  boardView() {
    return [...this.offers.values()].map((s) => this.offerView(s));
  }

  /** Raw offer states for the OpenAPI view adapters (src/venue_views.js). */
  allStates() {
    return [...this.offers.values()];
  }

  offerView(state) {
    const reserved = this.reservedAmount(state);
    const remaining = BigInt(state.offer.giveAmount) - state.filledAmount - reserved;
    return {
      ...state.offer,
      advisory: {
        filledAmount: state.filledAmount.toString(),
        reservedAmount: reserved.toString(),
        remainingAmount: remaining.toString(),
        activeReservations: state.reservations.length,
        fills: state.fills.size,
        chainVerified: false, // relay-computed, unsigned, advisory (spec §4)
      },
      badges: badgesFor(state.offer),
      signatureStatuses: state.offer.signatureStatuses || { ed25519: 'absent', solana: 'absent', evm: 'absent', chia: 'absent' },
    };
  }

  /** Rebuild state from the verified log (boot replay). */
  applyLogEvent(type, payload) {
    if (type === 'offer.posted') {
      if (!this.offers.has(payload.offer.offerId)) this.addOffer(payload.offer);
    } else if (type === 'commitment.received') {
      const state = this.getState(payload.offerId);
      // Dedup: recordCommitment() already recorded it live; record() replays
      // the event. fillId is unique per commitment (boot replay starts empty).
      if (state && !state.commitments.some((c) => c.fillId === payload.commitment.fillId)) {
        state.commitments.push(payload.commitment);
        if (!state.fills.has(payload.commitment.fillId))
          state.fills.set(payload.commitment.fillId, {
            fillNonce: payload.commitment.fillNonce,
            f: BigInt(payload.commitment.f),
            makerLocked: false,
            takerLocked: false,
            filled: false,
            proofs: newProofs(),
          });
      }
    } else if (type === 'ack.mirrored') {
      const state = this.getState(payload.offerId);
      if (state && !state.reservations.some((r) => r.fillNonce === payload.reservation.fillNonce)) {
        state.reservations.push({ ...payload.reservation, f: BigInt(payload.reservation.f) });
        const fillId = fillIdFor(payload.offerId, payload.reservation.fillNonce);
        if (!state.fills.has(fillId))
          state.fills.set(fillId, {
            fillNonce: payload.reservation.fillNonce,
            f: BigInt(payload.reservation.f),
            makerLocked: false,
            takerLocked: false,
            filled: false,
            proofs: newProofs(),
          });
      }
    } else if (type === 'lockproof.mirrored') {
      const { fillId, side, chain, txid, h } = payload.proof;
      for (const state of this.offers.values()) {
        const fill = state.fills.get(fillId);
        if (!fill) continue;
        if (side === 'maker') fill.makerLocked = true;
        if (side === 'taker') fill.takerLocked = true;
        if (side === 'maker' || side === 'taker') {
          fill.proofs[side] = {
            chain,
            txid,
            h,
            mirroredAt: Math.floor(Date.now() / 1000),
            chainVerified: false,
            verification: { status: 'unconfirmed', confirmedAt: null, evidence: null },
          };
        }
        if (!fill.filled && fill.makerLocked && fill.takerLocked) {
          fill.filled = true;
          state.filledAmount += fill.f;
          state.reservations = state.reservations.filter((r) => r.fillNonce !== fill.fillNonce);
        }
      }
    } else if (type === 'lockproof.confirmed') {
      const { fillId, side, confirmation } = payload;
      for (const state of this.offers.values()) {
        const fill = state.fills.get(fillId);
        if (!fill || !fill.proofs[side] || fill.proofs[side].chainVerified) continue;
        fill.proofs[side].chainVerified = true;
        fill.proofs[side].verification = {
          status: 'confirmed',
          confirmedAt: confirmation.confirmedAt,
          evidence: confirmation.evidence,
        };
      }
    }
    // auction.* events are handled by the auction module.
  }

  sweepAllExpired() {
    let swept = 0;
    for (const state of this.offers.values()) swept += this.sweepExpired(state);
    return swept;
  }

  snapshot() {
    const offers = [];
    for (const [offerId, s] of this.offers) {
      offers.push({
        offerId,
        offer: s.offer,
        filledAmount: s.filledAmount.toString(),
        reservations: s.reservations.map((r) => ({ ...r, f: r.f.toString() })),
        commitments: s.commitments,
        fills: [...s.fills.entries()].map(([fillId, f]) => ({ fillId, ...f, f: f.f.toString() })),
      });
    }
    return { offers };
  }

  restore(snap) {
    this.offers.clear();
    for (const o of snap.offers || []) {
      const state = {
        offer: o.offer,
        filledAmount: BigInt(o.filledAmount),
        reservations: (o.reservations || []).map((r) => ({ ...r, f: BigInt(r.f) })),
        commitments: o.commitments || [],
        fills: new Map(
          (o.fills || []).map((f) => [f.fillId, { ...f, f: BigInt(f.f), proofs: f.proofs || newProofs() }])
        ),
      };
      // delete the duplicated fillId key inside the value object
      for (const [, f] of state.fills) delete f.fillId;
      this.offers.set(o.offerId, state);
    }
  }
}

module.exports = { OfferStore, validateOffer, fillIdFor, badgesFor, CHAINS, FILL_MODES };

'use strict';

/**
 * src/auctions.js — verifiable Dutch auction with discrete signed ticks (spec §8).
 *
 * Tick chain: each tick is {auctionId, tick, price, prevTickHash, ts};
 * tickHash = sha256(canonicalJson(tick)) chains to the next tick's
 * prevTickHash, and every tick is ed25519-signed by the relay. The relay
 * cannot rewrite price history without breaking the chain. verifyTickChain()
 * recomputes every tickHash, checks prevTickHash linkage, and verifies every
 * relaySig — run on boot replay and served live on GET /v1/auctions/:id.
 *
 * Acceptance validity: tick exists in the chain AND price >= tick.price
 * (Dutch: first acceptance at-or-above the decayed price) AND the filler
 * signature VERIFIES. Per spec §8 "fillers submit SIGNED acceptances" and
 * §12 "posting requires valid signatures": unsigned or badly-signed
 * acceptances are REJECTED, never recorded.
 *
 * Acceptance signing contract (byte-for-byte, so fillers can reproduce):
 *   core = {auctionId, tick, price, f, fillerAddr}   // price as the submitted string
 *   sig  = ed25519( UTF-8( canonicalize(core) ) )    // canonical = sorted-key JSON, no whitespace
 * The acceptance carries `sig` (hex) and `fillerPubkey` (ed25519 SPKI DER hex);
 * the relay verifies with RelaySigner.verifyWith(core, sig, fillerPubkey).
 * The signature binds the payout address (fillerAddr) to the pubkey holder —
 * the §8 slashing evidence ("the winner's non-repudiable commitment").
 *
 * Price representation (venue-api/openapi.yaml BaseUnits): tick prices are
 * INTEGER strings — the ask rate in want-side base units per one give-side
 * base unit, scaled by 1e6 (decimal fixed-point). POST /v1/auctions takes
 * startPrice in the same representation; all decay math is integer math, so
 * the hash-chained tick records natively satisfy the venue contract's
 * ^\d+$ pattern and the chain stays verifiable from the served AuctionView.
 *
 * Deterministic winner rule (spec §8, recomputable by anyone):
 *   sort valid acceptances by (tick ASC, sha256(fillerAddr) ASC); first wins.
 * "sha256(fillerAddr)": sha256 over the UTF-8 bytes of the fillerAddr hex
 * string, compared as hex digests ascending. Documented here so verifiers
 * match this implementation byte-for-byte.
 *
 * The relay publishes a SIGNED outcome record
 *   {auctionId, offerId, winner, winningTick, f, exclusiveWindow:{start,end}}
 * — the evidence base for slashing (§8) if the winner fails to lock.
 */
const crypto = require('node:crypto');
const { canonicalize } = require('./canonical');
const { RelaySigner } = require('./signer');

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Legacy tolerance: snapshots written before integer-scaled prices may carry
 * decimal startPrice/floorPrice strings (e.g. "0.0003"). Scale them to
 * BaseUnits so an old state.json can never crash priceAt() on boot.
 */
function toBaseUnits(v) {
  const s = String(v);
  if (/^\d+$/.test(s)) return BigInt(s);
  return BigInt(Math.round(Number(s) * 1e6));
}

function sortKey(a) {
  return [a.tick, sha256hex(a.fillerAddr)];
}

/**
 * The exact bytes a filler signs for an acceptance (see module docstring).
 * Exported so fillers/tests construct identical signing bytes.
 */
function acceptanceCore(auctionId, body) {
  return {
    auctionId,
    tick: body.tick,
    price: String(body.price),
    f: body.f,
    fillerAddr: body.fillerAddr,
  };
}

/** Fields of a tick covered by its relaySig (tick() signs rec incl. tickHash, excl. relaySig). */
function tickSignedFields(t) {
  return {
    auctionId: t.auctionId,
    tick: t.tick,
    price: t.price,
    prevTickHash: t.prevTickHash,
    ts: t.ts,
    tickHash: t.tickHash,
  };
}

function expectedTickHash(t) {
  return sha256hex(
    canonicalize({ auctionId: t.auctionId, tick: t.tick, price: t.price, prevTickHash: t.prevTickHash, ts: t.ts })
  );
}

const SIG_RE = /^[0-9a-fA-F]{128}$/; // ed25519 signature hex
const PUBKEY_RE = /^[0-9a-fA-F]+$/; // ed25519 SPKI DER hex (shape-checked; verifyWith enforces the rest)

class AuctionBook {
  constructor(signer) {
    this.signer = signer;
    this.auctions = new Map(); // auctionId -> auction
  }

  open(offerId, params) {
    const errors = [];
    // Venue contract BaseUnits: integer string, ask rate scaled by 1e6.
    if (typeof params.startPrice !== 'string' || !/^\d+$/.test(params.startPrice) || BigInt(params.startPrice) <= 0n)
      errors.push('startPrice: positive base-unit integer string (ask rate scaled by 1e6)');
    const windowSec = params.auctionWindowSec === undefined ? 300 : Number(params.auctionWindowSec);
    if (!Number.isInteger(windowSec) || windowSec <= 0) errors.push('auctionWindowSec: positive integer');
    const floorBps = params.auctionFloorBps === undefined ? 50 : Number(params.auctionFloorBps);
    if (!Number.isInteger(floorBps) || floorBps < 0 || floorBps > 10000)
      errors.push('auctionFloorBps: integer 0..10000');
    const lockWindowSec = params.lockWindowSec === undefined ? 120 : Number(params.lockWindowSec);
    if (!Number.isInteger(lockWindowSec) || lockWindowSec <= 0) errors.push('lockWindowSec: positive integer');
    if (errors.length) return { ok: false, code: 400, error: 'invalid auction params', details: errors };

    const auctionId = 'auc_' + crypto.randomBytes(8).toString('hex');
    const start = BigInt(params.startPrice);
    const floorPrice = (start * BigInt(10000 - floorBps)) / 10000n; // integer decay to the floor
    const auction = {
      auctionId,
      offerId,
      startPrice: params.startPrice,
      floorPrice: floorPrice.toString(),
      auctionWindowSec: windowSec,
      auctionFloorBps: floorBps,
      lockWindowSec,
      status: 'open',
      currentTick: 0,
      prevTickHash: 'GENESIS',
      ticks: [], // signed ticks, in order
      acceptances: [], // {auctionId, tick, price, f, fillerAddr, sig, sigStatus, receivedAt, valid}
      outcome: null, // signed outcome record once decided
      openedAt: Math.floor(Date.now() / 1000),
    };
    this.auctions.set(auctionId, auction);
    return { ok: true, auction };
  }

  priceAt(auction, tick) {
    // Linear integer decay from startPrice to floorPrice over auctionWindowSec
    // ticks, in BaseUnits (scaled by 1e6). Returns a BigInt.
    const n = BigInt(Math.min(tick, auction.auctionWindowSec));
    const start = toBaseUnits(auction.startPrice);
    const floor = toBaseUnits(auction.floorPrice);
    const window = BigInt(auction.auctionWindowSec);
    return start - ((start - floor) * n) / window;
  }

  tick(auctionId) {
    const a = this.auctions.get(auctionId);
    if (!a) return { ok: false, code: 404, error: 'auction not found' };
    if (a.status !== 'open') return { ok: false, code: 409, error: `auction is ${a.status}` };
    const n = a.currentTick + 1;
    const rec = {
      auctionId,
      tick: n,
      price: this.priceAt(a, n).toString(), // BaseUnits integer string (scaled by 1e6)
      prevTickHash: a.prevTickHash,
      ts: Math.floor(Date.now() / 1000),
    };
    rec.tickHash = sha256hex(canonicalize(rec));
    rec.relaySig = this.signer.sign(rec);
    a.ticks.push(rec);
    a.currentTick = n;
    a.prevTickHash = rec.tickHash;
    return { ok: true, tick: rec };
  }

  accept(auctionId, body) {
    const a = this.auctions.get(auctionId);
    if (!a) return { ok: false, code: 404, error: 'auction not found' };
    const errors = [];
    if (!body || typeof body !== 'object') errors.push('body must be an object');
    else {
      if (!Number.isInteger(body.tick) || body.tick <= 0) errors.push('tick: positive integer');
      // Venue contract BaseUnits: acceptances quote the published tick price,
      // an integer string (ask rate scaled by 1e6) — same representation as the tick.
      if (typeof body.price !== 'string' || !/^\d+$/.test(body.price) || BigInt(body.price) <= 0n)
        errors.push('price: positive base-unit integer string (ask rate scaled by 1e6, as published on the tick)');
      if (typeof body.f !== 'string' || !/^\d+$/.test(body.f)) errors.push('f: base-unit integer string');
      if (typeof body.fillerAddr !== 'string' || !body.fillerAddr) errors.push('fillerAddr: non-empty string');
      // Spec §8 + §12: acceptances are SIGNED — posting requires a valid signature.
      if (typeof body.sig !== 'string' || !SIG_RE.test(body.sig))
        errors.push('sig: 128-hex-char ed25519 signature over canonical {auctionId,tick,price,f,fillerAddr} required');
      if (typeof body.fillerPubkey !== 'string' || !PUBKEY_RE.test(body.fillerPubkey))
        errors.push('fillerPubkey: ed25519 SPKI DER hex required');
    }
    if (errors.length) return { ok: false, code: 400, error: 'invalid acceptance', details: errors };
    const tickRec = a.ticks.find((t) => t.tick === body.tick);
    if (!tickRec) return { ok: false, code: 409, error: `tick ${body.tick} not published in this auction` };
    if (Number(body.price) < Number(tickRec.price))
      return {
        ok: false,
        code: 409,
        error: `price ${body.price} below tick ${body.tick} price ${tickRec.price} (Dutch rule)`,
      };
    const core = acceptanceCore(auctionId, body);
    let sigOk = false;
    try {
      sigOk = RelaySigner.verifyWith(core, body.sig, body.fillerPubkey);
    } catch {
      sigOk = false;
    }
    if (!sigOk)
      return {
        ok: false,
        code: 400,
        error: 'invalid acceptance signature',
        details: ['ed25519 signature over canonical {auctionId,tick,price,f,fillerAddr} did not verify against fillerPubkey'],
      };
    const acceptance = {
      auctionId,
      tick: body.tick,
      price: String(body.price),
      f: body.f,
      fillerAddr: body.fillerAddr,
      sig: body.sig,
      fillerPubkey: body.fillerPubkey,
      sigAlg: 'ed25519',
      sigStatus: 'VERIFIED',
      receivedAt: Math.floor(Date.now() / 1000),
      valid: true,
    };
    a.acceptances.push(acceptance);
    return { ok: true, acceptance };
  }

  /** Deterministic winner rule — recomputable by anyone from tick chain + acceptance set. */
  computeWinner(a) {
    const valid = a.acceptances.filter((x) => x.valid);
    if (!valid.length) return null;
    const sorted = [...valid].sort((x, y) => {
      const [tx, hx] = sortKey(x);
      const [ty, hy] = sortKey(y);
      if (tx !== ty) return tx - ty;
      return hx < hy ? -1 : hx > hy ? 1 : 0;
    });
    return { winner: sorted[0], sorted };
  }

  outcome(auctionId) {
    const a = this.auctions.get(auctionId);
    if (!a) return { ok: false, code: 404, error: 'auction not found' };
    if (a.outcome) return { ok: true, outcome: a.outcome, recomputed: false };
    const w = this.computeWinner(a);
    if (!w) return { ok: false, code: 409, error: 'no valid acceptances yet' };
    const start = Math.floor(Date.now() / 1000);
    const record = {
      auctionId,
      offerId: a.offerId,
      winner: w.winner.fillerAddr,
      winningTick: w.winner.tick,
      winningPrice: w.winner.price,
      f: w.winner.f,
      exclusiveWindow: { start, end: start + a.lockWindowSec },
      acceptancesConsidered: a.acceptances.filter((x) => x.valid).length,
      decidedAt: start,
    };
    record.relaySig = this.signer.sign(record);
    a.outcome = record;
    a.status = 'decided';
    return { ok: true, outcome: record, recomputed: true };
  }

  get(auctionId) {
    return this.auctions.get(auctionId) || null;
  }

  /**
   * Verify the full tick chain of an auction: every tickHash recomputed,
   * prevTickHash linkage from GENESIS, every relaySig valid. Returns
   * { ok:true, ticks, tipHash } or { ok:false, error, atTick }.
   * Used on boot replay (fail-closed per tick) and served live on
   * GET /v1/auctions/:id so anyone can confirm the price history.
   */
  verifyTickChain(auctionId) {
    const a = typeof auctionId === 'string' ? this.auctions.get(auctionId) : auctionId;
    if (!a) return { ok: false, error: 'auction not found' };
    let prev = 'GENESIS';
    for (const t of a.ticks) {
      if (t.auctionId !== a.auctionId)
        return { ok: false, error: `tick ${t.tick}: auctionId mismatch`, atTick: t.tick };
      if (t.tickHash !== expectedTickHash(t))
        return { ok: false, error: `tick ${t.tick}: tickHash mismatch — history tampered`, atTick: t.tick };
      if (t.prevTickHash !== prev)
        return { ok: false, error: `tick ${t.tick}: prevTickHash linkage broken`, atTick: t.tick };
      let sigOk = false;
      try {
        sigOk = this.signer.verify(tickSignedFields(t), t.relaySig);
      } catch {
        sigOk = false;
      }
      if (!sigOk) return { ok: false, error: `tick ${t.tick}: relaySig invalid`, atTick: t.tick };
      prev = t.tickHash;
    }
    return { ok: true, ticks: a.ticks.length, tipHash: prev };
  }

  /** Rebuild state from the verified log (boot replay). Ticks are re-verified; corrupt ticks are dropped fail-closed. */
  applyLogEvent(type, payload) {
    if (type === 'auction.opened') {
      if (!this.auctions.has(payload.auction.auctionId)) this.auctions.set(payload.auction.auctionId, payload.auction);
    } else if (type === 'auction.tick') {
      const t = payload.tick;
      const a = this.auctions.get(t.auctionId);
      if (a && !a.ticks.some((x) => x.tick === t.tick)) {
        const hashOk = t.tickHash === expectedTickHash(t) && t.prevTickHash === a.prevTickHash;
        let sigOk = false;
        try {
          sigOk = this.signer.verify(tickSignedFields(t), t.relaySig);
        } catch {
          sigOk = false;
        }
        if (hashOk && sigOk) {
          a.ticks.push(t);
          a.currentTick = t.tick;
          a.prevTickHash = t.tickHash;
        } else {
          console.error(`[relay] boot replay: dropping corrupt tick ${t.tick} of ${t.auctionId} (hashOk=${hashOk} sigOk=${sigOk})`);
        }
      }
    } else if (type === 'auction.acceptance') {
      const a = this.auctions.get(payload.acceptance.auctionId);
      // Dedup: accept() already recorded it live; record() replays the event.
      // sig is unique per acceptance (boot replay starts from empty state).
      if (a && !a.acceptances.some((x) => x.sig === payload.acceptance.sig)) {
        a.acceptances.push(payload.acceptance);
      }
    } else if (type === 'auction.outcome') {
      const a = this.auctions.get(payload.outcome.auctionId);
      if (a) {
        a.outcome = payload.outcome;
        a.status = 'decided';
      }
    }
  }

  snapshot() {
    return { auctions: [...this.auctions.values()] };
  }

  restore(snap) {
    this.auctions.clear();
    for (const a of snap.auctions || []) this.auctions.set(a.auctionId, a);
  }
}

module.exports = { AuctionBook, sha256hex, acceptanceCore, tickSignedFields, expectedTickHash };

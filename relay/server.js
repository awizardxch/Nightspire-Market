'use strict';

/**
 * server.js — Nightspire cross-chain marketplace relay skeleton.
 *
 * What this is: an off-chain order book + auctioneer + advisory reservation
 * mirror (spec §12: relay is order book + watcher, NEVER custodian).
 * `node server.js` listens on PORT (default 8787).
 *
 * REAL in this skeleton:
 *   - ed25519 relay identity (src/signer.js) — every relay message signed
 *   - append-only hash-chained JSONL log with fsync-per-append (src/log.js),
 *     verified on boot (fail closed)
 *   - per-offer serial queue for advisory reservation mirroring — the §7
 *     atomic check-and-reserve pattern, advisory side
 *   - discrete signed Dutch-auction ticks + the deterministic §8 winner rule
 *     (recomputable by anyone); tick chains re-verified on boot replay and
 *     served live (hash recompute + prevTickHash linkage + relaySig)
 *   - VERIFIED filler acceptance signatures (ed25519 over canonical
 *     {auctionId,tick,price,f,fillerAddr}); unsigned/badly-signed bids rejected
 *   - offer signature verification: ed25519 + Solana-style (base58 makerAddr)
 *     verified in stdlib; EIP-712 verified via vendored @noble
 *     keccak256+secp256k1-recovery (Nightspire convention v1, src/eip712.js);
 *     Chia BLS honestly marked UNVERIFIED with reason (agents verify
 *     locally, spec §12)
 *   - signed Merkle checkpoints over the log (src/checkpoints.js)
 *   - lock-proof chainVerified plumbing: mirrored proofs start unconfirmed;
 *     watcher confirmations (txid+blockHeight+hash evidence) promote them
 *   - advisory filled/reserved/remaining accounting
 * STUBBED (honest markers in code + README):
 *   - Chia BLS offer signature verification → UNVERIFIED (BLS12-381 not
 *     vendored; the offer format carries no BLS pubkey — needs a spec change)
 *   - chain watcher (src/watcher.js) — interface only, throws; the
 *     /v1/lock-proofs/confirm endpoint is its local stand-in
 *   - public checkpoint ANCHORING (Nostr/on-chain) — checkpoints are produced
 *     and served; anchoring is an external publisher's job
 *   - preimage forwarding (src/preimage.js) — throws
 *
 * NO chain interaction anywhere: no RPC, no broadcasts, no chain keys.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { RelaySigner } = require('./src/signer');
const { RelayLog } = require('./src/log');
const { OfferStore, validateOffer } = require('./src/store');
const { AuctionBook } = require('./src/auctions');
const { verifyOfferSignatures, UNVERIFIED_REASONS } = require('./src/offer_sigs');
const { buildCheckpoint } = require('./src/checkpoints');

const PORT = Number(process.env.PORT || 8787);
// DATA_DIR override lets tests run against a scratch dir without touching live data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const SNAPSHOT_EVERY = 10; // appends between state.json snapshots

const signer = new RelaySigner(path.join(DATA_DIR, 'relay-key.json'));
const log = new RelayLog(DATA_DIR, signer);
const store = new OfferStore();
const auctions = new AuctionBook(signer);

// ---- boot: verify chain (fail closed), restore snapshot, replay tail ----
const bootReport = log.open();
let snapshotSeq = 0;
if (fs.existsSync(STATE_PATH)) {
  try {
    const snap = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    snapshotSeq = snap.logSeq || 0;
    store.restore(snap.store || {});
    auctions.restore(snap.auctions || {});
  } catch (e) {
    console.error(`[relay] WARNING: state.json unreadable (${e.message}) — replaying full log`);
    snapshotSeq = 0;
  }
}
for (const entry of bootReport.entries) {
  if (entry.seq <= snapshotSeq) continue;
  store.applyLogEvent(entry.type, entry.payload);
  auctions.applyLogEvent(entry.type, entry.payload);
}
// Rebuild the checkpoint index from anchored checkpoint events in the log.
const checkpoints = [];
for (const entry of bootReport.entries) {
  if (entry.type === 'checkpoint.anchored' && entry.payload && entry.payload.checkpoint) {
    checkpoints.push(entry.payload.checkpoint);
  }
}
const swept = store.sweepAllExpired();
console.error(
  `[relay] boot: log verified (${bootReport.count} entries, tip seq=${log.seq}), ` +
    `snapshot seq=${snapshotSeq}, expired reservations swept=${swept}, pubkey=${signer.publicKeyDerHex.slice(0, 32)}…`
);

function snapshotState() {
  const tmp = STATE_PATH + '.tmp';
  const body = JSON.stringify(
    { logSeq: log.seq, logTip: log.prevHash, savedAt: new Date().toISOString(), store: store.snapshot(), auctions: auctions.snapshot() },
    null,
    2
  );
  fs.writeFileSync(tmp, body);
  const fd = fs.openSync(tmp, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, STATE_PATH);
}

/** Append to the hash-chained log AND apply to in-memory state, then maybe snapshot. */
function record(type, payload) {
  const entry = log.append(type, payload);
  store.applyLogEvent(type, payload);
  auctions.applyLogEvent(type, payload);
  if (entry.seq % SNAPSHOT_EVERY === 0) snapshotState();
  return entry;
}

// ---- HTTP plumbing ----
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > 1024 * 1024) {
        reject(new Error('body too large (1MB cap)'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;
  try {
    // ---- health / identity ----
    if (method === 'GET' && p === '/v1/health')
      return send(res, 200, {
        ok: true,
        service: 'nightspire-crosschain-relay',
        version: '0.1.0-skeleton',
        relay: signer.identity(),
        logSeq: log.seq,
        offers: store.offers.size,
        auctions: auctions.auctions.size,
      });
    if (method === 'GET' && p === '/v1/relay-pubkey') return send(res, 200, signer.identity());

    // ---- offers ----
    if (method === 'POST' && p === '/v1/offers') {
      const body = await readBody(req);
      const errors = validateOffer(body);
      if (errors.length) return send(res, 400, { error: 'invalid offer', details: errors });
      const offerId = body.offerId || crypto.randomUUID();
      if (store.has(offerId)) return send(res, 409, { error: 'offerId already exists' });
      // Signature verification: ed25519 + Solana-style in stdlib, EIP-712 via
      // vendored noble (src/eip712.js); Chia BLS honestly UNVERIFIED
      // (agents verify locally, spec §12).
      const sigCheck = verifyOfferSignatures({ ...body, offerId });
      if (!sigCheck.ok)
        return send(res, 400, { error: 'invalid offer signature', details: sigCheck.statuses });
      const offer = { ...body, offerId, signatureStatuses: sigCheck.statuses };
      record('offer.posted', { offer, signatureStatuses: sigCheck.statuses });
      const unverified = Object.entries(sigCheck.statuses)
        .filter(([, v]) => v === 'UNVERIFIED')
        .map(([k]) => `${k}: ${sigCheck.reasons[k] || UNVERIFIED_REASONS[k] || ''}`);
      return send(res, 201, {
        offerId,
        signatureStatuses: sigCheck.statuses,
        note:
          unverified.length > 0
            ? `Offer accepted on structural checks + verified signatures (${Object.entries(sigCheck.statuses)
                .filter(([, v]) => v === 'VERIFIED')
                .map(([k]) => k)
                .join(', ') || 'none'}). Unverified schemes: ${unverified.join('; ')} — agents MUST verify these locally (spec §12). Do not treat relay acceptance as authenticity.`
            : 'All provided offer signatures verified.',
      });
    }
    if (method === 'GET' && p === '/v1/offers') {
      store.sweepAllExpired();
      return send(res, 200, { offers: store.boardView() });
    }
    let m = p.match(/^\/v1\/offers\/([^/]+)$/);
    if (method === 'GET' && m) {
      const state = store.getState(m[1]);
      if (!state) return send(res, 404, { error: 'offer not found' });
      return send(res, 200, store.offerView(state));
    }
    m = p.match(/^\/v1\/offers\/([^/]+)\/commitments$/);
    if (method === 'POST' && m) {
      const offerId = m[1];
      const body = await readBody(req);
      const result = await store.recordCommitment(offerId, body);
      if (!result.ok) return send(res, result.code, result);
      record('commitment.received', {
        offerId,
        commitment: {
          offerId,
          fillId: result.fillId,
          fillNonce: body.fillNonce,
          f: result.f,
          takerAddrs: body.takerAddrs,
          takerSig: body.takerSig || null,
          takerSigStatus: 'UNVERIFIED',
          receivedAt: Math.floor(Date.now() / 1000),
        },
      });
      return send(res, 201, {
        status: 'commitment mirrored (advisory)',
        offerId,
        fillId: result.fillId,
        takerSigStatus: 'UNVERIFIED',
        note: 'The maker’s signed commitment-ack is authoritative (spec §7); this is the relay’s advisory mirror.',
      });
    }
    m = p.match(/^\/v1\/offers\/([^/]+)\/acks$/);
    if (method === 'POST' && m) {
      const offerId = m[1];
      const body = await readBody(req);
      const errors = [];
      if (typeof body.fillNonce !== 'string' || !body.fillNonce) errors.push('fillNonce required');
      if (typeof body.f !== 'string' || !/^\d+$/.test(body.f)) errors.push('f: base-unit integer string required');
      if (!Number.isInteger(body.reservedUntil) || body.reservedUntil <= Math.floor(Date.now() / 1000))
        errors.push('reservedUntil: unix seconds in the future required');
      if (errors.length) return send(res, 400, { error: 'invalid commitment-ack mirror', details: errors });
      const result = await store.mirrorAck(offerId, body);
      if (!result.ok) return send(res, result.code, result);
      record('ack.mirrored', {
        offerId,
        reservation: {
          fillNonce: body.fillNonce,
          f: body.f,
          reservedUntil: body.reservedUntil,
          makerSig: body.makerSig || null,
          makerSigStatus: body.makerSig ? 'UNVERIFIED' : 'absent',
          mirroredAt: Math.floor(Date.now() / 1000),
        },
        advisory: true,
      });
      return send(res, 201, {
        status: 'reservation mirrored (advisory)',
        advisory: true,
        makerSigStatus: body.makerSig ? 'UNVERIFIED' : 'absent',
        fillId: result.fillId,
        reservedAmount: result.reservedAmount,
        remainingAmount: result.remainingAmount,
        expiredSwept: result.expiredSwept,
        note: 'Advisory only — the maker’s worker ledger is authoritative (spec §7).',
      });
    }

    // ---- lock proofs (advisory mirror; chainVerified starts false, promoted by watcher confirmations) ----
    if (method === 'POST' && p === '/v1/lock-proofs') {
      const body = await readBody(req);
      const result = await store.mirrorLockProof(body);
      if (!result.ok) return send(res, result.code, result);
      record('lockproof.mirrored', { proof: body, chainVerified: false });
      return send(res, 201, { status: 'lock proof mirrored (advisory)', ...result });
    }
    // Watcher confirmation: the local stand-in for the chain watcher
    // (src/watcher.js). Production watchers re-verify from their own trusted
    // RPCs (spec §12) and only then confirm with txid+blockHeight+hash evidence.
    if (method === 'POST' && p === '/v1/lock-proofs/confirm') {
      const body = await readBody(req);
      const result = await store.confirmLockProof(body);
      if (!result.ok) return send(res, result.code, result);
      record('lockproof.confirmed', {
        fillId: body.fillId,
        side: body.side,
        confirmation: {
          confirmedAt: Math.floor(Date.now() / 1000),
          evidence: {
            chain: body.chain,
            txid: body.txid,
            blockHeight: body.blockHeight,
            h: body.h,
            watcherId: body.watcherId,
          },
        },
      });
      return send(res, 200, { status: 'lock proof confirmed (advisory)', ...result });
    }

    // ---- auctions ----
    if (method === 'POST' && p === '/v1/auctions') {
      const body = await readBody(req);
      if (typeof body.offerId !== 'string' || !store.has(body.offerId))
        return send(res, 400, { error: 'offerId must reference a posted offer' });
      const offerState = store.getState(body.offerId);
      if (!['solver', 'any'].includes(offerState.offer.fillMode))
        return send(res, 400, { error: `offer fillMode is ${offerState.offer.fillMode}; auctions need solver|any` });
      const result = auctions.open(body.offerId, body);
      if (!result.ok) return send(res, result.code, result);
      record('auction.opened', { auction: result.auction });
      return send(res, 201, { auctionId: result.auction.auctionId, auction: result.auction });
    }
    m = p.match(/^\/v1\/auctions\/([^/]+)$/);
    if (method === 'GET' && m) {
      const a = auctions.get(m[1]);
      if (!a) return send(res, 404, { error: 'auction not found' });
      return send(res, 200, { auction: a, tickChain: auctions.verifyTickChain(a) });
    }
    m = p.match(/^\/v1\/auctions\/([^/]+)\/ticks$/);
    if (method === 'POST' && m) {
      const result = auctions.tick(m[1]);
      if (!result.ok) return send(res, result.code, result);
      record('auction.tick', { tick: result.tick });
      return send(res, 201, { tick: result.tick });
    }
    m = p.match(/^\/v1\/auctions\/([^/]+)\/acceptances$/);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      const result = auctions.accept(m[1], body);
      if (!result.ok) return send(res, result.code, result);
      record('auction.acceptance', { acceptance: result.acceptance });
      return send(res, 201, {
        status: 'acceptance recorded',
        acceptance: result.acceptance,
        note: 'Filler signature VERIFIED (ed25519 over canonical {auctionId,tick,price,f,fillerAddr}). Structural checks: tick exists, price >= tick.price (Dutch rule).',
      });
    }
    m = p.match(/^\/v1\/auctions\/([^/]+)\/outcome$/);
    if (method === 'GET' && m) {
      const result = auctions.outcome(m[1]);
      if (!result.ok) return send(res, result.code, result);
      if (result.recomputed) record('auction.outcome', { outcome: result.outcome });
      return send(res, 200, {
        outcome: result.outcome,
        winnerRule: 'sort valid acceptances by (tick ASC, sha256(fillerAddr) ASC); first wins (spec §8)',
        recomputed: result.recomputed,
      });
    }

    // ---- log & checkpoints ----
    if (method === 'GET' && p === '/v1/log') {
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
      return send(res, 200, log.page(offset, limit));
    }
    // Signed Merkle checkpoints (spec §12): commit to a contiguous log range.
    // Public ANCHORING (Nostr/on-chain) is an external publisher's job — the
    // signed checkpoint is produced and served here.
    if (method === 'GET' && p === '/v1/checkpoints') {
      return send(res, 200, { checkpoints, count: checkpoints.length });
    }
    if (method === 'POST' && p === '/v1/checkpoints') {
      const prev = checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
      const seqStart = prev ? prev.seqEnd + 1 : 1;
      const entries = log.entries.filter((e) => e.seq >= seqStart);
      if (!entries.length) return send(res, 409, { error: 'no new log entries since last checkpoint' });
      let checkpoint;
      try {
        checkpoint = buildCheckpoint({ entries, prevCheckpoint: prev, signer });
      } catch (e) {
        return send(res, 500, { error: `checkpoint build failed: ${e.message}` });
      }
      record('checkpoint.anchored', { checkpoint });
      checkpoints.push(checkpoint);
      return send(res, 201, { checkpoint });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e.message === 'invalid JSON body' || e.message.startsWith('body too large'))
      return send(res, 400, { error: e.message });
    console.error('[relay] request error:', e);
    return send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.error(`[relay] listening on :${PORT} — data dir ${DATA_DIR}`);
});

function shutdown(sig) {
  console.error(`[relay] ${sig} — snapshotting and closing log`);
  try {
    snapshotState();
  } catch (e) {
    console.error('[relay] snapshot failed:', e.message);
  }
  log.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { server };

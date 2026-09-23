/**
 * reservations.js — spec §7 reservation protocol for the maker worker.
 *
 * - Durable write-ahead ledger: every state change is appended to a JSONL log
 *   and fsync'd to disk BEFORE any signature is produced. Crash-safe: a crash
 *   between reservation and lock can only strand f until reservedUntil (bounded by W).
 * - Atomic check-and-reserve: commitments for one offer are processed SERIALY
 *   through a per-offer promise queue. The worker NEVER signs a commitment it
 *   has not reserved — conflicting signed commitments are impossible by
 *   construction, not by race luck.
 * - Restart recovery: ledger reloaded on start; reservations with
 *   reservedUntil < now expire back to the pool.
 * - Single-writer rule: exactly one active worker per maker identity holds the
 *   reservation lease (lease file + heartbeat). A second instance with the same
 *   maker id REFUSES to start. Multi-worker concurrency is out of scope for v1.
 *
 * remaining(offerId) = total - filled - Σ active reservations
 */
import { openSync, writeSync, fsyncSync, closeSync, existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class LeaseHeldError extends Error {
  constructor(makerId, holder) {
    super(`single-writer lease for maker "${makerId}" held by pid ${holder.pid} (heartbeat ${new Date(holder.heartbeat).toISOString()})`);
    this.code = 'ELEASE_HELD';
    this.holder = holder;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class ReservationLedger {
  /**
   * @param {object} o
   * @param {string} o.makerId            maker identity holding this ledger
   * @param {string} o.dataDir           root data dir (leases + per-maker logs live under it)
   * @param {number} [o.leaseTtlMs=5000] lease considered stale after this long without heartbeat
   * @param {number} [o.heartbeatMs=1000]
   * @param {function} [o.now]           clock, () => ms epoch (injectable for tests)
   * @param {object} [o.testHooks]       { beforeFsync?: async () => void } — test-only crash window
   */
  constructor({ makerId, dataDir, leaseTtlMs = 5000, heartbeatMs = 1000, now = () => Date.now(), testHooks = {} }) {
    this.makerId = makerId;
    this.dir = join(dataDir, makerId);
    this.leasePath = join(dataDir, 'leases', `${makerId}.json`);
    this.logPath = join(this.dir, 'reservations.jsonl');
    this.leaseTtlMs = leaseTtlMs;
    this.heartbeatMs = heartbeatMs;
    this.now = now;
    this.testHooks = testHooks;
    this._queues = new Map(); // offerId -> tail promise (serial per-offer queue)
    this._fd = null;
    this._heartbeat = null;
    this._lease = null;
    // in-memory index rebuilt from the log
    this.offers = new Map();        // offerId -> {offerId,total,minFillAmount,commitWindowSec}
    this.reservations = new Map();  // "offerId\\0fillNonce" -> {offerId,fillNonce,f,reservedUntil,commitmentSig}
    this.filled = new Map();        // offerId -> BigInt total filled
    this._filledNonces = new Set(); // fillNonce set (idempotency across restarts)
    this._seenNonces = new Set();   // "offerId\0fillNonce" — reserved nonces are single-use, anti-replay
  }

  // ---------- lifecycle ----------

  async start() {
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(dirname(this.leasePath), { recursive: true });
    this._acquireLease();
    this._fd = openSync(this.logPath, 'a');
    this._replay();
    await this.expireStale(); // recovery: stale reservations return to the pool
    return this;
  }

  async stop() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
    // drain per-offer queues so no atomic section is cut mid-write
    await Promise.all([...this._queues.values()]).catch(() => {});
    if (this._fd !== null) { try { closeSync(this._fd); } catch {} this._fd = null; }
    this._releaseLease();
  }

  // ---------- lease (single-writer rule) ----------

  _acquireLease() {
    if (existsSync(this.leasePath)) {
      let holder = null;
      try { holder = JSON.parse(readFileSync(this.leasePath, 'utf8')); } catch { /* corrupt -> treat as stale */ }
      if (holder && holder.pid !== process.pid) {
        const fresh = this.now() - holder.heartbeat < this.leaseTtlMs;
        if (fresh && pidAlive(holder.pid)) throw new LeaseHeldError(this.makerId, holder);
      }
    }
    this._lease = { makerId: this.makerId, pid: process.pid, startedAt: this.now(), heartbeat: this.now() };
    writeFileSync(this.leasePath, JSON.stringify(this._lease));
    this._heartbeat = setInterval(() => {
      try {
        this._lease.heartbeat = this.now();
        writeFileSync(this.leasePath, JSON.stringify(this._lease));
      } catch { /* heartbeat failure must not crash the worker */ }
    }, this.heartbeatMs);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  _releaseLease() {
    try {
      if (existsSync(this.leasePath)) {
        const holder = JSON.parse(readFileSync(this.leasePath, 'utf8'));
        if (holder.pid === process.pid) unlinkSync(this.leasePath);
      }
    } catch { /* best effort */ }
  }

  // ---------- write-ahead log ----------

  _append(entry) {
    const line = JSON.stringify({ ...entry, ts: this.now() }) + '\n';
    writeSync(this._fd, line);
    fsyncSync(this._fd); // durable BEFORE any signature leaves this process
  }

  _replay() {
    this.offers.clear(); this.reservations.clear(); this.filled.clear();
    this._filledNonces.clear(); this._seenNonces.clear();
    if (!existsSync(this.logPath)) return;
    const raw = readFileSync(this.logPath, 'utf8');
    let skipped = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { skipped++; continue; } // torn write from kill -9: skip
      this._apply(e);
    }
    if (skipped > 0) console.error(`[ledger] skipped ${skipped} torn log line(s) during replay`);
  }

  _apply(e) {
    switch (e.type) {
      case 'offer':
        this.offers.set(e.offerId, { offerId: e.offerId, total: e.total, minFillAmount: e.minFillAmount, commitWindowSec: e.commitWindowSec });
        break;
      case 'reservation':
        this._putReservation(e);
        break;
      case 'rejection':
        break; // advisory only
      case 'filled':
        if (!this._filledNonces.has(this._rkey(e.offerId, e.fillNonce))) {
          this._filledNonces.add(this._rkey(e.offerId, e.fillNonce));
          this._delReservation(e.offerId, e.fillNonce);
          this.filled.set(e.offerId, (this.filled.get(e.offerId) || 0n) + BigInt(e.f));
        }
        break;
      case 'released':
      case 'expired':
        this._delReservation(e.offerId, e.fillNonce);
        break;
      default:
        break;
    }
  }

  // ---------- accounting ----------

  /** remaining = total − filled − Σ active reservations (BigInt, base units). */
  remaining(offerId) {
    const offer = this.offers.get(offerId);
    if (!offer) throw new Error(`unknown offer ${offerId}`);
    let reserved = 0n;
    for (const r of this.reservations.values()) {
      if (r.offerId === offerId && r.reservedUntil > this.now()) reserved += BigInt(r.f);
    }
    return BigInt(offer.total) - (this.filled.get(offerId) || 0n) - reserved;
  }

  addOffer({ offerId, total, minFillAmount, commitWindowSec }) {
    if (this.offers.has(offerId)) return this.offers.get(offerId);
    const offer = { offerId, total: total.toString(), minFillAmount: minFillAmount.toString(), commitWindowSec };
    this._append({ type: 'offer', ...offer });
    this._apply({ type: 'offer', ...offer });
    return offer;
  }

  // ---------- atomic check-and-reserve ----------

  _enqueue(offerId, fn) {
    const tail = this._queues.get(offerId) || Promise.resolve();
    const next = tail.then(fn, fn);
    // keep the chain alive even if a handler throws
    this._queues.set(offerId, next.catch(() => {}));
    return next;
  }

  /**
   * Process one taker commitment atomically for its offer.
   * @param {object} commitment {offerId, f, fillNonce, takerAddrs, commitmentSig}
   * @param {object} o { signAck: async(payload)->sig, signRejection: async(payload)->sig, now?: ms }
   * @returns {ok:true, ack:{...}} | {ok:false, rejection:{...}}
   */
  async handleCommitment(commitment, { signAck, signRejection }) {
    const { offerId, f, fillNonce } = commitment;
    return this._enqueue(offerId, async () => {
      const offer = this.offers.get(offerId);
      const now = this.now();
      const reject = async (reason) => {
        const rejection = { offerId, fillNonce, f: f.toString(), reason, remaining: offer ? this.remaining(offerId).toString() : '0' };
        rejection.signature = await signRejection(rejection);
        this._append({ type: 'rejection', ...rejection });
        return { ok: false, rejection };
      };
      if (!offer) return reject('unknown-offer');
      if (this._seenNonces.has(offerId + '\0' + fillNonce)) return reject('duplicate-fillNonce');
      const amt = BigInt(f);
      if (amt < BigInt(offer.minFillAmount)) return reject('below-minFillAmount');
      if (amt > this.remaining(offerId)) return reject('insufficient-remaining');

      const reservedUntil = now + offer.commitWindowSec * 1000;
      const entry = {
        type: 'reservation', offerId, fillNonce, f: amt.toString(),
        commitmentSig: commitment.commitmentSig || null, reservedUntil,
      };
      if (this.testHooks.beforeFsync) await this.testHooks.beforeFsync(); // test-only crash window
      this._append(entry);
      this._apply(entry);

      const ack = { offerId, fillNonce, f: amt.toString(), reservedUntil };
      ack.signature = await signAck(ack); // signed ONLY after the reservation is durable
      return { ok: true, ack };
    });
  }

  /** Reservation converts to filled on counterparty lock verification (spec §3.1 step 3).
   *  Idempotent: a crash between claim and persist must not double-count. */
  markFilled({ offerId, fillNonce, f, fillId }) {
    if (this._filledNonces.has(this._rkey(offerId, fillNonce))) return false;
    const entry = { type: 'filled', offerId, fillNonce, f: f.toString(), fillId };
    this._append(entry);
    this._apply(entry);
    return true;
  }

  _rkey(offerId, fillNonce) { return offerId + '\0' + fillNonce; }
  _putReservation(e) {
    this.reservations.set(this._rkey(e.offerId, e.fillNonce),
      { offerId: e.offerId, fillNonce: e.fillNonce, f: e.f, reservedUntil: e.reservedUntil, commitmentSig: e.commitmentSig });
    this._seenNonces.add(this._rkey(e.offerId, e.fillNonce));
  }
  _delReservation(offerId, fillNonce) { return this.reservations.delete(this._rkey(offerId, fillNonce)); }

  /** Manual release (e.g. W expired with no taker lock). */
  release({ offerId, fillNonce, reason }) {
    if (!this.reservations.has(this._rkey(offerId, fillNonce))) return false;
    const entry = { type: 'released', offerId, fillNonce, reason };
    this._append(entry);
    this._apply(entry);
    return true;
  }

  /** Expire reservations past reservedUntil — returns them to the pool. */
  async expireStale() {
    const now = this.now();
    let n = 0;
    for (const r of [...this.reservations.values()]) {
      if (r.reservedUntil <= now) {
        const entry = { type: 'expired', offerId: r.offerId, fillNonce: r.fillNonce, f: r.f };
        this._append(entry);
        this._apply(entry);
        n++;
      }
    }
    return n;
  }

  activeReservations(offerId) {
    return [...this.reservations.values()].filter((r) => r.offerId === offerId);
  }
}

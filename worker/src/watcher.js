/**
 * watcher.js — spec §10 watcher duties: per-fillId swap state machine.
 *
 * Phases per fill: committed -> makerLocked -> takerLocked -> claimed | refunded
 * (+ expired when a reservation dies unfilled).
 *
 * Persistence: every swap upsert is appended to a JSONL store and fsync'd (same
 * durable store discipline as the reservation ledger). On restart the watcher
 * reloads and RE-DERIVES each in-flight swap's phase from chain state — chain is
 * truth, never the persisted phase. It then resumes: re-submits claims if the
 * preimage is known and the window is open, refunds at T+ε, expires stale
 * reservations.
 *
 * The role-specific tick logic lives in maker.js / taker.js; the watcher owns
 * the machine, the store, recovery, and the poll loop.
 */
import { openSync, writeSync, fsyncSync, closeSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from './util.js';
import { getWithdrawnEvents, getRefundedEvents, findLocksByFillId, getEscrowAddress, computeId, getBalance } from './chain.js';

export const PHASE = {
  COMMITTED: 'committed',
  MAKER_LOCKED: 'makerLocked',
  TAKER_LOCKED: 'takerLocked',
  CLAIMED: 'claimed',
  REFUNDED: 'refunded',
  EXPIRED: 'expired',
};

export const TERMINAL = new Set([PHASE.CLAIMED, PHASE.REFUNDED, PHASE.EXPIRED]);

export class SwapWatcher {
  /**
   * @param {object} o
   * @param {string} o.workerId   unique worker identity (swap store file per worker)
   * @param {string} o.dataDir
   * @param {object} o.chains     { A, B } chain endpoints
   * @param {object} o.artifacts  { factoryAbi, factoryBytecode, escrowAbi }
   * @param {function} o.onTick   async (swap, ctx) -> void ; role logic (maker/taker)
   * @param {number} [o.pollIntervalMs=2000]
   */
  constructor({ workerId, dataDir, chains, artifacts, onTick, pollIntervalMs = 2000 }) {
    this.workerId = workerId;
    this.dir = join(dataDir, workerId);
    this.storePath = join(this.dir, 'swaps.jsonl');
    this.chains = chains;
    this.artifacts = artifacts;
    this.onTick = onTick;
    this.pollIntervalMs = pollIntervalMs;
    this.swaps = new Map(); // fillId -> swap record
    this._fd = null;
    this._timer = null;
    this._running = false;
  }

  async start() {
    mkdirSync(this.dir, { recursive: true });
    this._fd = openSync(this.storePath, 'a');
    this._replay();
    await this.recover(); // re-derive every in-flight swap from chain truth
    return this;
  }

  async stop() {
    this.stopPolling();
    if (this._fd !== null) { try { closeSync(this._fd); } catch {} this._fd = null; }
  }

  startPolling() {
    if (this._timer) return;
    this._running = true;
    const loop = async () => {
      if (!this._running) return;
      try { await this.runOnce(); } catch (e) { console.error(`[watcher:${this.workerId}] tick error:`, e.message); }
      this._timer = setTimeout(loop, this.pollIntervalMs);
      if (this._timer.unref) this._timer.unref();
    };
    loop();
  }

  stopPolling() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /** Track a new swap (or replace). Persists immediately. */
  track(swap) {
    if (!swap.fillId) throw new Error('swap needs fillId');
    this.swaps.set(swap.fillId, { ...swap });
    this._persist(swap);
    return swap;
  }

  get(fillId) { return this.swaps.get(fillId); }
  all() { return [...this.swaps.values()]; }
  active() { return this.all().filter((s) => !TERMINAL.has(s.phase)); }

  update(swap) {
    this.swaps.set(swap.fillId, { ...swap });
    this._persist(swap);
  }

  _persist(swap) {
    // BigInt-safe: block numbers / amounts persist as decimal strings
    const line = JSON.stringify(
      { type: 'swap', fillId: swap.fillId, swap, ts: Date.now() },
      (k, v) => (typeof v === 'bigint' ? v.toString() : v),
    ) + '\n';
    writeSync(this._fd, line);
    fsyncSync(this._fd);
  }

  _replay() {
    this.swaps.clear();
    if (!existsSync(this.storePath)) return;
    for (const line of readFileSync(this.storePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'swap' && e.swap) this.swaps.set(e.fillId, e.swap);
      } catch { /* torn line from kill -9: skip */ }
    }
  }

  /**
   * Restart recovery: for every non-terminal swap, re-derive phase from chain
   * reads and resume. Chain is truth — persisted phase is only a hint.
   * Discovered fields (escrow addrs, preimage) are merged even when the phase
   * itself is unchanged.
   */
  async recover() {
    for (const swap of this.active()) {
      const derived = await this.derivePhase(swap);
      let changed = false;
      if (derived.phase !== swap.phase) {
        console.log(`[watcher:${this.workerId}] recover ${swap.fillId.slice(0, 10)}…: ${swap.phase} -> ${derived.phase} (chain-derived)`);
        swap.phase = derived.phase;
        changed = true;
      }
      for (const [k, v] of Object.entries(derived.extra || {})) {
        if (v !== undefined && swap[k] !== v) { swap[k] = v; changed = true; }
      }
      if (changed) this.update(swap);
    }
  }

  /**
   * Derive a swap's phase from on-chain state. Role-aware:
   *  - maker terminal = claimed B (revealed s) / refunded A. Withdrawn on A = fully settled.
   *  - taker terminal = claimed A / refunded B. Withdrawn on B merely reveals s
   *    (preimage forwarded so the tick can re-submit the claim after a restart).
   * Returns { phase, extra } where extra carries discovered escrow addrs / preimage.
   */
  async derivePhase(swap) {
    const { A, B } = this.chains;
    const art = this.artifacts;
    const extra = {};
    const sinceBlock = swap.fromBlock != null ? BigInt(swap.fromBlock) : 0n;

    const legStatus = async (chain, escrowAddr) => {
      if (!escrowAddr) return { withdrawn: null, refunded: false };
      const w = await getWithdrawnEvents(chain, art, escrowAddr, sinceBlock);
      const r = await getRefundedEvents(chain, art, escrowAddr, sinceBlock);
      return { withdrawn: w.length > 0 ? w[0].args.preimage : null, refunded: r.length > 0 };
    };
    const stB = await legStatus(B, swap.escrowB);
    const stA = await legStatus(A, swap.escrowA);

    if (swap.role === 'taker') {
      if (stA.withdrawn) return { phase: PHASE.CLAIMED, extra: { ...extra, preimage: stA.withdrawn } };
      if (stB.refunded) return { phase: PHASE.REFUNDED, extra };
      if (stB.withdrawn) extra.preimage = stB.withdrawn; // s known — tick re-submits the A claim
    } else {
      if (stB.withdrawn) return { phase: PHASE.CLAIMED, extra: { ...extra, preimage: stB.withdrawn } };
      if (stA.withdrawn) return { phase: PHASE.CLAIMED, extra: { ...extra, preimage: stA.withdrawn } };
      if (stB.refunded || stA.refunded) return { phase: PHASE.REFUNDED, extra };
    }

    // Discover the taker lock on chain B by fillId (maker may not know escrowB yet).
    const locksB = await findLocksByFillId(B, art, swap.fillId, sinceBlock);
    if (locksB.length > 0 && !swap.escrowB) extra.escrowB = locksB[0].args.escrow;
    const takerLocked = locksB.length > 0 || !!swap.escrowB;

    // Maker leg: recompute the deterministic id from known lock params, if we have them
    // (timelock/amount come back from JSON as strings — convert before the call).
    let makerLocked = !!swap.escrowA;
    if (!makerLocked && swap.lockParamsA) {
      const lp = {
        ...swap.lockParamsA,
        timelock: BigInt(swap.lockParamsA.timelock),
        amount: BigInt(swap.lockParamsA.amount),
        exclusiveUntil: BigInt(swap.lockParamsA.exclusiveUntil ?? 0),
      };
      const id = await computeId(A, art, lp);
      const addr = await getEscrowAddress(A, art, id);
      if (addr) { makerLocked = true; extra.escrowA = addr; }
    }
    // Fallback: scan factory A events for the fillId.
    if (!makerLocked) {
      const locksA = await findLocksByFillId(A, art, swap.fillId, sinceBlock);
      if (locksA.length > 0) { makerLocked = true; extra.escrowA = locksA[0].args.escrow; }
    }

    if (takerLocked) return { phase: PHASE.TAKER_LOCKED, extra };
    if (makerLocked) return { phase: PHASE.MAKER_LOCKED, extra };
    return { phase: PHASE.COMMITTED, extra };
  }

  /** One poll cycle over all active swaps. */
  async runOnce() {
    for (const swap of this.active()) {
      const ctx = {
        chains: this.chains,
        artifacts: this.artifacts,
        update: (s) => this.update(s),
        derivePhase: (s) => this.derivePhase(s),
      };
      await this.onTick(swap, ctx);
    }
  }

  /** Block until a fill reaches a terminal phase (or timeout). Returns final swap. */
  async waitFor(fillId, { timeoutMs = 120000, intervalMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.runOnce();
      const s = this.get(fillId);
      if (s && TERMINAL.has(s.phase)) return s;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${fillId} to settle (phase=${s && s.phase})`);
      await sleep(intervalMs);
    }
  }
}

/** Helper: does an escrow still hold funds? (distinguishes claimed vs merely existing) */
export async function escrowFunded(chain, escrowAddress) {
  return (await getBalance(chain, escrowAddress)) > 0n;
}

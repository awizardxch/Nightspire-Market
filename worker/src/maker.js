/**
 * maker.js — maker (A) role flow per spec §3.1.
 *
 *  1. COMMIT: receive taker commitment -> verify taker signature -> ATOMICALLY
 *     reserve via the §7 ledger -> signed ack (or signed rejection).
 *  2. MAKER LOCK: generate FRESH secret s (never reused), h=sha256(s); lock f
 *     of X in HTLC_A on chain A (T1 long); post lock proof {txid, h, fillId}.
 *  3. MAKER CLAIM: watcher sees the taker lock on chain B -> withdraw(s) on
 *     HTLC_B immediately (reveals s on chain B).
 *  Timeout: taker ghost -> refund() on HTLC_A after T1 (refund pays refundAddr,
 *     never msg.sender). Reservation expiry returns f to the pool (§7).
 */
import { signMessage } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { canonical, newSecret, fillIdFor, proRata, assertBytes32, sleep } from './util.js';
import {
  newContract, readEscrow, escrowWithdraw, escrowRefund,
  findLocksByFillId, getWithdrawnEvents, latestTimestamp, ZERO_ADDRESS,
} from './chain.js';
import { PHASE, escrowFunded } from './watcher.js';

export class MakerWorker {
  /**
   * @param {object} o
   * @param {string} o.workerId
   * @param {object} o.ledger        ReservationLedger (started)
   * @param {object} o.watcher       SwapWatcher (started), onTick bound to this._onTick
   * @param {object} o.chains        { A, B }
   * @param {object} o.artifacts
   * @param {object} o.lockAccount   { address, privateKey, wallet } — funds + locks on A
   * @param {object} [o.settleAccount] { address, wallet } — pays gas for claim/refund txs;
   *                             defaults to lockAccount. Anyone may trigger withdraw/refund
   *                             (payout is hardcoded), so a dedicated gas account is fine.
   * @param {string} o.recvAddress   makerRecvAddr — receiver on chain B
   * @param {object} o.offer         the CrossChainOffer-shaped object this worker serves
   */
  constructor({ workerId, ledger, watcher, chains, artifacts, lockAccount, settleAccount, recvAddress, offer }) {
    this.workerId = workerId;
    this.ledger = ledger;
    this.watcher = watcher;
    this.chains = chains;
    this.artifacts = artifacts;
    this.lockAccount = lockAccount;
    this.settleAccount = settleAccount || lockAccount;
    this.recvAddress = recvAddress;
    this.offer = offer;
  }

  /** Sign a payload with the maker's lock key (STUB: personal_sign-style; spec §4 wants EIP-712 typed offers). */
  async _sign(payload) {
    return signMessage({ message: canonical(payload), privateKey: this.lockAccount.privateKey });
  }

  async _verifyTakerSig(commitment) {
    const { signature, ...body } = commitment;
    const recovered = await recoverMessageAddress({ message: canonical(body), signature });
    return recovered.toLowerCase() === commitment.takerAddrs.wantChain.toLowerCase();
  }

  /**
   * Step 2 (COMMIT): taker -> maker commitment.
   * Returns { ok:true, ack } or { ok:false, rejection }. Signed either way.
   */
  async handleCommitment(commitment) {
    if (!(await this._verifyTakerSig(commitment))) {
      throw new Error('bad taker commitment signature');
    }
    const res = await this.ledger.handleCommitment(commitment, {
      signAck: (ack) => this._sign(ack),
      signRejection: (rej) => this._sign(rej),
    });
    if (res.ok) {
      const fillId = fillIdFor(commitment.offerId, commitment.fillNonce);
      this.watcher.track({
        fillId,
        offerId: commitment.offerId,
        fillNonce: commitment.fillNonce,
        f: BigInt(commitment.f).toString(),
        role: 'maker',
        phase: PHASE.COMMITTED,
        takerAddrs: commitment.takerAddrs,
        reservedUntil: res.ack.reservedUntil,
        fromBlock: 0n,
      });
    }
    return res;
  }

  /**
   * Step 3 (MAKER LOCK): fresh s, lock f on chain A, post lock proof.
   * Returns lockProof { fillId, h, escrowA, txHash, timelockA, amountA }.
   */
  async lock(fillId, { t1Sec }) {
    const swap = this.watcher.get(fillId);
    if (!swap) throw new Error(`unknown fill ${fillId}`);
    if (swap.phase !== PHASE.COMMITTED) throw new Error(`lock: bad phase ${swap.phase}`);

    const { s, h } = newSecret(); // fresh per fill — never reused
    const now = await latestTimestamp(this.chains.A);
    const timelock = now + BigInt(t1Sec);
    const f = BigInt(swap.f);
    const lockParamsA = {
      receiver: swap.takerAddrs.giveChain,
      refundAddr: this.lockAccount.address, // == offer.makerAddr
      hashlock: h,
      timelock,
      token: ZERO_ADDRESS, // native variant for the local demo
      amount: f,
      fillId,
      arbiter: ZERO_ADDRESS, // pure HTLC — no mediated branch
      exclusiveClaimer: ZERO_ADDRESS,
      exclusiveUntil: 0n,
    };
    const res = await newContract(this.chains.A, this.lockAccount.wallet, this.artifacts, lockParamsA);
    Object.assign(swap, {
      phase: PHASE.MAKER_LOCKED,
      s, // makers only: persisted so restart recovery can re-submit the claim
      h,
      escrowA: res.escrow,
      lockParamsA: { ...lockParamsA, timelock: lockParamsA.timelock.toString(), amount: lockParamsA.amount.toString() },
      timelockA: timelock.toString(),
      lockTxA: res.txHash,
      fromBlock: res.blockNumber > 2n ? res.blockNumber - 2n : 0n,
    });
    this.watcher.update(swap);
    return { fillId, h, escrowA: res.escrow, txHash: res.txHash, timelockA: timelock.toString(), amountA: f.toString() };
  }

  /** Watcher tick: claim B when the taker locks; refund A after T1; expire dead reservations. */
  async _onTick(swap, ctx) {
    if (swap.role !== 'maker') return;
    const { A, B } = this.chains;
    const art = this.artifacts;

    if (swap.phase === PHASE.COMMITTED || swap.phase === PHASE.MAKER_LOCKED || swap.phase === PHASE.TAKER_LOCKED) {
      // Discover the taker lock on chain B by fillId (unless we already know it —
      // e.g. re-derived after a restart).
      if (!swap.escrowB) {
        const locks = await findLocksByFillId(B, art, swap.fillId, BigInt(swap.fromBlock ?? 0));
        if (locks.length > 0) {
          const ev = locks[0].args;
          // Verify the taker leg before claiming (spec §3.1 step 5 ordering).
          const want = proRata(this.offer.wantAmount, swap.f, this.offer.giveAmount);
          const ok =
            ev.hashlock.toLowerCase() === swap.h.toLowerCase() &&
            ev.receiver.toLowerCase() === this.recvAddress.toLowerCase() &&
            ev.refundAddr.toLowerCase() === swap.takerAddrs.wantChain.toLowerCase() &&
            ev.amount === BigInt(want) &&
            ev.fillId.toLowerCase() === swap.fillId.toLowerCase() &&
            ev.timelock < BigInt(swap.timelockA); // T2 < T1 iron rule
          if (!ok) {
            console.error(`[maker] taker lock ${ev.escrow} FAILED verification — will not claim`);
            return;
          }
          swap.escrowB = ev.escrow;
          swap.phase = PHASE.TAKER_LOCKED;
          ctx.update(swap);
        }
      }

      // Maker claims HTLC_B immediately -> reveals s on chain B.
      // Idempotent: if a Withdrawn event is already there (crash between claim
      // and persist), skip the tx and just advance the machine.
      if (swap.escrowB && swap.s) {
        const w = await getWithdrawnEvents(B, art, swap.escrowB, BigInt(swap.fromBlock ?? 0));
        if (w.length === 0) {
          await escrowWithdraw(B, this.settleAccount.wallet, art, swap.escrowB, swap.s);
        }
        swap.phase = PHASE.CLAIMED;
        this.ledger.markFilled({ offerId: swap.offerId, fillNonce: swap.fillNonce, f: swap.f, fillId: swap.fillId });
        ctx.update(swap);
        console.log(`[maker] claimed ${proRata(this.offer.wantAmount, swap.f, this.offer.giveAmount)} on B for fill ${swap.fillId.slice(0, 10)}…`);
        return;
      }

      // No taker lock yet: timeouts.
      const nowTs = await latestTimestamp(A);
      if (swap.timelockA && nowTs >= BigInt(swap.timelockA) && swap.escrowA && await escrowFunded(A, swap.escrowA)) {
        await escrowRefund(A, this.settleAccount.wallet, art, swap.escrowA);
        swap.phase = PHASE.REFUNDED;
        this.ledger.release({ offerId: swap.offerId, fillNonce: swap.fillNonce, reason: 'taker-ghost-refund' });
        ctx.update(swap);
        console.log(`[maker] refunded A after T1 for fill ${swap.fillId.slice(0, 10)}…`);
        return;
      }
      if (swap.reservedUntil && Date.now() > swap.reservedUntil && !swap.escrowA) {
        // W expired before the maker even locked: release the reservation.
        this.ledger.release({ offerId: swap.offerId, fillNonce: swap.fillNonce, reason: 'commit-window-expired' });
        swap.phase = PHASE.EXPIRED;
        ctx.update(swap);
      }
    }
  }

  /**
   * Reconcile terminal swaps with the reservation ledger after a restart
   * (idempotent — safe to call on every boot).
   */
  reconcileLedger() {
    for (const swap of this.watcher.all()) {
      if (swap.role !== 'maker') continue;
      if (swap.phase === PHASE.CLAIMED) {
        this.ledger.markFilled({ offerId: swap.offerId, fillNonce: swap.fillNonce, f: swap.f, fillId: swap.fillId });
      } else if (swap.phase === PHASE.REFUNDED || swap.phase === PHASE.EXPIRED) {
        this.ledger.release({ offerId: swap.offerId, fillNonce: swap.fillNonce, reason: 'restart-reconcile' });
      }
    }
  }

  async waitForSettled(fillId, opts) {
    return this.watcher.waitFor(fillId, opts);
  }
}

/**
 * taker.js — taker (B) role flow per spec §3.1.
 *
 *  1. COMMIT: taker signs commitment {offerId, f, fillNonce, takerAddrs} -> maker.
 *     The taker NEVER generates the swap secret.
 *  2. TAKER LOCK: verify HTLC_A on-chain (amount, hashlock, timelock, receiver,
 *     refundAddr, fillId) -> lock pro-rata Y in HTLC_B on chain B (T2 < T1,
 *     same h from the maker's lock proof) -> post lock proof.
 *  3. TAKER CLAIM: read s from the Withdrawn event on chain B -> withdraw(s)
 *     on HTLC_A before T1.
 *  Timeout: maker ghost -> refund() on HTLC_B after T2.
 */
import { signMessage } from 'viem/accounts';
import { canonical, proRata, assertBytes32 } from './util.js';
import {
  newContract, readEscrow, escrowWithdraw, escrowRefund,
  getWithdrawnEvents, latestTimestamp, ZERO_ADDRESS,
} from './chain.js';
import { PHASE, escrowFunded } from './watcher.js';

export class TakerWorker {
  /**
   * @param {object} o
   * @param {string} o.workerId
   * @param {object} o.watcher       SwapWatcher (started), onTick bound to this._onTick
   * @param {object} o.chains        { A, B }
   * @param {object} o.artifacts
   * @param {object} o.lockAccount   { address, privateKey, wallet } — funds + locks on B
   * @param {object} [o.settleAccount] { address, wallet } — pays gas for claim/refund txs
   * @param {string} o.recvAddress   takerAddrs.giveChain — receiver on chain A
   */
  constructor({ workerId, watcher, chains, artifacts, lockAccount, settleAccount, recvAddress }) {
    this.workerId = workerId;
    this.watcher = watcher;
    this.chains = chains;
    this.artifacts = artifacts;
    this.lockAccount = lockAccount;
    this.settleAccount = settleAccount || lockAccount;
    this.recvAddress = recvAddress;
  }

  /** Sign a commitment (STUB: personal_sign-style; spec §4 wants EIP-712). */
  async signCommitment({ offerId, f, fillNonce }) {
    const body = {
      offerId,
      f: BigInt(f).toString(),
      fillNonce,
      takerAddrs: { giveChain: this.recvAddress, wantChain: this.lockAccount.address },
    };
    const signature = await signMessage({ message: canonical(body), privateKey: this.lockAccount.privateKey });
    return { ...body, signature };
  }

  /**
   * Step 4 (TAKER LOCK): verify the maker's HTLC_A on-chain, then lock HTLC_B.
   * Throws if ANY term mismatches — never lock against an unverified leg.
   */
  async verifyAndLock(lockProof, offer, { t2Sec }) {
    const { A, B } = this.chains;
    const art = this.artifacts;
    assertBytes32(lockProof.h, 'h');
    assertBytes32(lockProof.fillId, 'fillId');

    // --- on-chain verification of HTLC_A (spec §3.1 step 4) ---
    const esc = await readEscrow(A, art, lockProof.escrowA);
    const checks = [
      ['amount', esc.AMOUNT === BigInt(lockProof.amountA), `${esc.AMOUNT} != ${lockProof.amountA}`],
      ['hashlock', esc.HASHLOCK.toLowerCase() === lockProof.h.toLowerCase(), 'hashlock mismatch'],
      ['timelock', esc.TIMELOCK === BigInt(lockProof.timelockA), 'timelock mismatch'],
      ['receiver', esc.RECEIVER.toLowerCase() === this.recvAddress.toLowerCase(), 'receiver mismatch'],
      ['refundAddr', esc.REFUND_ADDR.toLowerCase() === offer.makerAddr.toLowerCase(), 'refundAddr mismatch'],
      ['fillId', esc.FILL_ID.toLowerCase() === lockProof.fillId.toLowerCase(), 'fillId mismatch'],
      ['arbiter', esc.ARBITER === ZERO_ADDRESS, 'arbiter must be null for pure-HTLC demo'],
      ['token', esc.TOKEN === ZERO_ADDRESS, 'demo is native-only'],
    ];
    for (const [name, ok, msg] of checks) {
      if (!ok) throw new Error(`HTLC_A verification failed [${name}]: ${msg}`);
    }
    const chainNow = await latestTimestamp(A);
    if (esc.TIMELOCK <= chainNow) throw new Error('HTLC_A timelock not in the future');

    // --- lock HTLC_B: T2 < T1 iron rule, same h ---
    const now = await latestTimestamp(B);
    const timelockB = now + BigInt(t2Sec);
    if (timelockB >= esc.TIMELOCK) throw new Error('T2 must be < T1 (iron rule)');
    const amountB = proRata(offer.wantAmount, lockProof.amountA, offer.giveAmount);
    const lockParamsB = {
      receiver: offer.makerRecvAddr,
      refundAddr: this.lockAccount.address, // takerAddrs.wantChain
      hashlock: lockProof.h,
      timelock: timelockB,
      token: ZERO_ADDRESS,
      amount: BigInt(amountB),
      fillId: lockProof.fillId,
      arbiter: ZERO_ADDRESS,
      exclusiveClaimer: ZERO_ADDRESS,
      exclusiveUntil: 0n,
    };
    const res = await newContract(B, this.lockAccount.wallet, art, lockParamsB);
    this.watcher.track({
      fillId: lockProof.fillId,
      offerId: offer.offerId,
      fillNonce: offer.fillNonce ?? null,
      f: lockProof.amountA,
      role: 'taker',
      phase: PHASE.TAKER_LOCKED,
      escrowA: lockProof.escrowA,
      escrowB: res.escrow,
      timelockA: lockProof.timelockA,
      timelockB: timelockB.toString(),
      lockTxB: res.txHash,
      fromBlock: res.blockNumber > 2n ? res.blockNumber - 2n : 0n,
    });
    return { fillId: lockProof.fillId, escrowB: res.escrow, txHash: res.txHash, timelockB: timelockB.toString(), amountB };
  }

  /** Watcher tick: claim A once s is revealed on B; refund B after T2. */
  async _onTick(swap, ctx) {
    if (swap.role !== 'taker') return;
    if (swap.phase !== PHASE.TAKER_LOCKED) return;
    const { A, B } = this.chains;
    const art = this.artifacts;

    const withdrawn = await getWithdrawnEvents(B, art, swap.escrowB, BigInt(swap.fromBlock ?? 0));
    if (withdrawn.length > 0) {
      const s = withdrawn[0].args.preimage; // s is public on chain B now
      await escrowWithdraw(A, this.settleAccount.wallet, art, swap.escrowA, s);
      swap.phase = PHASE.CLAIMED;
      swap.preimage = s;
      ctx.update(swap);
      console.log(`[taker] claimed ${swap.f} on A for fill ${swap.fillId.slice(0, 10)}…`);
      return;
    }
    const nowTs = await latestTimestamp(B);
    if (nowTs >= BigInt(swap.timelockB) && await escrowFunded(B, swap.escrowB)) {
      await escrowRefund(B, this.settleAccount.wallet, art, swap.escrowB);
      swap.phase = PHASE.REFUNDED;
      ctx.update(swap);
      console.log(`[taker] refunded B after T2 for fill ${swap.fillId.slice(0, 10)}…`);
    }
  }

  async waitForSettled(fillId, opts) {
    return this.watcher.waitFor(fillId, opts);
  }
}

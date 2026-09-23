'use strict';

/**
 * src/watcher.js — STUB. Chain watcher interface only.
 *
 * Spec §10 (Watcher duties): after maker's lock, poll HTLC_A until confirmed;
 * after taker/filler lock, poll HTLC_B and submit the maker's claim with s;
 * after the maker's claim reveals s, submit the taker's claim; refund at T+ε;
 * heartbeat swap state to the relay; solver mode: winners must lock inside
 * their exclusive window or eat the slash.
 *
 * HARD CONSTRAINT of this skeleton: NO chain interaction at all — no RPC
 * calls, no broadcasts, no chain keys. These methods therefore throw.
 * They are never called by server.js.
 */
const NOT_IMPLEMENTED = 'not implemented — no chain access in skeleton (spec §10)';

class ChainWatcher {
  constructor(_opts = {}) {
    throw new Error(NOT_IMPLEMENTED + ' (watcher cannot even be constructed in the skeleton)');
  }

  /** Poll an HTLC leg until confirmed or deadline. */
  async pollLeg(_leg) {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Called when a lock tx is seen on-chain. */
  async onLockSeen(_fillId, _proof) {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Called when a claim reveals the preimage s on-chain. */
  async onClaimSeen(_fillId, _preimage) {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Submit claim/refund tx for a fill (time-critical path). */
  async submitClaim(_fillId) {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Full swap state machine for one fill (offerId/fillId → phase). */
  async watchFill(_offerId, _fillId) {
    throw new Error(NOT_IMPLEMENTED);
  }

  stop() {
    // no-op: nothing ever started
  }
}

module.exports = { ChainWatcher, NOT_IMPLEMENTED };

'use strict';

/**
 * src/preimage.js — STUB forwarder interface.
 *
 * Spec §3.1: the maker generates the secret s, commits to h = sha256(s) at
 * lock time, and reveals s by claiming the taker's leg; the taker learns s
 * from the maker's on-chain claim. The relay's role (§1 decision 3) is to
 * forward preimages — a convenience, never custody: the preimage is public
 * on-chain the moment the maker claims, and any watcher can read it there.
 *
 * HARD CONSTRAINT of this skeleton: NO chain interaction at all, so this
 * forwards nothing. Never called by server.js.
 */
const NOT_IMPLEMENTED = 'not implemented — preimage forwarding is a STUB in the skeleton';

async function forwardPreimage(_fillId, _preimageHex) {
  throw new Error(NOT_IMPLEMENTED);
}

async function notePreimageSeen(_fillId, _txid, _chain) {
  throw new Error(NOT_IMPLEMENTED);
}

module.exports = { forwardPreimage, notePreimageSeen, NOT_IMPLEMENTED };

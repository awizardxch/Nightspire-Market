'use strict';

/**
 * src/checkpoints.js — signed Merkle checkpoints (spec §12 "Fake facts /
 * equivocation": signed Merkle checkpoints of the order book every N
 * events/T minutes, anchored publicly. Proves listing; makes silent deletion
 * and split-view equivocation detectable).
 *
 * A checkpoint commits to a CONTIGUOUS range of the hash-chained log:
 *   { checkpointId, seqStart, seqEnd, entryCount, merkleRoot,
 *     prevCheckpoint, ts, relaySig }
 *   merkleRoot = Merkle root over the log entry `hash`es in [seqStart, seqEnd]
 *                (pairwise sha256(left||right) over raw bytes; odd leaf duplicated)
 *   relaySig   = ed25519 over canonical JSON of the checkpoint sans relaySig
 *
 * Anyone holding the log can recompute the root and verify the signature —
 * a relay that silently deletes entries or serves split views produces a
 * checkpoint that does not match the log (spec §12: detectable).
 *
 * OUT OF SCOPE for the local relay: public ANCHORING (Nostr note / cheap
 * on-chain log). The signed checkpoint is produced and served here; an
 * external publisher anchors it. The checkpoint + log together are the
 * evidence; anchoring only adds a timestamp witness.
 */
const crypto = require('node:crypto');
const { canonicalize } = require('./canonical');

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

/** Merkle root over an array of hex hashes (log entry `hash`es, in seq order). */
function merkleRoot(hexHashes) {
  if (!hexHashes.length) throw new Error('cannot build a checkpoint over zero entries');
  let level = hexHashes.map((h) => Buffer.from(h, 'hex'));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left; // duplicate odd leaf
      next.push(sha256Bytes(Buffer.concat([left, right])));
    }
    level = next;
  }
  return level[0].toString('hex');
}

function checkpointSignBytes(cp) {
  const { relaySig: _dropped, ...rest } = cp;
  return Buffer.from(canonicalize(rest), 'utf8');
}

/**
 * Build a checkpoint over `entries` (log entries, ascending seq) following
 * `prevCheckpoint` (or null for the first). Entries must form the contiguous
 * range [seqStart, seqEnd] where seqStart = prev.seqEnd+1 (or 1).
 */
function buildCheckpoint({ entries, prevCheckpoint, signer }) {
  if (!entries.length) throw new Error('no entries to checkpoint');
  const seqStart = prevCheckpoint ? prevCheckpoint.seqEnd + 1 : 1;
  const seqEnd = entries[entries.length - 1].seq;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].seq !== seqStart + i)
      throw new Error(`checkpoint range not contiguous: expected seq ${seqStart + i}, got ${entries[i].seq}`);
  }
  const root = merkleRoot(entries.map((e) => e.hash));
  const cp = {
    checkpointId: 'chk_' + root.slice(0, 16),
    seqStart,
    seqEnd,
    entryCount: entries.length,
    merkleRoot: root,
    prevCheckpoint: prevCheckpoint ? prevCheckpoint.merkleRoot : 'GENESIS',
    ts: Math.floor(Date.now() / 1000),
  };
  cp.relaySig = signer.sign(checkpointSignBytes(cp));
  return cp;
}

/**
 * Verify a checkpoint against log `entries` and the relay pubkey (DER hex).
 * Returns { ok:true } or { ok:false, error }.
 */
function verifyCheckpoint(checkpoint, entries, publicKeyDerHex) {
  const { RelaySigner } = require('./signer');
  try {
    const inRange = entries.filter((e) => e.seq >= checkpoint.seqStart && e.seq <= checkpoint.seqEnd);
    if (inRange.length !== checkpoint.entryCount)
      return { ok: false, error: `entry count mismatch: checkpoint says ${checkpoint.entryCount}, log has ${inRange.length} in range` };
    for (let i = 0; i < inRange.length; i++) {
      if (inRange[i].seq !== checkpoint.seqStart + i)
        return { ok: false, error: `log range not contiguous at seq ${checkpoint.seqStart + i}` };
    }
    const root = merkleRoot(inRange.map((e) => e.hash));
    if (root !== checkpoint.merkleRoot) return { ok: false, error: 'merkleRoot does not match log entries' };
    const okSig = RelaySigner.verifyWith(checkpointSignBytes(checkpoint), checkpoint.relaySig, publicKeyDerHex);
    if (!okSig) return { ok: false, error: 'relaySig invalid' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `verification threw: ${e.message}` };
  }
}

module.exports = { merkleRoot, buildCheckpoint, verifyCheckpoint, checkpointSignBytes };

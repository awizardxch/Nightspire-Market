'use strict';

/**
 * src/log.js — append-only hash-chained event log (spec §12 "append-only
 * hash-chained event log": offers, commitments, bids, fills, slashes — all
 * appended to a signed chain. Rewriting history breaks it).
 *
 * Entry shape:
 *   { seq, prevHash, type, payload,
 *     hash:    sha256hex(prevHash || canonicalJson(payload)),
 *     relaySig: ed25519(canonicalJson({seq, prevHash, hash, type, payload})) }
 *
 * Notes on the construction (honest accounting of a spec ambiguity):
 *  - The task/spec text reads "hash=sha256(prevHash||canonicalJson)". Taken
 *    literally, hash binds prevHash + payload only; seq/type ordering is
 *    bound by relaySig, which signs {seq, prevHash, hash, type, payload}.
 *    We keep the literal formula and sign the full entry — both are verified.
 *  - Genesis prevHash is the string "GENESIS".
 *
 * Durability: one open fd, fsync after every append (write-ahead semantics,
 * like the §7 reservation ledger). Boot fails closed if the chain does not
 * verify (seq continuity, prevHash linkage, hash recomputation, relaySig).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize } = require('./canonical');

const GENESIS_PREV = 'GENESIS';

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function entryHash(prevHash, payload) {
  return sha256hex(prevHash + canonicalize(payload));
}

class RelayLog {
  constructor(dataDir, signer) {
    this.dataDir = dataDir;
    this.logPath = path.join(dataDir, 'log.jsonl');
    this.signer = signer;
    this.fd = null;
    this.seq = 0;
    this.prevHash = GENESIS_PREV;
    this.entries = []; // in-memory tail for pagination; the file is truth
  }

  open() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.fd = fs.openSync(this.logPath, 'a');
    const report = this.verify();
    if (!report.ok) {
      fs.closeSync(this.fd);
      this.fd = null;
      throw new Error(`log chain verification FAILED at boot: ${report.error}`);
    }
    // Replay in-memory tail state from the verified chain.
    for (const e of report.entries) {
      this.seq = e.seq;
      this.prevHash = e.hash;
      this.entries.push(e);
    }
    return report;
  }

  /** Verify the whole file: seq continuity, prevHash linkage, hash, relaySig. */
  verify() {
    if (!fs.existsSync(this.logPath)) return { ok: true, entries: [], count: 0 };
    const raw = fs.readFileSync(this.logPath, 'utf8');
    const entries = [];
    let expectedSeq = 1;
    let expectedPrev = GENESIS_PREV;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let e;
      try {
        e = JSON.parse(t);
      } catch {
        return { ok: false, error: `unparseable line at seq ${expectedSeq}`, entries };
      }
      if (e.seq !== expectedSeq) {
        return { ok: false, error: `seq gap: expected ${expectedSeq}, got ${e.seq}`, entries };
      }
      if (e.prevHash !== expectedPrev) {
        return { ok: false, error: `prevHash mismatch at seq ${e.seq}`, entries };
      }
      if (e.hash !== entryHash(e.prevHash, e.payload)) {
        return { ok: false, error: `hash mismatch at seq ${e.seq} — history tampered`, entries };
      }
      const signed = { seq: e.seq, prevHash: e.prevHash, hash: e.hash, type: e.type, payload: e.payload };
      if (!this.signer.verify(signed, e.relaySig)) {
        return { ok: false, error: `relaySig invalid at seq ${e.seq}`, entries };
      }
      entries.push(e);
      expectedSeq += 1;
      expectedPrev = e.hash;
    }
    return { ok: true, entries, count: entries.length };
  }

  append(type, payload) {
    if (this.fd === null) throw new Error('log not open');
    const entry = {
      seq: this.seq + 1,
      prevHash: this.prevHash,
      type,
      payload,
    };
    entry.hash = entryHash(entry.prevHash, entry.payload);
    entry.relaySig = this.signer.sign({
      seq: entry.seq,
      prevHash: entry.prevHash,
      hash: entry.hash,
      type: entry.type,
      payload: entry.payload,
    });
    const line = JSON.stringify(entry) + '\n';
    fs.writeSync(this.fd, line, null, 'utf8');
    fs.fsyncSync(this.fd); // write-ahead durability: fsync BEFORE returning / before any signed ack leaves
    this.seq = entry.seq;
    this.prevHash = entry.hash;
    this.entries.push(entry);
    return entry;
  }

  page(offset = 0, limit = 50) {
    const total = this.entries.length;
    const slice = this.entries.slice(offset, offset + limit);
    return {
      entries: slice,
      total,
      offset,
      limit,
      chainTip: { seq: this.seq, hash: this.prevHash },
      verified: true, // verified at boot; every post-boot entry verified at append time
    };
  }

  close() {
    if (this.fd !== null) {
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

module.exports = { RelayLog, GENESIS_PREV, entryHash, sha256hex };

#!/usr/bin/env node
'use strict';
/**
 * scripts/verify-chain.js — offline verifier for data/log.jsonl.
 *
 * Independently re-verifies the relay's hash chain (anyone can run this —
 * spec §12 "recomputable by anyone"):
 *   1. seq continuity from 1
 *   2. prevHash linkage
 *   3. hash = sha256(prevHash || canonicalJson(payload))
 *   4. relaySig = ed25519 over canonicalJson({seq, prevHash, hash, type, payload})
 * against the pinned relay pubkey in data/relay-key.json.
 *
 * Usage: node scripts/verify-chain.js [dataDir]
 * Exit 0 = chain valid, non-zero = broken.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDir = process.argv[2] || path.join(__dirname, '..', 'data');
const logPath = path.join(dataDir, 'log.jsonl');
const keyPath = path.join(dataDir, 'relay-key.json');

function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function fail(msg) {
  console.error(`VERIFY FAILED: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(logPath)) fail(`no log at ${logPath}`);
if (!fs.existsSync(keyPath)) fail(`no relay key at ${keyPath}`);
const { publicKeyDerHex } = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const pub = crypto.createPublicKey({ key: Buffer.from(publicKeyDerHex, 'hex'), format: 'der', type: 'spki' });

const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
let expectedSeq = 1;
let expectedPrev = 'GENESIS';
let sigsChecked = 0;
for (const line of lines) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    fail(`unparseable line near seq ${expectedSeq}`);
  }
  if (e.seq !== expectedSeq) fail(`seq gap: expected ${expectedSeq}, got ${e.seq}`);
  if (e.prevHash !== expectedPrev) fail(`prevHash mismatch at seq ${e.seq}`);
  const wantHash = sha256hex(e.prevHash + canonicalize(e.payload));
  if (e.hash !== wantHash) fail(`hash mismatch at seq ${e.seq}`);
  const signed = { seq: e.seq, prevHash: e.prevHash, hash: e.hash, type: e.type, payload: e.payload };
  const ok = crypto.verify(null, Buffer.from(canonicalize(signed), 'utf8'), pub, Buffer.from(e.relaySig, 'hex'));
  if (!ok) fail(`relaySig invalid at seq ${e.seq}`);
  sigsChecked++;
  expectedSeq++;
  expectedPrev = e.hash;
}
console.log(`VERIFY OK: ${lines.length} entries, ${sigsChecked} relay signatures valid, tip=${expectedPrev.slice(0, 16)}…`);

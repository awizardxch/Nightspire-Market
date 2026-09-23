/**
 * util.js — small shared helpers for the Nightspire cross-chain marketplace worker.
 *
 * Conventions (spec §5):
 *   fillId = sha256( UTF-8 bytes of "offerId||fillNonce" )  -> 0x-hex bytes32
 *   secret s = 32 fresh random bytes; hashlock h = sha256(s) -> 0x-hex bytes32
 *
 * NOTE: sha256(abi.encodePacked(preimage)) in HTLCEscrow with a bytes32 preimage is
 * sha256 of the raw 32 bytes, so Node's crypto sha256 over the 32-byte buffer matches.
 */
import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(buf) {
  return '0x' + createHash('sha256').update(buf).digest('hex');
}

/** fillId per spec: sha256 of the UTF-8 string "offerId||fillNonce". */
export function fillIdFor(offerId, fillNonce) {
  return sha256Hex(Buffer.from(`${offerId}||${fillNonce}`, 'utf8'));
}

/** Fresh per-fill secret. NEVER reuse across fills (spec §3.1 step 3). */
export function newSecret() {
  const s = randomBytes(32);
  return { s: '0x' + s.toString('hex'), h: sha256Hex(s) };
}

/** Canonical JSON (sorted keys, recursive) for message signing. */
export function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pro-rata want amount for fill f: (wantAmount * f) / giveAmount, integer math. */
export function proRata(wantAmount, f, giveAmount) {
  const w = BigInt(wantAmount);
  const amt = BigInt(f);
  const g = BigInt(giveAmount);
  if (amt <= 0n || amt > g) throw new Error('fill amount out of range');
  return ((w * amt) / g).toString();
}

const HEX64 = /^0x[0-9a-fA-F]{64}$/;
export function assertBytes32(v, name) {
  if (typeof v !== 'string' || !HEX64.test(v)) throw new Error(`${name} must be 0x-hex bytes32`);
}

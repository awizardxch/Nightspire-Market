'use strict';

/**
 * src/offer_sigs.js — offer signature verification (spec §4 offer format, §12 spoofing).
 *
 * Canonical signing bytes (ALL schemes, byte-for-byte so agents can reproduce):
 *   signBytes = UTF-8 of canonicalize(offerMinusSignatures)
 * where offerMinusSignatures is the offer object with the `signatures` key
 * removed, canonicalize = sorted-key JSON, no whitespace (src/canonical.js).
 *
 * What the relay CAN verify with Node.js built-ins (no npm deps):
 *  - signatures.ed25519 = { pubkey: <SPKI DER hex>, sig: <hex> }
 *      ed25519 over signBytes, verified against the provided pubkey.
 *      Chain-agnostic; used by the smoke test.
 *  - signatures.solana = <hex sig>
 *      ed25519 over signBytes, verified against makerAddr interpreted as a
 *      base58 Solana address (which IS the 32-byte ed25519 pubkey).
 *      Pure-JS base58 decode below.
 *
 * What stays honestly UNVERIFIED, with reasons (spec §12: agents MUST verify
 * these locally — "agents verify signatures locally"; the relay check is
 * edge anti-spam, never the trust root):
 *  - signatures.evm (EIP-712): needs keccak256 + secp256k1 public-key
 *    recovery — neither exists in Node's stdlib, and hand-rolling them in
 *    unaudited JS would be worse than an honest marker.
 *  - signatures.chia (BLS): needs BLS12-381 — not in stdlib either.
 *
 * verifyOfferSignatures(offer) -> { ok, statuses }
 *   statuses: { ed25519, solana, evm, chia } each one of
 *     'VERIFIED' | 'INVALID' | 'UNVERIFIED' | 'absent'
 *   ok = false if any PRESENT signature is INVALID (caller must reject).
 * Reasons for UNVERIFIED are in UNVERIFIED_REASONS.
 */
const crypto = require('node:crypto');
const { canonicalize } = require('./canonical');

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) throw new Error('not base58');
  let num = 0n;
  for (const ch of s) num = num * 58n + BigInt(B58_ALPHABET.indexOf(ch));
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let out = Buffer.from(hex, 'hex');
  // leading '1's are leading zero bytes
  let leading = 0;
  for (const ch of s) {
    if (ch !== '1') break;
    leading += 1;
  }
  if (leading > 0) out = Buffer.concat([Buffer.alloc(leading), out]);
  return out;
}

function base58Encode(buf) {
  let num = 0n;
  for (const b of buf) num = (num << 8n) + BigInt(b);
  let s = '';
  while (num > 0n) {
    s = B58_ALPHABET[Number(num % 58n)] + s;
    num /= 58n;
  }
  let leading = 0;
  for (const b of buf) {
    if (b !== 0) break;
    leading += 1;
  }
  return '1'.repeat(leading) + (s || '');
}

// SPKI DER prefix for an ed25519 public key (RFC 8410): SEQ(2a) SEQ(05 06032b6570) BIT STRING header.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawPubkeyToSpkiDerHex(raw32) {
  if (!Buffer.isBuffer(raw32) || raw32.length !== 32) throw new Error('ed25519 pubkey must be 32 bytes');
  return Buffer.concat([ED25519_SPKI_PREFIX, raw32]).toString('hex');
}

function spkiDerToRaw(spkiDerHex) {
  const der = Buffer.from(spkiDerHex, 'hex');
  const prefixLen = ED25519_SPKI_PREFIX.length;
  if (der.length !== prefixLen + 32 || !der.subarray(0, prefixLen).equals(ED25519_SPKI_PREFIX))
    throw new Error('pubkey must be ed25519 SPKI DER hex (44 bytes)');
  return der.subarray(prefixLen);
}

/** Canonical signing bytes for an offer: offer minus its `signatures` key. */
function offerSignBytes(offer) {
  const { signatures: _dropped, ...rest } = offer;
  return Buffer.from(canonicalize(rest), 'utf8');
}

function verifyEd25519(bytes, sigHex, spkiDerHex) {
  const pub = crypto.createPublicKey({ key: Buffer.from(spkiDerHex, 'hex'), format: 'der', type: 'spki' });
  return crypto.verify(null, bytes, pub, Buffer.from(sigHex, 'hex'));
}

const UNVERIFIED_REASONS = {
  evm: 'EIP-712 needs keccak256 + secp256k1 key recovery (not in Node stdlib) — agents MUST verify locally (spec §12)',
  chia: 'BLS12-381 not in Node stdlib — agents MUST verify locally (spec §12)',
};

function verifyOfferSignatures(offer) {
  const statuses = { ed25519: 'absent', solana: 'absent', evm: 'absent', chia: 'absent' };
  const reasons = {};
  const sigs = (offer && typeof offer === 'object' && offer.signatures) || {};
  const bytes = offerSignBytes(offer || {});
  let ok = true;

  if (sigs.ed25519 != null) {
    try {
      const { pubkey, sig } = sigs.ed25519;
      if (typeof pubkey !== 'string' || typeof sig !== 'string') throw new Error('shape');
      spkiDerToRaw(pubkey); // validates DER shape
      statuses.ed25519 = verifyEd25519(bytes, sig, pubkey) ? 'VERIFIED' : 'INVALID';
    } catch {
      statuses.ed25519 = 'INVALID';
    }
    if (statuses.ed25519 === 'INVALID') ok = false;
  }

  if (sigs.solana != null) {
    try {
      const raw = base58Decode(offer.makerAddr);
      if (raw.length !== 32) throw new Error('solana makerAddr must decode to 32 bytes');
      const spkiHex = rawPubkeyToSpkiDerHex(raw);
      statuses.solana =
        typeof sigs.solana === 'string' && verifyEd25519(bytes, sigs.solana, spkiHex) ? 'VERIFIED' : 'INVALID';
    } catch {
      // makerAddr not a decodable Solana address → cannot verify this scheme
      statuses.solana = 'UNVERIFIED';
      reasons.solana = 'makerAddr is not a base58 Solana address; cannot map to ed25519 pubkey';
    }
    if (statuses.solana === 'INVALID') ok = false;
  }

  for (const scheme of ['evm', 'chia']) {
    if (sigs[scheme] != null) {
      statuses[scheme] = 'UNVERIFIED';
      reasons[scheme] = UNVERIFIED_REASONS[scheme];
    }
  }

  return { ok, statuses, reasons };
}

module.exports = {
  verifyOfferSignatures,
  offerSignBytes,
  base58Decode,
  base58Encode,
  rawPubkeyToSpkiDerHex,
  UNVERIFIED_REASONS,
};

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
 * What the relay CAN verify with vendored audited code (no npm at runtime):
 *  - signatures.evm (EIP-712): keccak256 + secp256k1 ecrecover via vendored
 *    @noble/hashes@1.8.0 + @noble/curves@1.9.7 (relay/vendor/noble).
 *    Verifies against the NIGHTSPIRE RELAY EIP-712 CONVENTION v1
 *    (src/eip712.js): EIP712Domain(name="Nightspire Marketplace", version="1",
 *    giveChain) + CrossChainOffer(bytes32 termsHash), termsHash =
 *    keccak256(signBytes); ecrecover(digest, sig) must equal makerAddr.
 *    Only for EVM giveChains — other chains stay UNVERIFIED (wrong slot).
 *
 * What stays honestly UNVERIFIED, with reasons (spec §12: agents MUST verify
 * these locally — "agents verify signatures locally"; the relay check is
 * edge anti-spam, never the trust root):
 *  - signatures.chia (BLS): needs BLS12-381 — not vendored; and the spec's
 *    offer format carries no BLS pubkey (makerAddr is not necessarily a BLS
 *    key), so relay-side verification is infeasible without a spec change.
 *
 * verifyOfferSignatures(offer) -> { ok, statuses }
 *   statuses: { ed25519, solana, evm, chia } each one of
 *     'VERIFIED' | 'INVALID' | 'UNVERIFIED' | 'absent'
 *   ok = false if any PRESENT signature is INVALID (caller must reject).
 * Reasons for UNVERIFIED are in UNVERIFIED_REASONS.
 */
const crypto = require('node:crypto');
const { canonicalize } = require('./canonical');
const { verifyOfferEip712, verifyOfferCancelEip712 } = require('./eip712');

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
  chia: 'BLS12-381 not vendored, and the offer format carries no BLS pubkey (makerAddr is not necessarily a BLS key) — agents MUST verify locally (spec §12)',
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

  if (sigs.evm != null) {
    // EIP-712 via vendored noble (src/eip712.js, Nightspire convention v1).
    const res = verifyOfferEip712(offer);
    statuses.evm = res.status;
    if (res.reason) reasons.evm = res.reason;
    if (res.status === 'INVALID') ok = false;
  }

  if (sigs.chia != null) {
    statuses.chia = 'UNVERIFIED';
    reasons.chia = UNVERIFIED_REASONS.chia;
  }

  return { ok, statuses, reasons };
}

/** Canonical cancel signing bytes: {offerId, makerAddr, cancelledAt}. */
function offerCancelSignBytes(cancel) {
  return Buffer.from(canonicalize(cancel), 'utf8');
}

/**
 * Verify a maker's cancel request against the offer's own verified schemes.
 * cancelReq: { cancelledAt, signatures }. Only schemes the offer used AND
 * that verified at post time are checked; at least one must VERIFY.
 */
function verifyCancelSignatures(offer, cancelReq) {
  const statuses = { ed25519: 'absent', solana: 'absent', evm: 'absent', chia: 'absent' };
  const reasons = {};
  const sigs = (cancelReq && typeof cancelReq === 'object' && cancelReq.signatures) || {};
  const offerSigs = (offer && typeof offer === 'object' && offer.signatures) || {};
  const offerStatuses = (offer && typeof offer === 'object' && offer.signatureStatuses) || {};
  const cancelledAt = cancelReq && cancelReq.cancelledAt;
  const bytes = offerCancelSignBytes({ offerId: offer.offerId, makerAddr: offer.makerAddr, cancelledAt });
  let ok = true;
  if (offerSigs.ed25519 != null && offerStatuses.ed25519 === 'VERIFIED') {
    try {
      const c = sigs.ed25519 || {};
      if (typeof c.pubkey !== 'string' || typeof c.sig !== 'string') throw new Error('shape');
      if (c.pubkey.toLowerCase() !== String(offerSigs.ed25519.pubkey || '').toLowerCase())
        throw new Error('cancel pubkey does not match the key that signed the offer');
      spkiDerToRaw(c.pubkey);
      statuses.ed25519 = verifyEd25519(bytes, c.sig, c.pubkey) ? 'VERIFIED' : 'INVALID';
    } catch (e) { statuses.ed25519 = 'INVALID'; reasons.ed25519 = e.message; }
    if (statuses.ed25519 === 'INVALID') ok = false;
  }
  if (offerSigs.solana != null && offerStatuses.solana === 'VERIFIED') {
    try {
      const raw = base58Decode(offer.makerAddr);
      if (raw.length !== 32) throw new Error('bad len');
      const spkiHex = rawPubkeyToSpkiDerHex(raw);
      statuses.solana = (typeof sigs.solana === 'string' && verifyEd25519(bytes, sigs.solana, spkiHex)) ? 'VERIFIED' : 'INVALID';
    } catch { statuses.solana = 'INVALID'; }
    if (statuses.solana === 'INVALID') ok = false;
  }
  if (offerSigs.evm != null && offerStatuses.evm === 'VERIFIED') {
    const res = verifyOfferCancelEip712(offer, cancelledAt, sigs.evm);
    statuses.evm = res.status;
    if (res.reason) reasons.evm = res.reason;
    if (res.status === 'INVALID') ok = false;
  }
  if (offerSigs.chia != null) { statuses.chia = 'UNVERIFIED'; reasons.chia = UNVERIFIED_REASONS.chia; }
  return { ok, statuses, reasons };
}

module.exports = {
  verifyOfferSignatures,
  verifyCancelSignatures,
  offerCancelSignBytes,
  offerSignBytes,
  base58Decode,
  base58Encode,
  rawPubkeyToSpkiDerHex,
  UNVERIFIED_REASONS,
};

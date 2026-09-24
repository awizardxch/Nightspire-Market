'use strict';

/**
 * src/eip712.js — EIP-712 typed-data hashing + secp256k1 public-key recovery
 * for EVM offer signatures (spec §4: "EIP-712 for EVM makers").
 *
 * Vendored audited code, no npm at runtime:
 *   relay/vendor/noble/hashes — @noble/hashes 1.8.0 (keccak_256)
 *   relay/vendor/noble/curves — @noble/curves 1.9.7 (secp256k1.recoverPublicKey)
 * (see relay/vendor/noble/README.md for provenance + pinning)
 *
 * ---------------------------------------------------------------------------
 * NIGHTSPIRE RELAY EIP-712 CONVENTION v1
 * (relay wire convention, PROPOSED for the spec — spec v1 says "EIP-712 sig
 * over typed offer" but defines no typed schema, so the relay pins this one
 * and verifies against it; agents signing the evm slot MUST use this schema)
 * ---------------------------------------------------------------------------
 *   EIP712Domain(string name,string version,string giveChain)
 *     name      = "Nightspire Marketplace"
 *     version   = "1"
 *     giveChain = offer.giveChain (e.g. "base-sepolia")
 *                 Replay protection lives in our chain namespace — no
 *                 invented chain-id table (Robinhood testnet's id is not
 *                 pinned anywhere we can cite).
 *   CrossChainOffer(bytes32 termsHash)
 *     termsHash = keccak256(canonical offer bytes minus `signatures`)
 *                 — the exact bytes ed25519 makers sign (offerSignBytes),
 *                 hashed. Binds every offer term with one 32-byte field.
 *
 * Why hash-wrapped instead of full-field structs: makerAddr is not always an
 * EVM address on the want side, nested structs (takerCredential, fiatLeg) add
 * interop risk, and makers are agents (Spellbook) — human-readable wallet
 * rendering is not the goal. The domain separator still gives EIP-712's
 * replay protection across chains and deployments.
 *
 * Verification: ecrecover(digest, sig) must equal offer.makerAddr
 * (case-insensitive). Applies ONLY when giveChain is an EVM chain; the evm
 * slot on other chains stays UNVERIFIED (wrong slot for the chain).
 *
 * Trust posture (unchanged, spec §12): this is defense-in-depth edge
 * anti-spam. Agents MUST verify offer signatures locally; the relay check
 * is never the trust root.
 */

const { keccak_256 } = require('../vendor/noble/hashes/sha3.js');
const { secp256k1 } = require('../vendor/noble/curves/secp256k1.js');
const { canonicalize } = require('./canonical');

const DOMAIN_NAME = 'Nightspire Marketplace';
const DOMAIN_VERSION = '1';

/** EVM chains whose makers sign the evm slot (spec: "verifiers check the slot matching giveChain"). */
const EVM_CHAINS = new Set([
  'robinhood',
  'robinhood-testnet',
  'base',
  'base-sepolia',
  'ethereum',
  'ethereum-sepolia',
]);

function keccak256(bytes) {
  return Buffer.from(keccak_256(Buffer.from(bytes)));
}
function keccak256hex(bytes) {
  return keccak256(bytes).toString('hex');
}

/** Canonical offer signing bytes (minus `signatures`) — same as src/offer_sigs.js offerSignBytes. */
function offerTermsBytes(offer) {
  const { signatures: _dropped, ...rest } = offer;
  return Buffer.from(canonicalize(rest), 'utf8');
}

// ---------------------------------------------------------------------------
// Generic EIP-712 encoding (https://eips.ethereum.org/EIPS/eip-712)
// ---------------------------------------------------------------------------

function encodeType(primaryType, types) {
  const deps = new Set();
  const findDeps = (t) => {
    for (const f of types[t] || []) {
      const base = f.type.replace(/\[.*\]$/, '');
      if (types[base] && base !== t && !deps.has(base)) {
        deps.add(base);
        findDeps(base);
      }
    }
  };
  findDeps(primaryType);
  const ordered = [primaryType, ...[...deps].sort()];
  return ordered.map((t) => `${t}(${types[t].map((f) => `${f.type} ${f.name}`).join(',')})`).join('');
}

function typeHash(primaryType, types) {
  return keccak256(Buffer.from(encodeType(primaryType, types), 'utf8'));
}

function uint256Buf(n) {
  const b = BigInt(n);
  if (b < 0n) throw new Error('uint cannot be negative');
  const hex = b.toString(16).padStart(64, '0');
  if (hex.length > 64) throw new Error('uint exceeds 256 bits');
  return Buffer.from(hex, 'hex');
}

function encodeField(type, value, types) {
  if (types[type]) return structHash(type, value, types); // nested struct → structHash
  if (type === 'string') return keccak256(Buffer.from(String(value), 'utf8'));
  if (type === 'bytes') {
    const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value).replace(/^0x/, ''), 'hex');
    return keccak256(b);
  }
  const bytesN = type.match(/^bytes(\d+)$/);
  if (bytesN) {
    const n = Number(bytesN[1]);
    const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value).replace(/^0x/, ''), 'hex');
    if (b.length !== n) throw new Error(`bytes${n} must be ${n} bytes, got ${b.length}`);
    return b;
  }
  if (type === 'address') {
    const a = String(value).toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40}$/.test(a)) throw new Error(`invalid address ${value}`);
    return Buffer.concat([Buffer.alloc(12), Buffer.from(a, 'hex')]);
  }
  if (type === 'bool') return uint256Buf(value ? 1n : 0n);
  const uintM = type.match(/^uint(\d+)$/);
  if (uintM) {
    if (Number(uintM[1]) % 8 !== 0 || Number(uintM[1]) > 256 || Number(uintM[1]) === 0)
      throw new Error(`bad uint size ${type}`);
    return uint256Buf(typeof value === 'bigint' ? value : BigInt(String(value)));
  }
  throw new Error(`unsupported EIP-712 type ${type}`);
}

function encodeData(primaryType, message, types) {
  const fields = types[primaryType];
  if (!fields) throw new Error(`unknown EIP-712 type ${primaryType}`);
  const parts = [typeHash(primaryType, types)];
  for (const f of fields) {
    if (!(f.name in message)) throw new Error(`missing field ${primaryType}.${f.name}`);
    parts.push(encodeField(f.type, message[f.name], types));
  }
  return Buffer.concat(parts);
}

function structHash(primaryType, message, types) {
  return keccak256(encodeData(primaryType, message, types));
}

function domainSeparator(domain, domainTypes) {
  return structHash('EIP712Domain', domain, { EIP712Domain: domainTypes });
}

/** Final EIP-712 digest: keccak256(0x1901 ‖ domainSeparator ‖ structHash). */
function eip712Digest({ domain, domainTypes, primaryType, message, types }) {
  const ds = domainSeparator(domain, domainTypes);
  const sh = structHash(primaryType, message, types);
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), ds, sh]));
}

// ---------------------------------------------------------------------------
// Nightspire offer convention
// ---------------------------------------------------------------------------

const OFFER_DOMAIN_TYPES = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'giveChain', type: 'string' },
];
const OFFER_TYPES = {
  CrossChainOffer: [{ name: 'termsHash', type: 'bytes32' }],
};

function offerDomain(offer) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, giveChain: offer.giveChain };
}

function offerTermsHash(offer) {
  return keccak256(offerTermsBytes(offer));
}

/** EIP-712 signing digest for an offer under convention v1. */
function offerEip712Digest(offer) {
  return eip712Digest({
    domain: offerDomain(offer),
    domainTypes: OFFER_DOMAIN_TYPES,
    primaryType: 'CrossChainOffer',
    message: { termsHash: offerTermsHash(offer) },
    types: OFFER_TYPES,
  });
}

function parseSig(sigHex) {
  const h = String(sigHex).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]*$/.test(h)) throw new Error('signature is not hex');
  const sig = Buffer.from(h, 'hex');
  if (sig.length !== 65) throw new Error(`signature must be 65 bytes (r‖s‖v), got ${sig.length}`);
  let v = sig[64];
  if (v >= 27) v -= 27; // eth_signTypedData style v ∈ {27,28}
  if (v !== 0 && v !== 1) throw new Error(`bad recovery id v=${sig[64]}`);
  return { sig64: sig.subarray(0, 64), recovery: v };
}

/**
 * ecrecover: recover the signer address from (digest, sig).
 * Returns lowercase 0x-address. Throws on malformed input.
 */
function recoverAddress(digest, sigHex) {
  const d = Buffer.isBuffer(digest) ? digest : Buffer.from(String(digest).replace(/^0x/, ''), 'hex');
  if (d.length !== 32) throw new Error('digest must be 32 bytes');
  const { sig64, recovery } = parseSig(sigHex);
  // noble 'recovered' format: recovery byte FIRST, then 64-byte compact sig.
  // (this noble version's arg order is recoverPublicKey(signature, message))
  const noble = Buffer.concat([Buffer.from([recovery]), sig64]);
  const pub = Buffer.from(
    secp256k1.recoverPublicKey(new Uint8Array(noble), new Uint8Array(d))
  );
  // noble returns compressed (33B) by default; Ethereum needs uncompressed x‖y.
  let xy;
  if (pub.length === 65 && pub[0] === 0x04) xy = pub.subarray(1);
  else if (pub.length === 33 && (pub[0] === 0x02 || pub[0] === 0x03))
    xy = Buffer.from(secp256k1.Point.fromBytes(new Uint8Array(pub)).toBytes(false)).subarray(1);
  else throw new Error('unexpected recovered pubkey encoding');
  return '0x' + keccak256(xy).subarray(-20).toString('hex');
}

/**
 * Verify an offer's `signatures.evm` under convention v1.
 * Returns { status: 'VERIFIED'|'INVALID'|'UNVERIFIED'|'absent', reason?, recovered? }.
 */
function verifyOfferEip712(offer) {
  const sigHex = offer && offer.signatures && offer.signatures.evm;
  if (sigHex == null) return { status: 'absent' };
  if (!EVM_CHAINS.has(offer.giveChain))
    return {
      status: 'UNVERIFIED',
      reason: `evm slot is only verifiable for EVM giveChains; offer giveChain is '${offer.giveChain}' (agents MUST verify locally, spec §12)`,
    };
  const maker = String(offer.makerAddr || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(maker))
    return { status: 'INVALID', reason: 'makerAddr is not an EVM address — cannot match an ecrecover result' };
  try {
    const digest = offerEip712Digest(offer);
    const recovered = recoverAddress(digest, sigHex);
    if (recovered.toLowerCase() === maker) return { status: 'VERIFIED', recovered };
    return { status: 'INVALID', reason: `recovered ${recovered} != makerAddr ${maker}`, recovered };
  } catch (e) {
    return { status: 'INVALID', reason: `ecrecover failed: ${e.message}` };
  }
}

module.exports = {
  keccak256,
  keccak256hex,
  encodeType,
  typeHash,
  structHash,
  domainSeparator,
  eip712Digest,
  offerEip712Digest,
  offerTermsHash,
  recoverAddress,
  verifyOfferEip712,
  EVM_CHAINS,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  OFFER_DOMAIN_TYPES,
  OFFER_TYPES,
};

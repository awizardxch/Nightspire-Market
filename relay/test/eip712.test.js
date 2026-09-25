'use strict';

/**
 * relay/test/eip712.test.js — EIP-712 offer verification tests.
 *
 * Run:  node test/eip712.test.js   (from relay/)
 *
 * Trust anchors (all independent of the code under test):
 *  1. EIP-712 spec's Ether Mail example — known-answer signature from
 *     https://eips.ethereum.org/EIPS/eip-712 (fetched 2026-09-23). Validates
 *     encodeType/structHash/domainSeparator/digest + noble ecrecover.
 *  2. keccak-256 vectors from pycryptodome (independent C implementation).
 *  3. Offer round-trip signed by OpenSSL (independent ECDSA signer over the
 *     raw 32-byte digest; recovery id found by trial). Validates our
 *     Nightspire convention v2 schema end-to-end.
 */

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const eip712 = require('../src/eip712');
const { keccak256hex, eip712Digest, offerEip712DigestV2, recoverAddress, verifyOfferEip712 } = eip712;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// ---------------------------------------------------------------------------
// 1. EIP-712 spec Ether Mail known-answer
// ---------------------------------------------------------------------------

const MAIL_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  Person: [
    { name: 'name', type: 'string' },
    { name: 'wallet', type: 'address' },
  ],
  Mail: [
    { name: 'from', type: 'Person' },
    { name: 'to', type: 'Person' },
    { name: 'contents', type: 'string' },
  ],
};
const MAIL_DOMAIN = {
  name: 'Ether Mail',
  version: '1',
  chainId: 1,
  verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
};
const MAIL_MESSAGE = {
  from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
  to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
  contents: 'Hello, Bob!',
};
// Exact values from the EIP-712 spec example (https://eips.ethereum.org/EIPS/eip-712).
const MAIL_SIG =
  '0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c';
const MAIL_SIGNER = '0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826';

check('EIP-712 spec Ether Mail: ecrecover matches spec signer', () => {
  const digest = eip712Digest({
    domain: MAIL_DOMAIN,
    domainTypes: MAIL_TYPES.EIP712Domain,
    primaryType: 'Mail',
    message: MAIL_MESSAGE,
    types: MAIL_TYPES,
  });
  assert.strictEqual(digest.length, 32);
  const recovered = recoverAddress(digest, MAIL_SIG);
  assert.strictEqual(recovered, MAIL_SIGNER);
});

check('EIP-712 encodeType matches spec format', () => {
  assert.strictEqual(
    eip712.encodeType('Mail', MAIL_TYPES),
    'Mail(Person from,Person to,string contents)Person(string name,address wallet)'
  );
});

// ---------------------------------------------------------------------------
// 2. keccak-256 vectors (pycryptodome, independent)
// ---------------------------------------------------------------------------

check('keccak256 vectors match pycryptodome', () => {
  assert.strictEqual(
    keccak256hex(''),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
  );
  assert.strictEqual(
    keccak256hex('abc'),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'
  );
  assert.strictEqual(
    keccak256hex('a'.repeat(300)),
    '5b7e0e47a96f32a88b4f14ca177982790807c40e1a105742ba0fc1babe1ef826'
  );
});

// ---------------------------------------------------------------------------
// 3. Offer round-trip with an independent OpenSSL secp256k1 signer
// ---------------------------------------------------------------------------

/** Parse a DER ECDSA signature into { r, s } (32-byte big-endian each). */
function parseDerSig(der) {
  let o = 0;
  assert.strictEqual(der[o++], 0x30, 'DER: expected SEQUENCE');
  let seqLen = der[o++];
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let i = 0; i < n; i++) seqLen = (seqLen << 8) | der[o++];
  }
  const parts = [];
  for (let k = 0; k < 2; k++) {
    assert.strictEqual(der[o++], 0x02, 'DER: expected INTEGER');
    let len = der[o++];
    let v = der.subarray(o, o + len);
    o += len;
    if (v.length === 33 && v[0] === 0x00) v = v.subarray(1); // strip sign byte
    assert.strictEqual(v.length, 32, 'DER: integer must fit in 32 bytes');
    parts.push(v);
  }
  return { r: parts[0], s: parts[1] };
}

/**
 * Sign a raw 32-byte digest with an INDEPENDENT signer: libsecp256k1 via
 * coincurve (hasher=None signs the digest bytes directly, no re-hash).
 * NOTE: `openssl pkeyutl -sign -rawin` was tried first but does NOT sign the
 * raw input on this build (both noble and libsecp256k1 reject its output as
 * not matching the input digest), so it cannot serve as the oracle here.
 * Returns DER bytes; use parseDerSig for (r, s).
 */
function coincurveSignDigestRaw(keyPem, digest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eip712-'));
  try {
    const sigPath = path.join(dir, 'sig.der');
    const py = `
import subprocess, sys
from coincurve import PrivateKey
out = subprocess.run(['openssl','ec','-in',sys.argv[1],'-noout','-text'],capture_output=True,text=True).stdout
hexbytes = ''.join(l.strip() for l in out.split('priv:')[1].split('pub:')[0].split('\\n') if l.strip()).replace(':','')
priv = PrivateKey(bytes.fromhex(hexbytes))
open(sys.argv[3],'wb').write(priv.sign(open(sys.argv[2],'rb').read(), hasher=None))
`;
      const digPath = path.join(dir, 'digest.bin');
    fs.writeFileSync(digPath, digest);
    execFileSync('python3', ['-c', py, keyPem, digPath, sigPath]);
    return fs.readFileSync(sigPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeOffer(makerAddr) {
  return {
    offerId: 'offer-eip712-test-1',
    makerAddr,
    giveChain: 'base-sepolia',
    giveToken: 'ETH',
    giveAmount: '1000000000000000000',
    wantChain: 'solana',
    wantToken: 'SOL',
    wantAmount: '5000000000',
    expiry: 1790000000,
    nonce: '7',
    auction: null,
    takerCredential: null,
    fiatLeg: null,
  };
}

check('offer round-trip: libsecp256k1-signed EIP-712 offer verifies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eip712-'));
  try {
    const keyPem = path.join(dir, 'key.pem');
    const pubPem = path.join(dir, 'pub.pem');
    execFileSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', keyPem]);
    execFileSync('openssl', ['ec', '-in', keyPem, '-pubout', '-out', pubPem]);
    // Uncompressed pubkey via JWK coords (node:crypto, independent of noble).
    const keyObj = require('node:crypto').createPublicKey(fs.readFileSync(pubPem));
    const jwk = keyObj.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);
    const makerAddr = '0x' + keccak256hex(uncompressed.subarray(1)).slice(-40);

    const offer = makeOffer(makerAddr);
    const digest = offerEip712DigestV2(offer);
    assert.strictEqual(digest.length, 32);

    const der = coincurveSignDigestRaw(keyPem, digest);
    const { r, s } = parseDerSig(der);

    // Find the recovery id by trial (independent of our parser).
    let sigHex = null;
    for (const v of [27, 28]) {
      const cand = '0x' + Buffer.concat([r, s, Buffer.from([v])]).toString('hex');
      if (recoverAddress(digest, cand) === makerAddr) {
        sigHex = cand;
        break;
      }
    }
    assert.ok(sigHex, 'one of v=27/28 must recover the maker address');

    offer.signatures = { evm: sigHex };
    const res = verifyOfferEip712(offer);
    assert.strictEqual(res.status, 'VERIFIED', JSON.stringify(res));
    assert.strictEqual(res.recovered, makerAddr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Negative cases
// ---------------------------------------------------------------------------

check('tampered terms => INVALID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eip712-'));
  try {
    const keyPem = path.join(dir, 'key.pem');
    execFileSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', keyPem]);
    const offer = makeOffer('0x0000000000000000000000000000000000000000');
    const digest = offerEip712DigestV2(offer);
    const { r, s } = parseDerSig(coincurveSignDigestRaw(keyPem, digest));
    for (const v of [27, 28]) {
      const cand = '0x' + Buffer.concat([r, s, Buffer.from([v])]).toString('hex');
      try {
        offer.makerAddr = recoverAddress(digest, cand);
        offer.signatures = { evm: cand };
        break;
      } catch { /* try next v */ }
    }
    assert.ok(offer.signatures, 'setup: signature must recover some address');
    offer.wantAmount = '9999999999'; // tamper AFTER signing
    const res = verifyOfferEip712(offer);
    assert.strictEqual(res.status, 'INVALID');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('wrong makerAddr => INVALID', () => {
  const offer = makeOffer('0x1111111111111111111111111111111111111111');
  offer.signatures = {
    evm: '0x' + 'ab'.repeat(64) + '1b', // well-formed 65-byte sig, wrong key
  };
  const res = verifyOfferEip712(offer);
  assert.strictEqual(res.status, 'INVALID');
});

check('malformed sig (64 bytes) => INVALID', () => {
  const offer = makeOffer('0x1111111111111111111111111111111111111111');
  offer.signatures = { evm: '0x' + 'ab'.repeat(64) };
  const res = verifyOfferEip712(offer);
  assert.strictEqual(res.status, 'INVALID');
  assert.match(res.reason, /65 bytes/);
});

check('non-EVM giveChain => UNVERIFIED (not INVALID)', () => {
  const offer = makeOffer('SomeSolanaAddress11111111111111111111111111');
  offer.giveChain = 'solana';
  offer.signatures = { evm: '0x' + 'ab'.repeat(64) + '1b' };
  const res = verifyOfferEip712(offer);
  assert.strictEqual(res.status, 'UNVERIFIED');
});

check('absent evm sig => absent', () => {
  assert.strictEqual(verifyOfferEip712(makeOffer('0x1')).status, 'absent');
  const o = makeOffer('0x1');
  o.signatures = { ed25519: 'aa' };
  assert.strictEqual(verifyOfferEip712(o).status, 'absent');
});

check('offer digest is bound to giveChain (replay across chains fails)', () => {
  const a = offerEip712DigestV2(makeOffer('0x1111111111111111111111111111111111111111'));
  const bOffer = makeOffer('0x1111111111111111111111111111111111111111');
  bOffer.giveChain = 'robinhood-testnet';
  const b = offerEip712DigestV2(bOffer);
  assert.ok(!a.equals(b), 'digests must differ across giveChains');
});

console.log(`\n${passed} EIP-712 tests passed.`);

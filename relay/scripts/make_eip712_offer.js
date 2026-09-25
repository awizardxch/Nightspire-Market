#!/usr/bin/env node
'use strict';
/**
 * scripts/make_eip712_offer.js — build a genuinely EIP-712-signed offer for
 * the smoke test (Nightspire relay EIP-712 convention v2, see src/eip712.js).
 *
 * Flow: openssl keygen -> node derives EVM address + EIP-712 digest ->
 * libsecp256k1 (coincurve, INDEPENDENT signer) raw-signs the 32-byte digest ->
 * node finds the recovery id -> prints the complete offer JSON on stdout.
 *
 * Env: TMPD (scratch dir), EXPIRY (unix ts), OFFER_ID, NONCE.
 * Paths resolve relative to this script (relay/scripts/ -> relay/).
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RELAY_DIR = path.resolve(__dirname, '..');
const { offerEip712DigestV2, recoverAddress, keccak256hex } = require(path.join(RELAY_DIR, 'src', 'eip712'));

const tmpd = process.env.TMPD;
const expiry = Number(process.env.EXPIRY);
const offerId = process.env.OFFER_ID || 'smoke-offer-evm';
const nonce = process.env.NONCE || 'smoke-nonce-evm';
if (!tmpd || !expiry) {
  console.error('TMPD and EXPIRY env required');
  process.exit(1);
}

const keyPem = path.join(tmpd, 'key.pem');
execFileSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', keyPem],
  { stdio: ['ignore', 'ignore', 'ignore'] });

// EVM address = keccak256(uncompressed pubkey[1:])[-20:]
const pubPem = execFileSync('openssl', ['ec', '-in', keyPem, '-pubout'], { encoding: 'utf8' });
const jwk = crypto.createPublicKey(pubPem).export({ format: 'jwk' });
const uncompressed = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url'),
]);
const makerAddr = '0x' + keccak256hex(uncompressed.subarray(1)).slice(-40);

const offer = {
  version: 1,
  offerId,
  fillMode: 'solver',
  giveChain: 'base-sepolia',
  giveAsset: 'native',
  giveAmount: '1000000',
  wantChain: 'robinhood-testnet',
  wantAsset: 'native',
  wantAmount: '300000',
  minFillAmount: '1000',
  makerAddr,
  makerRecvAddr: '0xmakerrecv00000000000000000000000000000002',
  takerAddr: null,
  takerCredential: null,
  arbiter: null,
  fiatLeg: null,
  makerTimelockSec: 7200,
  takerTimelockSec: 3600,
  commitWindowSec: 3600,
  auctionWindowSec: 60,
  auctionFloorBps: 500,
  expiry,
  nonce,
  signatures: {},
};

const digest = offerEip712DigestV2(offer);
const digPath = path.join(tmpd, 'digest.bin');
const sigPath = path.join(tmpd, 'sig.der');
fs.writeFileSync(digPath, digest);

// Independent raw ECDSA signing via libsecp256k1 (coincurve, hasher=None =
// sign the 32 digest bytes directly). See test/eip712.test.js for why
// `openssl pkeyutl -sign -rawin` is NOT used (it does not sign raw input).
const py = [
  'import subprocess, sys',
  'from coincurve import PrivateKey',
  "out = subprocess.run(['openssl','ec','-in',sys.argv[1],'-noout','-text'],capture_output=True,text=True).stdout",
  "hexbytes = ''.join(l.strip() for l in out.split('priv:')[1].split('pub:')[0].split(chr(10)) if l.strip()).replace(':','')",
  'priv = PrivateKey(bytes.fromhex(hexbytes))',
  "open(sys.argv[3],'wb').write(priv.sign(open(sys.argv[2],'rb').read(), hasher=None))",
].join('\n');
execFileSync('python3', ['-c', py, keyPem, digPath, sigPath]);

// DER -> (r, s)
const der = fs.readFileSync(sigPath);
let o = 2;
const ints = [];
for (let k = 0; k < 2; k++) {
  o++; // INTEGER tag
  const len = der[o++];
  let v = der.subarray(o, o + len);
  o += len;
  if (v.length === 33 && v[0] === 0x00) v = v.subarray(1);
  if (v.length !== 32) throw new Error('bad DER integer length');
  ints.push(v);
}

// Find the recovery id by trial (proves the sig really recovers makerAddr).
let sigHex = null;
for (const v of [27, 28]) {
  const cand = '0x' + Buffer.concat([...ints, Buffer.from([v])]).toString('hex');
  if (recoverAddress(digest, cand) === makerAddr) {
    sigHex = cand;
    break;
  }
}
if (!sigHex) throw new Error('no recovery id recovered makerAddr — signer/verifier mismatch');

offer.signatures = { evm: sigHex };
console.log(JSON.stringify(offer));

'use strict';

/**
 * src/signer.js — REAL ed25519 relay identity (not stubbed).
 *
 * Per spec §12 (Spoofing): every relay message is signed with the relay
 * identity keypair; agents pin the pubkey (shipped in config, rotated
 * out-of-band only). A spoofed relay cannot forge these signatures.
 *
 * Keypair is generated on first boot and persisted at data/relay-key.json
 * (0600). Agents should pin the public key shown by GET /v1/health
 * (or GET /v1/relay-pubkey).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize } = require('./canonical');

class RelaySigner {
  constructor(keyPath) {
    this.keyPath = keyPath;
    this._loadOrCreate();
  }

  _loadOrCreate() {
    const dir = path.dirname(this.keyPath);
    fs.mkdirSync(dir, { recursive: true });
    let stored;
    if (fs.existsSync(this.keyPath)) {
      stored = JSON.parse(fs.readFileSync(this.keyPath, 'utf8'));
      if (stored.alg !== 'ed25519' || !stored.privateKeyDerHex || !stored.publicKeyDerHex) {
        throw new Error(`relay key file ${this.keyPath} is malformed — refusing to boot`);
      }
    } else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      stored = {
        alg: 'ed25519',
        createdAt: new Date().toISOString(),
        note: 'Nightspire cross-chain marketplace relay identity. PIN the public key, rotate out-of-band only (spec §12).',
        privateKeyDerHex: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex'),
        publicKeyDerHex: publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
      };
      fs.writeFileSync(this.keyPath, JSON.stringify(stored, null, 2), { mode: 0o600 });
      fs.chmodSync(this.keyPath, 0o600);
    }
    this.privateKey = crypto.createPrivateKey({
      key: Buffer.from(stored.privateKeyDerHex, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    this.publicKey = crypto.createPublicKey({
      key: Buffer.from(stored.publicKeyDerHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    this.publicKeyDerHex = stored.publicKeyDerHex;
    this.createdAt = stored.createdAt;
  }

  /** Sign an object (canonical JSON bytes) or raw bytes → hex signature. */
  sign(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonicalize(value), 'utf8');
    return crypto.sign(null, bytes, this.privateKey).toString('hex');
  }

  /** Verify an object's canonical bytes against a hex signature + this pubkey. */
  verify(value, sigHex) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonicalize(value), 'utf8');
    return crypto.verify(null, bytes, this.publicKey, Buffer.from(sigHex, 'hex'));
  }

  /** Verify with an arbitrary DER-hex pubkey (for third-party messages). */
  static verifyWith(value, sigHex, publicKeyDerHex) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonicalize(value), 'utf8');
    const pub = crypto.createPublicKey({
      key: Buffer.from(publicKeyDerHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, bytes, pub, Buffer.from(sigHex, 'hex'));
  }

  identity() {
    return { alg: 'ed25519', publicKeyDerHex: this.publicKeyDerHex, createdAt: this.createdAt };
  }
}

module.exports = { RelaySigner };

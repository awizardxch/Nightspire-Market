# relay/vendor/noble — vendored cryptography

Pure-JS, audited cryptography vendored so the relay verifies EIP-712 offer
signatures with **zero runtime dependencies** (no npm install, no native
modules, no registry access at deploy time).

## What is vendored

| Package | Version | Used for |
|---|---|---|
| `@noble/hashes` | **1.8.0** (exact) | `keccak_256` (EIP-712 digest, Ethereum address derivation) |
| `@noble/curves` | **1.9.7** (exact) | `secp256k1.recoverPublicKey` (ecrecover) |

Files are the upstream `package/*.js` CommonJS builds, byte-identical except:
- `require("@noble/hashes/...")` rewritten to relative paths inside this tree
- `//# sourceMappingURL=` comments stripped

Version pairing matters: `@noble/curves@1.9.7` declares
`"@noble/hashes": "1.8.0"` as its dependency (its `abstract/weierstrass.js`
calls `ahash()`, which does not exist in `@noble/hashes@1.7.x`).

## Provenance

- Source: https://registry.npmjs.org (npm public registry)
- `@noble/hashes/-/hashes-1.8.0.tgz`
- `@noble/curves/-/curves-1.9.7.tgz`
- Vendored 2026-09-23. Both packages are MIT-licensed, single-author
  (paulmillr), widely audited, and dependency-free upstream.

To re-vendor or audit: download the tarballs above, extract `package/`,
keep only the files listed below, rewrite `@noble/hashes` requires to
relative paths, and re-run `node test/eip712.test.js` — it pins keccak-256
against pycryptodome vectors and ecrecover against the EIP-712 spec's
Ether Mail known-answer signature.

## Files

```
hashes/
  sha3.js      keccak_256 / sha3_256 / Keccak
  sha2.js      sha256 / sha512 (pulled in by curves' hmac-drbg path)
  sha256.js    sha2 dependency
  sha512.js    sha2 dependency
  hmac.js      curves dependency
  utils.js     createHasher, toBytes, ahash, ...
  _assert.js   utils dependency
  _u64.js      64-bit int helpers
  _md.js       Merkle–Damgård padding (sha2 dependency)
  crypto.js    getRandomValues shim (utils dependency; unused at runtime here)
curves/
  secp256k1.js
  _shortw_utils.js
  utils.js
  abstract/
    weierstrass.js  ECDSA sign/verify/recover
    curve.js
    modular.js
    hash-to-curve.js
```

## Behavioral notes found while integrating (2026-09-23)

- `secp256k1.recoverPublicKey(signature, message)` — **signature first** in
  this version (older docs show `(message, signature)`).
- It returns the **compressed** (33-byte) pubkey by default; decompress via
  `secp256k1.Point.fromBytes(...).toBytes(false)` for Ethereum's
  `keccak(x‖y)[-20:]` address derivation.
- `secp256k1.verify` **rejects high-S signatures by default**
  (`lowS: true` curve default; override with `{ lowS: false }`). Recovery
  (`recoverPublicKey`) has no such gate. Our relay verifies EVM offers via
  **recovery + address comparison**, so both S parities are accepted —
  matching what `eth_signTypedData` wallets produce.

## What is NOT vendored (deliberate)

- **BLS12-381** (`@noble/curves` ships a `bls12-381.js`, intentionally not
  vendored): the spec's offer format carries no BLS public key
  (`signatures.chia` is a bare signature string; `makerAddr` is not
  necessarily a BLS key), so relay-side Chia verification is infeasible
  without a spec change. It stays honestly `UNVERIFIED` — see
  `src/offer_sigs.js`. Vendoring the code would imply a verification
  capability we cannot soundly wire up.

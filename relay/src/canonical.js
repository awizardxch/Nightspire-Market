'use strict';

/**
 * Canonical JSON encoding (sorted keys, no whitespace) — used for:
 *  - the hash-chained log:  hash = sha256(prevHash || canonicalJson(payload))
 *  - relay message signing:  ed25519 over canonical bytes
 *
 * Deterministic across runs so any party can recompute and verify.
 * Numbers must be finite; BigInt is not JSON-encodable — serialize as string.
 */
function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

module.exports = { canonicalize };

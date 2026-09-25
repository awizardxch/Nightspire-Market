#!/usr/bin/env node
'use strict';
/* Seed sample offers on a Nightspire relay (e.g. a fresh Railway deploy).
 *
 * Usage: node scripts/seed_offers.js [RELAY_BASE]
 *        RELAY_BASE env var also works. Defaults to http://localhost:8787.
 *
 * Posts two signed sample offers (one ed25519/EVM-style, one Solana-style)
 * with 30-day expiries — the same construction the smoke test uses, so both
 * land with VERIFIED signature statuses. Idempotent: offers that already
 * exist (HTTP 409) are skipped.
 *
 * Run from the relay/ directory (it requires ../src/*).
 */
const crypto = require('node:crypto');
const { offerSignBytes, base58Encode } = require('../src/offer_sigs');

const BASE = (process.argv[2] || process.env.RELAY_BASE || 'http://localhost:8787').replace(/\/+$/, '');

function makeOffer({ offerId, kind, expiry }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' });
  const raw32 = raw.subarray(raw.length - 32);
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
    makerAddr: kind === 'solana' ? base58Encode(raw32) : '0xmaker000000000000000000000000000000000001',
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
    nonce: `${offerId}-nonce`,
    signatures: {},
  };
  const bytes = offerSignBytes(offer);
  const sig = crypto.sign(null, bytes, privateKey).toString('hex');
  if (kind === 'solana') offer.signatures.solana = sig;
  else offer.signatures.ed25519 = { pubkey: raw.toString('hex'), sig };
  return offer;
}

async function main() {
  const expiry = Math.floor(Date.now() / 1000) + 30 * 86400; // 30 days
  const offers = [
    makeOffer({ offerId: 'sample-offer-evm', kind: 'ed25519', expiry }),
    makeOffer({ offerId: 'sample-offer-sol', kind: 'solana', expiry }),
  ];
  for (const offer of offers) {
    const res = await fetch(`${BASE}/v1/offers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(offer),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 201) {
      const verified = Object.entries(body.signatureStatuses || {})
        .filter(([, v]) => v === 'VERIFIED')
        .map(([k]) => k)
        .join(',');
      console.log(`posted ${offer.offerId} (verified: ${verified || 'none'})`);
    } else if (res.status === 409) {
      console.log(`exists ${offer.offerId} — skipped`);
    } else {
      console.error(`FAILED ${offer.offerId}: HTTP ${res.status}`, JSON.stringify(body));
      process.exitCode = 1;
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });

'use strict';

/**
 * relay/test/venue_views.test.js — OpenAPI view adapter tests.
 *
 * Run:  node test/venue_views.test.js   (from relay/)
 *
 * Covers the venue-api/openapi.yaml projection layer (src/venue_views.js):
 * OfferList pagination/filtering, OfferDetail {offer, fills}, AuctionView
 * shape + status mapping, and the enum-constrained status/phase derivations.
 * Uses the real OfferStore + AuctionBook so the adapters are tested against
 * the actual internal shapes, not fixtures.
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { OfferStore } = require('../src/store');
const { AuctionBook } = require('../src/auctions');
const { RelaySigner } = require('../src/signer');
const venue = require('../src/venue_views');

function makeOffer(overrides = {}) {
  return {
    version: 1,
    offerId: 'test-offer-1',
    fillMode: 'direct',
    giveChain: 'base',
    giveAsset: 'native',
    giveAmount: '1000000',
    wantChain: 'solana',
    wantAsset: 'native',
    wantAmount: '500000',
    minFillAmount: '1000',
    makerAddr: '0x1234567890abcdef1234567890abcdef12345678',
    makerRecvAddr: '0x1234567890abcdef1234567890abcdef12345678',
    takerAddr: null,
    takerCredential: null,
    arbiter: null,
    fiatLeg: null,
    hashlock: null,
    makerTimelockSec: 7200,
    takerTimelockSec: 3600,
    commitWindowSec: 300,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    nonce: 'n1',
    signatures: { ed25519: { signature: 'aa', publicKeyDerHex: 'bb' } },
    ...overrides,
  };
}

async function main() {
  // ---- OfferList: empty board ----
  {
    const store = new OfferStore();
    const list = venue.offerList(store, store.allStates(), {});
    assert.deepStrictEqual(list, { offers: [], page: 1, limit: 20, total: 0 });
    console.log('ok: OfferList empty board');
  }

  // ---- OfferList: shape, pagination, filters ----
  {
    const store = new OfferStore();
    const chains = ['base', 'solana', 'chia'];
    for (let i = 0; i < 5; i++) {
      store.addOffer(makeOffer({ offerId: `o-${i}`, giveChain: chains[i % 3] }));
    }
    const states = store.allStates();
    assert.strictEqual(states.length, 5);

    const p1 = venue.offerList(store, states, { page: '1', limit: '2' });
    assert.strictEqual(p1.page, 1);
    assert.strictEqual(p1.limit, 2);
    assert.strictEqual(p1.total, 5);
    assert.strictEqual(p1.offers.length, 2);
    assert.strictEqual(p1.offers[0].offerId, 'o-0');

    const p3 = venue.offerList(store, states, { page: '3', limit: '2' });
    assert.strictEqual(p3.offers.length, 1);
    assert.strictEqual(p3.offers[0].offerId, 'o-4');

    const filtered = venue.offerList(store, states, { giveChain: 'solana' });
    assert.strictEqual(filtered.total, 2);
    assert.ok(filtered.offers.every((o) => o.giveChain === 'solana'));

    const mediated = venue.offerList(store, states, { mediated: 'true' });
    assert.strictEqual(mediated.total, 0);
    const unmediated = venue.offerList(store, states, { mediated: 'false' });
    assert.strictEqual(unmediated.total, 5);
    console.log('ok: OfferList pagination + filters');
  }

  // ---- OfferWithAdvisory: contract fields ----
  {
    const store = new OfferStore();
    store.addOffer(makeOffer());
    const state = store.getState('test-offer-1');
    const owa = venue.offerWithAdvisory(store, state);
    // OpenAPI types: expiry is a string in the contract.
    assert.strictEqual(typeof owa.expiry, 'string');
    assert.deepStrictEqual(owa.advisory, {
      filledAmount: '0',
      reservedAmount: '0',
      remainingAmount: '1000000',
      status: 'open',
      updatedAt: owa.advisory.updatedAt,
    });
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(owa.advisory.updatedAt), 'updatedAt is ISO-8601');
    assert.deepStrictEqual(owa.badges, {
      isMediated: false,
      hasFiatLeg: false,
      validationStatus: { give: 'unregistered', want: 'unregistered' },
    });
    console.log('ok: OfferWithAdvisory fields');
  }

  // ---- badges: mediated + fiat leg ----
  {
    const store = new OfferStore();
    store.addOffer(
      makeOffer({
        offerId: 'm1',
        arbiter: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        fiatLeg: { currency: 'USD', rails: 'ach', providerId: 'ramp-1' },
      })
    );
    const b = venue.badgesFor(store.getState('m1').offer);
    assert.strictEqual(b.isMediated, true);
    assert.strictEqual(b.hasFiatLeg, true);
    console.log('ok: badges mediated/fiat');
  }

  // ---- status derivation: filling / filled / expired ----
  {
    const store = new OfferStore();
    store.addOffer(makeOffer({ offerId: 's1' }));
    const state = store.getState('s1');
    // filling: reservation present
    state.reservations.push({ fillNonce: 'n', f: 100n, reservedUntil: Math.floor(Date.now() / 1000) + 60 });
    assert.strictEqual(venue.offerStatusFor(store, state, Math.floor(Date.now() / 1000)), 'filling');
    state.reservations = [];
    // filled
    state.filledAmount = 1000000n;
    assert.strictEqual(venue.offerStatusFor(store, state, Math.floor(Date.now() / 1000)), 'filled');
    // expired
    state.filledAmount = 0n;
    state.offer.expiry = Math.floor(Date.now() / 1000) - 10;
    assert.strictEqual(venue.offerStatusFor(store, state, Math.floor(Date.now() / 1000)), 'expired');
    console.log('ok: OfferStatus derivation (filling/filled/expired)');
  }

  // ---- OfferDetail {offer, fills} + FillView phases ----
  {
    const store = new OfferStore();
    store.addOffer(makeOffer({ offerId: 'd1' }));
    const state = store.getState('d1');
    state.fills.set('fill-1', {
      fillNonce: 'fn1',
      f: 5000n,
      makerLocked: false,
      takerLocked: false,
      filled: false,
      proofs: { maker: null, taker: null },
    });
    const detail = venue.offerDetail(store, state);
    assert.ok(detail.offer);
    assert.strictEqual(detail.offer.offerId, 'd1');
    assert.strictEqual(detail.fills.length, 1);
    const fv = detail.fills[0];
    assert.strictEqual(fv.fillId, 'fill-1');
    assert.strictEqual(fv.offerId, 'd1');
    assert.strictEqual(fv.f, '5000');
    assert.strictEqual(fv.phase, 'committed');
    assert.strictEqual(fv.counterpartyAddr, null);
    assert.strictEqual(fv.hashlock, null);
    assert.strictEqual(fv.makerTimelockSec, 7200);
    assert.strictEqual(fv.takerTimelockSec, 3600);
    assert.deepStrictEqual(fv.lockProofs, { makerLock: null, takerLock: null });
    // phase transitions
    const fill = state.fills.get('fill-1');
    fill.makerLocked = true;
    assert.strictEqual(venue.fillView(state.offer, 'fill-1', fill, state).phase, 'makerLocked');
    fill.takerLocked = true;
    assert.strictEqual(venue.fillView(state.offer, 'fill-1', fill, state).phase, 'takerLocked');
    fill.filled = true;
    assert.strictEqual(venue.fillView(state.offer, 'fill-1', fill, state).phase, 'claimed');
    // hashlock from maker proof
    fill.proofs.maker = { txid: '0xabc', h: 'aa'.repeat(32), mirroredAt: 1, chainVerified: false,
      verification: { status: 'confirmed', confirmedAt: 2, evidence: { blockHeight: 42 } } };
    const fv2 = venue.fillView(state.offer, 'fill-1', fill, state);
    assert.strictEqual(fv2.hashlock, 'aa'.repeat(32));
    assert.deepStrictEqual(fv2.lockProofs.makerLock, { txid: '0xabc', blockHeight: 42 });
    console.log('ok: OfferDetail + FillView phases');
  }

  // ---- AuctionView ----
  {
    const store = new OfferStore();
    store.addOffer(makeOffer({ offerId: 'a1', fillMode: 'solver' }));
    const signer = new RelaySigner(path.join(os.tmpdir(), `venue-views-test-key-${process.pid}.json`)); // ephemeral test key
    const book = new AuctionBook(signer);
    const opened = book.open('a1', { startPrice: '100', auctionWindowSec: 10, auctionFloorBps: 1000, lockWindowSec: 60 });
    assert.ok(opened.ok);
    const id = opened.auction.auctionId;
    book.tick(id);
    book.tick(id);
    const view = venue.auctionView(book.get(id));
    assert.strictEqual(view.auctionId, id);
    assert.strictEqual(view.offerId, 'a1');
    assert.strictEqual(view.status, 'open');
    assert.strictEqual(view.ticks.length, 2);
    assert.deepStrictEqual(view.acceptances, []);
    assert.strictEqual(view.outcome, null);
    assert.strictEqual(view.winnerRule, 'sort (tick ASC, sha256(fillerAddr) ASC)');
    for (const t of view.ticks) {
      for (const k of ['auctionId', 'tick', 'price', 'prevTickHash', 'relaySig'])
        assert.ok(t[k] !== undefined, `tick missing ${k}`);
      assert.ok(/^\d+$/.test(t.price), `tick price not a base-unit integer: ${t.price}`);
    }
    // decided -> settled mapping
    book.get(id).status = 'decided';
    book.get(id).outcome = {
      winner: '0xfiller', winningTick: 1, f: '100',
      exclusiveWindow: { start: 1, end: 2 }, relaySig: 'ff'.repeat(64),
    };
    const v2 = venue.auctionView(book.get(id));
    assert.strictEqual(v2.status, 'settled');
    assert.deepStrictEqual(v2.outcome, {
      winner: '0xfiller', winningTick: 1, f: '100',
      exclusiveWindow: { start: 1, end: 2 }, relaySig: 'ff'.repeat(64),
    });
    console.log('ok: AuctionView shape + status mapping');
  }

  console.log('\nvenue_views: all tests passed');
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});

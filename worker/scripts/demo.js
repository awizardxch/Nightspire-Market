/**
 * scripts/demo.js — FULL local direct swap (spec §3.1) against anvil.
 *
 * Happy path:
 *   taker commitment -> maker atomic reserve + signed ack -> maker lock (fresh s,h,T1)
 *   -> taker verifies HTLC_A on-chain -> taker lock (T2<T1, same h)
 *   -> maker watcher sees taker lock -> withdraw(s) on B
 *   -> taker reads s from Withdrawn event -> withdraw(s) on A
 *   -> assert end balances.
 * Refund path:
 *   maker locks, taker never locks, warp time past T1, refund() -> maker whole.
 *
 * TEST TIMELocks: T1=120s / T2=60s — test-only, documented (spec §9 wants 6h/3h).
 * Single anvil node simulates two chains via two factory instances (documented).
 *
 * Usage: node scripts/demo.js [--rpc http://127.0.0.1:8545] [--data ./data]
 */
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert';
import { parseEther, formatEther } from 'viem';
import {
  loadArtifacts, chainEndpoint, loadAnvilKeys, ZERO_ADDRESS,
  getBalance, increaseTime, latestTimestamp,
} from '../src/chain.js';
import { ReservationLedger } from '../src/reservations.js';
import { SwapWatcher, PHASE } from '../src/watcher.js';
import { MakerWorker } from '../src/maker.js';
import { TakerWorker } from '../src/taker.js';
import { fillIdFor, sleep } from '../src/util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const argv = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : (process.env[flag.replace(/^--/, '').toUpperCase()] || def);
};
const rpc = argv('--rpc', 'http://127.0.0.1:8545');
const dataDir = resolve(ROOT, argv('--data', './data'));
if (process.argv.includes('--fresh')) rmSync(dataDir, { recursive: true, force: true });

const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8'));
const artifacts = loadArtifacts();
const A = chainEndpoint({ rpcUrl: rpc, factoryAddress: deployments.chainA.factory, label: 'chainA' });
const B = chainEndpoint({ rpcUrl: rpc, factoryAddress: deployments.chainB.factory, label: 'chainB' });

// Role accounts — anvil default throwaway keys ONLY (documented test accounts,
// loaded from the key file written by demo.sh so they match this anvil instance).
const KEYS = loadAnvilKeys(6);
const makerLock = A.accountFor(KEYS[1]); // funds + locks on A; makerAddr/refundAddr
const makerRecv = A.accountFor(KEYS[2]); // receiver on B — never transacts (exact assertions)
const takerLock = B.accountFor(KEYS[3]); // funds + locks on B; refundAddr on B
const takerRecv = B.accountFor(KEYS[4]); // receiver on A — never transacts (exact assertions)
const settleAcct = A.accountFor(KEYS[5]); // pays claim/refund gas (anyone may trigger; payout is hardcoded)

console.log('role accounts:');
for (const [n, a] of [['makerLock', makerLock], ['makerRecv', makerRecv], ['takerLock', takerLock], ['takerRecv', takerRecv]]) {
  console.log(`  ${n}: ${a.address}  balance=${formatEther(await getBalance(A, a.address))} ETH`);
}

// TEST-ONLY short timelocks (spec §9 production: 6h/3h).
const T1 = 120, T2 = 60, W = 300;

function makeOffer(offerId, total) {
  return {
    offerId, version: 1, fillMode: 'direct',
    giveChain: 'chainA', giveAsset: 'native', giveAmount: total.toString(),
    wantChain: 'chainB', wantAsset: 'native', wantAmount: (BigInt(total) * 9n / 10n).toString(), // 0.9 rate
    minFillAmount: parseEther('0.1').toString(),
    makerAddr: makerLock.address,
    makerRecvAddr: makerRecv.address,
    takerAddr: null, takerCredential: null, arbiter: null, fiatLeg: null,
    makerTimelockSec: T1, takerTimelockSec: T2, commitWindowSec: W,
    expiry: String(Math.floor(Date.now() / 1000) + 86400),
    nonce: offerId.slice(0, 8),
  };
}

async function buildMaker(workerId, makerId, offer) {
  const ledger = new ReservationLedger({ makerId, dataDir });
  await ledger.start();
  const watcher = new SwapWatcher({ workerId, dataDir, chains: { A, B }, artifacts, onTick: () => {}, pollIntervalMs: 1000 });
  await watcher.start();
  const maker = new MakerWorker({ workerId, ledger, watcher, chains: { A, B }, artifacts, lockAccount: makerLock, settleAccount: settleAcct, recvAddress: makerRecv.address, offer });
  watcher.onTick = (swap, ctx) => maker._onTick(swap, ctx);
  ledger.addOffer({ offerId: offer.offerId, total: offer.giveAmount, minFillAmount: offer.minFillAmount, commitWindowSec: offer.commitWindowSec });
  maker.reconcileLedger(); // idempotent: terminal swaps recovered across restarts update the ledger
  return { ledger, watcher, maker };
}

function buildTaker(workerId) {
  const watcher = new SwapWatcher({ workerId, dataDir, chains: { A, B }, artifacts, onTick: () => {}, pollIntervalMs: 1000 });
  const taker = new TakerWorker({ workerId, watcher, chains: { A, B }, artifacts, lockAccount: takerLock, recvAddress: takerRecv.address });
  watcher.onTick = (swap, ctx) => taker._onTick(swap, ctx);
  return { watcher, taker };
}

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
};

// ================= HAPPY PATH =================
const balMakerRecv0 = await getBalance(B, makerRecv.address);
const balTakerRecv0 = await getBalance(A, takerRecv.address);

console.log('\n=== happy path: full direct swap ===');
{
  const offer = makeOffer('offer-happy-001', parseEther('1'));
  const { ledger, watcher: mwatch, maker } = await buildMaker('demo-maker', 'demo-maker', offer);
  const { watcher: twatch, taker } = await buildTaker('demo-taker');
  await twatch.start();

  const f = parseEther('1');
  const fillId = fillIdFor(offer.offerId, 'fill-1');

  // 2. COMMIT — taker signs, maker atomically reserves + signs ack
  const commitment = await taker.signCommitment({ offerId: offer.offerId, f, fillNonce: 'fill-1' });
  const res = await maker.handleCommitment(commitment);
  check('commitment accepted with signed ack', res.ok && !!res.ack.signature, `reservedUntil=${new Date(res.ack.reservedUntil).toISOString()}`);
  check('ledger remaining == 0 after full reservation', ledger.remaining(offer.offerId) === 0n);

  // 3. MAKER LOCK — fresh s, HTLC_A with T1
  const lockProof = await maker.lock(fillId, { t1Sec: T1 });
  check('maker locked HTLC_A', !!lockProof.escrowA, `escrow=${lockProof.escrowA} h=${lockProof.h.slice(0, 12)}…`);

  // 4. TAKER LOCK — verify HTLC_A on-chain, then HTLC_B with T2 < T1
  const takerLockRes = await taker.verifyAndLock(lockProof, offer, { t2Sec: T2 });
  check('taker locked HTLC_B after on-chain verification', !!takerLockRes.escrowB, `escrow=${takerLockRes.escrowB}`);

  // 5. MAKER CLAIM — watcher sees taker lock, withdraw(s) on B (reveals s)
  const mFinal = await maker.waitForSettled(fillId, { timeoutMs: 60000 });
  check('maker claimed on B', mFinal.phase === PHASE.CLAIMED, `phase=${mFinal.phase}`);

  // 6. TAKER CLAIM — reads s from Withdrawn event, withdraw(s) on A
  const tFinal = await taker.waitForSettled(fillId, { timeoutMs: 60000 });
  check('taker claimed on A', tFinal.phase === PHASE.CLAIMED, `phase=${tFinal.phase}`);

  // 7. SETTLED — assert end balances (receiver accounts never transact: deltas exact)
  const makerGot = (await getBalance(B, makerRecv.address)) - balMakerRecv0;
  const takerGot = (await getBalance(A, takerRecv.address)) - balTakerRecv0;
  check('maker got 0.9 ETH on B', makerGot === parseEther('0.9'), `delta=${formatEther(makerGot)}`);
  check('taker got 1.0 ETH on A', takerGot === parseEther('1'), `delta=${formatEther(takerGot)}`);
  check('HTLC_A escrow empty', await getBalance(A, lockProof.escrowA) === 0n);
  check('HTLC_B escrow empty', await getBalance(B, takerLockRes.escrowB) === 0n);
  check('offer fully filled in ledger', ledger.remaining(offer.offerId) === 0n && ledger.activeReservations(offer.offerId).length === 0);

  await mwatch.stop(); await twatch.stop(); await ledger.stop();
}

// ================= REFUND PATH =================
console.log('\n=== refund path: taker ghosts, maker refunds after T1 ===');
{
  const offer = makeOffer('offer-refund-001', parseEther('1'));
  const { ledger, watcher: mwatch, maker } = await buildMaker('demo-maker2', 'demo-maker2', offer);
  const { watcher: twatch, taker } = await buildTaker('demo-taker2');
  await twatch.start();

  const f = parseEther('0.5');
  const fillId = fillIdFor(offer.offerId, 'fill-1');
  const commitment = await taker.signCommitment({ offerId: offer.offerId, f, fillNonce: 'fill-1' });
  const res = await maker.handleCommitment(commitment);
  check('refund-path commitment accepted', res.ok);

  const lockProof = await maker.lock(fillId, { t1Sec: T1 });
  const balAfterLock = await getBalance(A, makerLock.address);

  // taker never locks — warp past T1 (TEST ONLY: anvil evm_increaseTime)
  console.log(`  warping +${T1 + 60}s past T1…`);
  await increaseTime(A, T1 + 60);
  const mFinal = await maker.waitForSettled(fillId, { timeoutMs: 60000 });
  check('maker refunded after T1', mFinal.phase === PHASE.REFUNDED, `phase=${mFinal.phase}`);

  const balAfterRefund = await getBalance(A, makerLock.address);
  check('maker whole: refund returned exactly f', balAfterRefund - balAfterLock === f,
    `delta=${formatEther(balAfterRefund - balAfterLock)} ETH`);
  check('HTLC_A escrow empty after refund', await getBalance(A, lockProof.escrowA) === 0n);
  check('reservation released back to pool', ledger.remaining(offer.offerId) === parseEther('1'));

  await mwatch.stop(); await twatch.stop(); await ledger.stop();
}

console.log('\n=== summary ===');
const fails = results.filter((r) => !r.pass);
console.log(`${results.length - fails.length}/${results.length} checks passed`);
if (fails.length > 0) { console.log('FAILURES:', fails.map((f) => f.name).join(', ')); process.exitCode = 1; }

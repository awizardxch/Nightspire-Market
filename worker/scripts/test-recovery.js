/**
 * scripts/test-recovery.js — watcher restart recovery (§10):
 * "chain is truth — never trust the persisted phase over fresh chain reads."
 *
 *  A. Stale persisted phase: maker locks on A, then the swap store is tampered
 *     to claim phase='committed' with no escrowA. A restarted watcher must
 *     re-derive makerLocked from chain (fillId scan) and rediscover escrowA;
 *     then warp past T1 and the recovered maker refunds.
 *  B. Taker crash after maker revealed s: taker locks on B, maker claims B,
 *     taker worker "crashes" before its claim. A restarted taker watcher must
 *     re-derive takerLocked + the preimage from the Withdrawn event and
 *     re-submit the claim on A.
 *
 * Needs anvil + deployments.json (run via scripts/demo.sh, which keeps anvil up).
 * Usage: node scripts/test-recovery.js [--rpc ...] [--data ./data-recovery]
 */
import { readFileSync, appendFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseEther, formatEther } from 'viem';
import {
  loadArtifacts, chainEndpoint, loadAnvilKeys, getBalance, increaseTime,
} from '../src/chain.js';
import { ReservationLedger } from '../src/reservations.js';
import { SwapWatcher, PHASE } from '../src/watcher.js';
import { MakerWorker } from '../src/maker.js';
import { TakerWorker } from '../src/taker.js';
import { fillIdFor } from '../src/util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const argv = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const rpc = argv('--rpc', process.env.ANVIL_RPC || 'http://127.0.0.1:8545');
const dataDir = resolve(ROOT, argv('--data', './data-recovery'));
rmSync(dataDir, { recursive: true, force: true }); // fresh chain per run => fresh state

const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8'));
const artifacts = loadArtifacts();
const A = chainEndpoint({ rpcUrl: rpc, factoryAddress: deployments.chainA.factory, label: 'chainA' });
const B = chainEndpoint({ rpcUrl: rpc, factoryAddress: deployments.chainB.factory, label: 'chainB' });
const KEYS = loadAnvilKeys(6);
const makerLock = A.accountFor(KEYS[1]);
const makerRecv = A.accountFor(KEYS[2]);
const takerLock = B.accountFor(KEYS[3]);
const takerRecv = B.accountFor(KEYS[4]);
const settleAcct = A.accountFor(KEYS[5]);

const T1 = 120, T2 = 60, W = 600;
const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
};

const makeOffer = (offerId, total) => ({
  offerId, version: 1, fillMode: 'direct',
  giveChain: 'chainA', giveAsset: 'native', giveAmount: total.toString(),
  wantChain: 'chainB', wantAsset: 'native', wantAmount: (BigInt(total) * 9n / 10n).toString(),
  minFillAmount: parseEther('0.1').toString(),
  makerAddr: makerLock.address, makerRecvAddr: makerRecv.address,
  takerAddr: null, takerCredential: null, arbiter: null, fiatLeg: null,
  makerTimelockSec: T1, takerTimelockSec: T2, commitWindowSec: W,
  expiry: String(Math.floor(Date.now() / 1000) + 86400), nonce: offerId.slice(0, 8),
});

async function bootMaker(workerId, makerId, offer) {
  const ledger = new ReservationLedger({ makerId, dataDir });
  await ledger.start();
  const watcher = new SwapWatcher({ workerId, dataDir, chains: { A, B }, artifacts, onTick: () => {} });
  await watcher.start();
  const maker = new MakerWorker({
    workerId, ledger, watcher, chains: { A, B }, artifacts,
    lockAccount: makerLock, settleAccount: settleAcct, recvAddress: makerRecv.address, offer,
  });
  watcher.onTick = (s, ctx) => maker._onTick(s, ctx);
  ledger.addOffer({ offerId: offer.offerId, total: offer.giveAmount, minFillAmount: offer.minFillAmount, commitWindowSec: offer.commitWindowSec });
  maker.reconcileLedger();
  return { ledger, watcher, maker };
}

function bootTaker(workerId) {
  const watcher = new SwapWatcher({ workerId, dataDir, chains: { A, B }, artifacts, onTick: () => {} });
  const taker = new TakerWorker({
    workerId, watcher, chains: { A, B }, artifacts,
    lockAccount: takerLock, settleAccount: settleAcct, recvAddress: takerRecv.address,
  });
  watcher.onTick = (s, ctx) => taker._onTick(s, ctx);
  return { watcher, taker };
}

/** Append a tampered swap record (replay takes the LAST record per fillId). */
function tamperSwap(workerId, fillId, mutate) {
  const p = join(dataDir, workerId, 'swaps.jsonl');
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  const tampered = mutate(structuredClone(last.swap));
  appendFileSync(p, JSON.stringify({ type: 'swap', fillId, swap: tampered, ts: Date.now() },
    (k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
}

// ================= A. stale persisted phase overridden by chain =================
console.log('\n=== A. stale persisted phase -> chain re-derivation ===');
{
  const offer = makeOffer('offer-rec-a', parseEther('1'));
  const m1 = await bootMaker('recA-maker', 'recA-maker', offer);
  const fillId = fillIdFor(offer.offerId, 'fill-1');
  const commitment = await bootTaker('recA-taker-temp').taker.signCommitment({ offerId: offer.offerId, f: parseEther('0.4'), fillNonce: 'fill-1' });
  const res = await m1.maker.handleCommitment(commitment);
  if (!res.ok) throw new Error('commit rejected');
  const lockProof = await m1.maker.lock(fillId, { t1Sec: T1 });
  const escrowA = lockProof.escrowA;
  const sBefore = m1.watcher.get(fillId).s;
  await m1.watcher.stop(); await m1.ledger.stop(); // "crash"

  // Tamper: persisted phase rewinds to 'committed', escrowA forgotten — but the lock IS on-chain.
  tamperSwap('recA-maker', fillId, (sw) => {
    sw.phase = PHASE.COMMITTED;
    delete sw.escrowA; delete sw.lockTxA; delete sw.lockParamsA;
    return sw;
  });

  const m2 = await bootMaker('recA-maker', 'recA-maker', offer); // restart: recover() re-derives
  const re = m2.watcher.get(fillId);
  check('restart re-derived makerLocked from chain (not persisted committed)',
    re.phase === PHASE.MAKER_LOCKED, `phase=${re.phase}`);
  check('escrowA rediscovered via fillId scan', re.escrowA?.toLowerCase() === escrowA.toLowerCase());
  check('secret s survived in the durable store', re.s === sBefore);

  // No taker lock; warp past T1 — the recovered maker refunds.
  const balBefore = await getBalance(A, makerLock.address);
  await increaseTime(A, T1 + 60);
  const fin = await m2.maker.waitForSettled(fillId, { timeoutMs: 60000 });
  check('recovered maker refunded after T1', fin.phase === PHASE.REFUNDED, `phase=${fin.phase}`);
  check('refund returned exactly f to makerLock',
    (await getBalance(A, makerLock.address)) - balBefore === parseEther('0.4'));
  await m2.watcher.stop(); await m2.ledger.stop();
}

// ================= B. taker crash after s revealed -> re-submit claim =================
console.log('\n=== B. taker restart re-submits claim from revealed preimage ===');
{
  const offer = makeOffer('offer-rec-b', parseEther('1'));
  const m = await bootMaker('recB-maker', 'recB-maker', offer);
  const t1 = bootTaker('recB-taker');
  await t1.watcher.start();
  const fillId = fillIdFor(offer.offerId, 'fill-1');
  const f = parseEther('0.5');

  const commitment = await t1.taker.signCommitment({ offerId: offer.offerId, f, fillNonce: 'fill-1' });
  const res = await m.maker.handleCommitment(commitment);
  if (!res.ok) throw new Error('commit rejected');
  const lockProof = await m.maker.lock(fillId, { t1Sec: T1 });
  await t1.taker.verifyAndLock(lockProof, offer, { t2Sec: T2 });

  // Maker claims B (reveals s) — taker "crashes" before its tick ever runs.
  const mFin = await m.maker.waitForSettled(fillId, { timeoutMs: 60000 });
  if (mFin.phase !== PHASE.CLAIMED) throw new Error('maker did not claim');
  const s = m.watcher.get(fillId).s;
  const balTakerRecv0 = await getBalance(A, takerRecv.address);
  await t1.watcher.stop(); // crash: taker never ran its claim tick

  // Restart the taker watcher — recover() must find s in the Withdrawn event.
  const t2 = bootTaker('recB-taker');
  await t2.watcher.start();
  const re = t2.watcher.get(fillId);
  check('restart kept takerLocked (Withdrawn on B is not a taker claim)',
    re.phase === PHASE.TAKER_LOCKED, `phase=${re.phase}`);
  check('preimage re-derived from chain event', re.preimage?.toLowerCase() === s.toLowerCase());

  const tFin = await t2.taker.waitForSettled(fillId, { timeoutMs: 60000 });
  check('restarted taker claimed on A', tFin.phase === PHASE.CLAIMED, `phase=${tFin.phase}`);
  check('taker got exactly f on A',
    (await getBalance(A, takerRecv.address)) - balTakerRecv0 === f);

  await m.watcher.stop(); await m.ledger.stop(); await t2.watcher.stop();
}

console.log('\n=== summary ===');
const fails = results.filter((r) => !r.pass);
console.log(`${results.length - fails.length}/${results.length} checks passed`);
if (fails.length) process.exitCode = 1;

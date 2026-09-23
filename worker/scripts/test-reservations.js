/**
 * scripts/test-reservations.js — spec §7 reservation protocol tests.
 *
 *  1. Race: two CONCURRENT commitments for 0.8 ETH each against 1.0 ETH remaining
 *     -> exactly one reserves (signed ack), the other gets a signed rejection.
 *  2. Single-writer: a live holder's maker id refuses a second start (ELEASE_HELD);
 *     a different maker id starts fine; after kill -9 the lease is retaken.
 *  3. Kill -9 mid-reservation: child killed inside the atomic section (before fsync)
 *     -> restart replays cleanly, NO phantom reservation, remaining intact.
 *  4. Restart recovery: stale reservation (reservedUntil past) expires back to pool.
 *
 * Usage: node scripts/test-reservations.js [--data /tmp/xcm-resv-test]
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseEther, formatEther } from 'viem';
import { recoverMessageAddress } from 'viem';
import { ReservationLedger, LeaseHeldError } from '../src/reservations.js';
import { canonical, sleep } from '../src/util.js';
import { loadAnvilKeys } from '../src/chain.js';
import { signMessage } from 'viem/accounts';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.argv.includes('--data') ? process.argv[process.argv.indexOf('--data') + 1] : '/tmp/xcm-resv-test');
rmSync(dataDir, { recursive: true, force: true });

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
};

// real maker-key signatures for acks/rejections (placeholder for EIP-712)
const MAKER_PK = loadAnvilKeys()[1];
const sign = (payload) => signMessage({ message: canonical(payload), privateKey: MAKER_PK });
const verifyMaker = async (payloadWithSig) => {
  const { signature, ...body } = payloadWithSig;
  const recovered = await recoverMessageAddress({ message: canonical(body), signature });
  const { privateKeyToAccount } = await import('viem/accounts');
  return recovered.toLowerCase() === privateKeyToAccount(MAKER_PK).address.toLowerCase();
};

const OFFER = (id, totalEth, windowSec = 300) => ({
  offerId: id, total: parseEther(String(totalEth)).toString(),
  minFillAmount: parseEther('0.1').toString(), commitWindowSec: windowSec,
});

// ---------- 1. concurrent race ----------
console.log('\n=== 1. reservation race: 2 x 0.8 ETH vs 1.0 ETH remaining ===');
{
  const ledger = new ReservationLedger({ makerId: 'race-maker', dataDir });
  await ledger.start();
  ledger.addOffer(OFFER('offer-race-001', 1));
  const mkCommit = (nonce) => ({
    offerId: 'offer-race-001', f: parseEther('0.8').toString(), fillNonce: nonce,
    takerAddrs: { giveChain: '0x1', wantChain: '0x2' }, commitmentSig: '0xcommit',
  });
  const [r1, r2] = await Promise.all([
    ledger.handleCommitment(mkCommit('fill-a'), { signAck: sign, signRejection: sign }),
    ledger.handleCommitment(mkCommit('fill-b'), { signAck: sign, signRejection: sign }),
  ]);
  const oks = [r1, r2].filter((r) => r.ok);
  const rejs = [r1, r2].filter((r) => !r.ok);
  check('exactly one reserves', oks.length === 1 && rejs.length === 1);
  check('loser gets signed rejection (insufficient-remaining)',
    rejs[0].rejection.reason === 'insufficient-remaining' && await verifyMaker(rejs[0].rejection),
    `reason=${rejs[0].rejection.reason}`);
  check('winner ack is maker-signed', await verifyMaker(oks[0].ack));
  check('remaining == 0.2 ETH', ledger.remaining('offer-race-001') === parseEther('0.2'),
    `remaining=${formatEther(ledger.remaining('offer-race-001'))}`);
  await ledger.stop();
}

// ---------- helpers for child workers ----------
function spawnWorker(args, env = {}) {
  const child = spawn('node', [join(HERE, 'worker-node.js'), ...args], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}
// Single accumulating stdout buffer per child: later waiters must also see
// output that arrived before they were registered (READY and ENTERING_ATOMIC
// can land in the same chunk).
function makeLineWatcher(child) {
  let buf = '';
  const waiters = [];
  child.stdout.on('data', (d) => {
    buf += d.toString();
    for (const w of [...waiters]) {
      if (buf.includes(w.text)) {
        clearTimeout(w.timer);
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  });
  child.on('exit', (code) => {
    for (const w of [...waiters]) {
      clearTimeout(w.timer);
      w.reject(new Error(`child exited ${code} before "${w.text}": ${buf.slice(-500)}`));
    }
    waiters.length = 0;
  });
  return (text, timeoutMs = 15000) => new Promise((resolve, reject) => {
    if (buf.includes(text)) return resolve();
    const timer = setTimeout(() => {
      waiters.splice(waiters.findIndex((w) => w.text === text && w.resolve === resolve), 1);
      reject(new Error(`timeout waiting for "${text}"`));
    }, timeoutMs);
    waiters.push({ text, resolve, reject, timer });
  });
}

// ---------- 2. single-writer lease ----------
console.log('\n=== 2. single-writer lease ===');
{
  const child = spawnWorker(['--maker-id', 'lease-maker', '--data', dataDir, '--mode', 'hold']);
  const watchLease = makeLineWatcher(child);
  await watchLease('READY');

  let refused = null;
  const second = new ReservationLedger({ makerId: 'lease-maker', dataDir });
  try { await second.start(); } catch (e) { refused = e; }
  check('second instance with same maker id refuses', refused instanceof LeaseHeldError && refused.code === 'ELEASE_HELD',
    refused ? refused.message.slice(0, 80) : 'started anyway!');

  const other = new ReservationLedger({ makerId: 'other-maker', dataDir });
  await other.start();
  check('different maker id starts fine', true);
  await other.stop();

  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  await sleep(500); // dead pid -> lease retaken immediately
  const retake = new ReservationLedger({ makerId: 'lease-maker', dataDir });
  await retake.start();
  check('lease retaken after kill -9', true);
  check('no phantom state after crash', retake.remaining('offer-crash-001') === parseEther('1'));
  await retake.stop();
}

// ---------- 3. kill -9 mid-reservation ----------
console.log('\n=== 3. kill -9 inside the atomic section (before fsync) ===');
{
  const child = spawnWorker(
    ['--maker-id', 'crash-maker', '--data', dataDir, '--mode', 'reserve-delay'],
    { INJECT_DELAY_MS: '15000' },
  );
  const watchCrash = makeLineWatcher(child);
  await watchCrash('READY');
  await watchCrash('ENTERING_ATOMIC'); // inside check-and-reserve, pre-fsync
  await sleep(300);
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));

  const recovered = new ReservationLedger({ makerId: 'crash-maker', dataDir });
  await recovered.start();
  check('restart replays cleanly', true);
  check('no phantom reservation (remaining == 1.0 ETH)',
    recovered.remaining('offer-crash-001') === parseEther('1'),
    `remaining=${formatEther(recovered.remaining('offer-crash-001'))}`);
  check('zero active reservations', recovered.activeReservations('offer-crash-001').length === 0);
  await recovered.stop();
}

// ---------- 4. stale reservation expiry on restart ----------
console.log('\n=== 4. restart recovery expires stale reservations ===');
{
  const ledger = new ReservationLedger({ makerId: 'expiry-maker', dataDir });
  await ledger.start();
  ledger.addOffer(OFFER('offer-exp-001', 1, 1)); // W = 1s
  const res = await ledger.handleCommitment(
    { offerId: 'offer-exp-001', f: parseEther('0.6').toString(), fillNonce: 'fill-x', takerAddrs: {}, commitmentSig: '0x' },
    { signAck: sign, signRejection: sign },
  );
  check('reservation taken', res.ok && ledger.remaining('offer-exp-001') === parseEther('0.4'));
  await sleep(1500); // let reservedUntil pass
  await ledger.stop();

  const restarted = new ReservationLedger({ makerId: 'expiry-maker', dataDir });
  await restarted.start(); // recovery expires the stale reservation
  check('stale reservation expired back to pool', restarted.remaining('offer-exp-001') === parseEther('1'),
    `remaining=${formatEther(restarted.remaining('offer-exp-001'))}`);
  await restarted.stop();
}

// ---------- 5. fillNonce is single-use: replay after fill is rejected ----------
console.log('\n=== 5. fillNonce single-use (anti-replay across restarts) ===');
{
  const ledger = new ReservationLedger({ makerId: 'replay-maker', dataDir });
  await ledger.start();
  ledger.addOffer(OFFER('offer-replay-001', 1));
  const commit = (nonce, eth) => ({
    offerId: 'offer-replay-001', f: parseEther(eth).toString(), fillNonce: nonce,
    takerAddrs: {}, commitmentSig: '0x',
  });
  const r1 = await ledger.handleCommitment(commit('fill-1', '0.5'), { signAck: sign, signRejection: sign });
  check('first reservation ok', r1.ok);
  ledger.markFilled({ offerId: 'offer-replay-001', fillNonce: 'fill-1', f: parseEther('0.5').toString(), fillId: '0xabc' });
  await ledger.stop();

  const restarted = new ReservationLedger({ makerId: 'replay-maker', dataDir });
  await restarted.start();
  const r2 = await restarted.handleCommitment(commit('fill-1', '0.5'), { signAck: sign, signRejection: sign });
  check('same fillNonce after fill is rejected', !r2.ok && r2.rejection.reason === 'duplicate-fillNonce',
    `reason=${r2.rejection.reason}`);
  check('filled total not double-counted', restarted.remaining('offer-replay-001') === parseEther('0.5'));
  const r3 = await restarted.handleCommitment(commit('fill-2', '0.5'), { signAck: sign, signRejection: sign });
  check('fresh fillNonce still reserves', r3.ok);
  await restarted.stop();
}

console.log('\n=== summary ===');
const fails = results.filter((r) => !r.pass);
console.log(`${results.length - fails.length}/${results.length} checks passed`);
if (fails.length) process.exitCode = 1;

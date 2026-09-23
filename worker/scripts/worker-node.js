/**
 * scripts/worker-node.js — minimal ledger-holding worker process for crash tests.
 *
 * Modes:
 *   hold           acquire the single-writer lease for --maker-id, add an offer, hold it
 *   reserve-delay  acquire lease, add offer, then begin a commitment whose atomic
 *                  section pauses inside beforeFsync (kill -9 window); prints
 *                  ENTERING_ATOMIC when inside, then hangs in the pause
 *
 * Args: --maker-id ID --data DIR --mode MODE [--total ETH] [--window SEC]
 * Env:  INJECT_DELAY_MS (reserve-delay pause length)
 *
 * Prints READY once the lease is held.
 */
import { ReservationLedger } from '../src/reservations.js';
import { parseEther } from 'viem';
import { sleep } from '../src/util.js';

const argv = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
};

const makerId = argv('--maker-id');
const dataDir = argv('--data');
const mode = argv('--mode', 'hold');
const total = parseEther(argv('--total', '1')).toString();
const windowSec = Number(argv('--window', '300'));
if (!makerId || !dataDir) { console.error('need --maker-id and --data'); process.exit(2); }

const testHooks = {};
if (mode === 'reserve-delay') {
  const delayMs = Number(process.env.INJECT_DELAY_MS || '10000');
  testHooks.beforeFsync = async () => {
    console.log('ENTERING_ATOMIC');
    await sleep(delayMs);
  };
}

const ledger = new ReservationLedger({
  makerId, dataDir,
  leaseTtlMs: 2000, heartbeatMs: 500,
  testHooks,
});
await ledger.start();
ledger.addOffer({ offerId: 'offer-crash-001', total, minFillAmount: parseEther('0.1').toString(), commitWindowSec: windowSec });
console.log('READY');

if (mode === 'reserve-delay') {
  // fire-and-forget: the parent kills us mid-reservation
  ledger.handleCommitment(
    { offerId: 'offer-crash-001', f: parseEther('0.8').toString(), fillNonce: 'fill-kill', takerAddrs: {}, commitmentSig: '0x' },
    { signAck: async () => '0xsig', signRejection: async () => '0xsig' },
  ).catch(() => {});
  await sleep(Number(process.env.INJECT_DELAY_MS || '10000') + 5000);
} else {
  await new Promise(() => {}); // hold forever (parent kills)
}

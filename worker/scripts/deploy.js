/**
 * scripts/deploy.js — deploy TWO HTLCFactory instances on local anvil,
 * simulating chain A and chain B (documented limitation: one anvil node).
 * Writes worker/deployments.json.
 *
 * Usage: node scripts/deploy.js [--rpc http://127.0.0.1:8545]
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { anvil } from 'viem/chains';
import { loadArtifacts, deployFactory, chainEndpoint, loadAnvilKeys } from '../src/chain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const rpc = process.argv.includes('--rpc')
  ? process.argv[process.argv.indexOf('--rpc') + 1]
  : process.env.ANVIL_RPC || 'http://127.0.0.1:8545';

const publicClient = createPublicClient({ chain: anvil, transport: http(rpc) });
const artifacts = loadArtifacts();

// throwaway deployer: anvil default account 0
const deployer = chainEndpoint({ rpcUrl: rpc, factoryAddress: '0x0000000000000000000000000000000000000000', label: 'deploy' })
  .accountFor(loadAnvilKeys()[0]);

const factoryA = await deployFactory(publicClient, deployer.wallet, artifacts);
console.log('factory A (chain A):', factoryA);
const factoryB = await deployFactory(publicClient, deployer.wallet, artifacts);
console.log('factory B (chain B):', factoryB);

const deployments = {
  rpc,
  chainA: { label: 'chainA', factory: factoryA },
  chainB: { label: 'chainB', factory: factoryB },
  // TEST ONLY: anvil default throwaway accounts. Never real keys, never testnet.
  note: 'local anvil only — default throwaway test accounts',
};
writeFileSync(join(ROOT, 'deployments.json'), JSON.stringify(deployments, null, 2));
console.log('wrote deployments.json');

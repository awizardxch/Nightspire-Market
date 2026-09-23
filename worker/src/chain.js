/**
 * chain.js — viem clients + HTLCFactory / HTLCEscrow contract wrappers.
 *
 * REAL chain reads/writes against local anvil only. Two "chains" (A and B) are
 * simulated by two factory instances on ONE anvil node — documented limitation
 * (see README). All reads go through the agent's own RPC (spec §12: chain is truth).
 *
 * Accounts: anvil's default throwaway test keys ONLY. Never real keys, never testnet.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  parseEventLogs,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVM_DIR = join(HERE, '..', '..', 'contracts', 'evm');

function loadArtifact(name) {
  const p = join(EVM_DIR, 'out', `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** @returns {{ factoryAbi, factoryBytecode, escrowAbi }} */
export function loadArtifacts() {
  const factory = loadArtifact('HTLCFactory');
  const escrow = loadArtifact('HTLCEscrow');
  return {
    factoryAbi: factory.abi,
    factoryBytecode: factory.bytecode.object,
    escrowAbi: escrow.abi,
  };
}

/**
 * Anvil default throwaway test private keys (no value — printed by anvil at
 * startup). Loaded dynamically from the key file written by scripts/demo.sh,
 * so they always match the ACTUAL anvil instance (never hardcode keys from
 * memory — foundry's default mnemonic has changed across versions).
 * TEST ONLY. Never real keys, never testnet.
 *
 * @returns string[] of 0x-hex private keys (default: first 5 accounts)
 */
export function loadAnvilKeys(count = 5) {
  const file = process.env.ANVIL_KEYS_FILE || join(HERE, '..', '.anvil-keys.json');
  if (!existsSync(file)) {
    throw new Error(
      `anvil key file not found: ${file} — run scripts/demo.sh (which boots anvil and extracts keys) ` +
      `or set ANVIL_KEYS_FILE to a JSON array of the anvil instance's throwaway private keys`,
    );
  }
  const keys = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(keys) || keys.length < count || !keys.every((k) => /^0x[0-9a-fA-F]{64}$/.test(k))) {
    throw new Error(`bad anvil key file: ${file}`);
  }
  return keys.slice(0, count);
}

/** One named chain endpoint: its own RPC handle + factory address. */
export function chainEndpoint({ rpcUrl, factoryAddress, label }) {
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: anvil, transport });
  const factory = getAddress(factoryAddress);
  return {
    label,
    rpcUrl,
    factory,
    publicClient,
    accountFor(privateKey) {
      const account = privateKeyToAccount(privateKey);
      return {
        address: account.address,
        privateKey,
        wallet: createWalletClient({ account, chain: anvil, transport: http(rpcUrl) }),
      };
    },
  };
}

/** Deploy one HTLCFactory. Returns checksummed address. */
export async function deployFactory(publicClient, deployerWallet, artifacts) {
  const hash = await deployerWallet.deployContract({
    abi: artifacts.factoryAbi,
    bytecode: artifacts.factoryBytecode,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return getAddress(receipt.contractAddress);
}

/**
 * Lock funds into a new HTLC escrow via the factory.
 * params: {receiver, refundAddr, hashlock, timelock(BigInt ts), token, amount(BigInt),
 *          fillId, arbiter, exclusiveClaimer, exclusiveUntil}
 * Native variant: token == 0x0 and value == amount.
 */
export async function newContract(chain, wallet, artifacts, params) {
  const args = [
    params.receiver,
    params.refundAddr,
    params.hashlock,
    params.timelock,
    params.token,
    params.amount,
    params.fillId,
    params.arbiter,
    params.exclusiveClaimer,
    params.exclusiveUntil,
  ];
  const isNative = params.token === '0x0000000000000000000000000000000000000000';
  const hash = await wallet.writeContract({
    address: chain.factory,
    abi: artifacts.factoryAbi,
    functionName: 'newContract',
    args,
    value: isNative ? params.amount : 0n,
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  const logs = parseEventLogs({
    abi: artifacts.factoryAbi,
    logs: receipt.logs,
    eventName: 'ContractCreated',
  });
  if (logs.length === 0) throw new Error('ContractCreated event not found in receipt');
  const ev = logs[0].args;
  return {
    escrow: getAddress(ev.escrow),
    id: ev.id,
    txHash: hash,
    blockNumber: receipt.blockNumber,
    fillId: ev.fillId,
    hashlock: ev.hashlock,
    timelock: ev.timelock,
    amount: ev.amount,
  };
}

export async function computeId(chain, artifacts, params) {
  return chain.publicClient.readContract({
    address: chain.factory,
    abi: artifacts.factoryAbi,
    functionName: 'computeId',
    args: [
      params.receiver, params.refundAddr, params.hashlock, params.timelock,
      params.token, params.amount, params.fillId, params.arbiter,
      params.exclusiveClaimer, params.exclusiveUntil,
    ],
  });
}

export async function getEscrowAddress(chain, artifacts, id) {
  const addr = await chain.publicClient.readContract({
    address: chain.factory,
    abi: artifacts.factoryAbi,
    functionName: 'getContract',
    args: [id],
  });
  return addr === '0x0000000000000000000000000000000000000000' ? null : getAddress(addr);
}

/** Read all immutable terms of a deployed escrow (taker verification, spec §3.1 step 4). */
export async function readEscrow(chain, artifacts, escrowAddress) {
  const escrow = getAddress(escrowAddress);
  const names = [
    'RECEIVER', 'REFUND_ADDR', 'HASHLOCK', 'TIMELOCK', 'TOKEN',
    'AMOUNT', 'FILL_ID', 'CONTRACT_ID', 'ARBITER', 'EXCLUSIVE_CLAIMER', 'EXCLUSIVE_UNTIL',
  ];
  const out = { escrow };
  for (const n of names) {
    out[n] = await chain.publicClient.readContract({ address: escrow, abi: artifacts.escrowAbi, functionName: n });
  }
  return out;
}

/** Claim branch: withdraw(preimage). Anyone may call; pays RECEIVER. */
export async function escrowWithdraw(chain, wallet, artifacts, escrowAddress, preimage) {
  const hash = await wallet.writeContract({
    address: getAddress(escrowAddress),
    abi: artifacts.escrowAbi,
    functionName: 'withdraw',
    args: [preimage],
  });
  return chain.publicClient.waitForTransactionReceipt({ hash });
}

/** Refund branch: refund(). Anyone may call after timelock; pays REFUND_ADDR. */
export async function escrowRefund(chain, wallet, artifacts, escrowAddress) {
  const hash = await wallet.writeContract({
    address: getAddress(escrowAddress),
    abi: artifacts.escrowAbi,
    functionName: 'refund',
    args: [],
  });
  return chain.publicClient.waitForTransactionReceipt({ hash });
}

/** All ContractCreated events on a factory for a fillId (lock discovery). */
export async function findLocksByFillId(chain, artifacts, fillId, fromBlock = 0n) {
  return chain.publicClient.getContractEvents({
    address: chain.factory,
    abi: artifacts.factoryAbi,
    eventName: 'ContractCreated',
    args: { fillId },
    fromBlock,
  });
}

/** Withdrawn events for one escrow (preimage discovery). */
export async function getWithdrawnEvents(chain, artifacts, escrowAddress, fromBlock = 0n) {
  return chain.publicClient.getContractEvents({
    address: getAddress(escrowAddress),
    abi: artifacts.escrowAbi,
    eventName: 'Withdrawn',
    fromBlock,
  });
}

/** Refunded events for one escrow. */
export async function getRefundedEvents(chain, artifacts, escrowAddress, fromBlock = 0n) {
  return chain.publicClient.getContractEvents({
    address: getAddress(escrowAddress),
    abi: artifacts.escrowAbi,
    eventName: 'Refunded',
    fromBlock,
  });
}

export async function getBalance(chain, address) {
  return chain.publicClient.getBalance({ address: getAddress(address) });
}

export async function latestTimestamp(chain) {
  const b = await chain.publicClient.getBlock({ blockTag: 'latest' });
  return b.timestamp;
}

/** TEST ONLY: warp anvil time forward and mine a block (refund-path demo). */
export async function increaseTime(chain, seconds) {
  await chain.publicClient.request({ method: 'evm_increaseTime', params: [seconds] });
  await chain.publicClient.request({ method: 'evm_mine', params: [] });
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

import type { Chain, GetTransactionReceiptReturnType } from 'viem';
import { createPublicClient, http } from 'viem';
import { celo } from 'viem/chains';
import blockFallGameAbi from '../abis/blockfall-game.abi.ts';
import { BLOCKFALL_GAME_ADDRESS, rpcUrls } from '../constants.ts';

const clients = rpcUrls.map((url: string) =>
  createPublicClient({ chain: celo, transport: http(url) })
);

export async function getTransactionReceipt(
  hash: `0x${string}`
): Promise<GetTransactionReceiptReturnType<Chain>> {
  for (const client of clients) {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch {
      /* try next RPC */
    }
  }
  throw new Error('All RPC URLs failed for getTransactionReceipt');
}

export async function getBlock(blockNumber: bigint) {
  for (const client of clients) {
    try {
      return await client.getBlock({ blockNumber });
    } catch {
      /* try next RPC */
    }
  }
  throw new Error('All RPC URLs failed for getBlock');
}

export async function getLatestBlockNumber(): Promise<bigint> {
  for (const client of clients) {
    try {
      return await client.getBlockNumber();
    } catch {
      /* try next RPC */
    }
  }
  throw new Error('All RPC URLs failed for getBlockNumber');
}

// Fetches ItemBought events emitted by the BlockFallGame contract in the
// inclusive [fromBlock, toBlock] range. Logs are only emitted by successful
// transactions, so anything returned here is a confirmed, on-contract buy.
export async function getItemBoughtLogs(fromBlock: bigint, toBlock: bigint) {
  for (const client of clients) {
    try {
      return await client.getContractEvents({
        address: BLOCKFALL_GAME_ADDRESS as `0x${string}`,
        abi: blockFallGameAbi,
        eventName: 'ItemBought',
        fromBlock,
        toBlock,
        // Only return logs whose args fully decode against the event signature,
        // which also makes log.args non-partial for the consumer.
        strict: true,
      });
    } catch {
      /* try next RPC */
    }
  }
  throw new Error('All RPC URLs failed for getItemBoughtLogs');
}

export type ItemBoughtLog = Awaited<ReturnType<typeof getItemBoughtLogs>>[number];

let cachedSeed: `0x${string}` | null = null;

// SEED is an immutable bytes32 set at contract deploy time, so it's safe to
// fetch once and cache for the process lifetime.
export async function getBlockfallSeed(): Promise<`0x${string}`> {
  if (cachedSeed) return cachedSeed;
  for (const client of clients) {
    try {
      const seed = await client.readContract({
        address: BLOCKFALL_GAME_ADDRESS as `0x${string}`,
        abi: blockFallGameAbi,
        functionName: 'SEED',
      });
      cachedSeed = seed;
      return seed;
    } catch {
      /* try next RPC */
    }
  }
  throw new Error('All RPC URLs failed for SEED');
}

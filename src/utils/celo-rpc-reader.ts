import type { Chain, GetTransactionReceiptReturnType } from 'viem';
import { createPublicClient, http } from 'viem';
import { celo } from 'viem/chains';
import { rpcUrls } from '../constants.ts';

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

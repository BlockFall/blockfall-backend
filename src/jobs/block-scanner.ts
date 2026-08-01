import fs from 'node:fs';
import path from 'node:path';
import { findExistingTxHashes } from '../db/purchases.ts';
import { getBlock, getLatestBlockNumber } from '../utils/celo-rpc-reader.ts';

// Most blocks to scan in a single tick, so we never ask an RPC for an
// unbounded range while catching up after downtime.
const MAX_BLOCKS_PER_TICK = 5000n;

// How far behind the chain head we stay, to avoid re-orged blocks.
const CONFIRMATIONS = 5n;

interface ScannedLog {
  transactionHash: string;
  blockNumber: bigint;
}

export interface BlockScanOptions<TLog extends ScannedLog> {
  /** Event name, used only for log lines (e.g. 'ItemBought'). */
  label: string;
  /** File holding the last scanned block number, relative to the cwd. */
  progressFile: string;
  /** Block to start from when there is no saved progress yet. */
  defaultStartBlock: bigint;
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<TLog[]>;
  /** Handles one log that is not yet in user_transactions. */
  processLog: (log: TLog, blockTimeCache: Map<bigint, Date>) => Promise<void>;
}

function readLastBlock(progressFile: string, defaultStartBlock: bigint): bigint {
  try {
    const raw = fs.readFileSync(progressFile, 'utf8').trim();
    if (raw) return BigInt(raw);
  } catch {
    /* file missing or unreadable — fall back to the default start block */
  }
  return defaultStartBlock;
}

function writeLastBlock(progressFile: string, block: bigint): void {
  fs.mkdirSync(path.dirname(progressFile), { recursive: true });
  fs.writeFileSync(progressFile, block.toString());
}

/**
 * Shared driver for the on-chain backfill jobs. Fetches the configured event
 * from the next unscanned block range (capped at MAX_BLOCKS_PER_TICK), finds
 * which transaction hashes are not yet in user_transactions with a single
 * query, and hands each missing one to `processLog`. Persists the scanned-to
 * block so the next tick resumes where this one stopped.
 */
export async function runBlockScan<TLog extends ScannedLog>(
  options: BlockScanOptions<TLog>
): Promise<void> {
  const { label, progressFile, defaultStartBlock, getLogs, processLog } = options;

  const lastBlock = readLastBlock(progressFile, defaultStartBlock);
  const latestBlock = (await getLatestBlockNumber()) - CONFIRMATIONS;

  const fromBlock = lastBlock + 1n;
  if (fromBlock > latestBlock) return; // nothing new on-chain yet

  const toBlock =
    fromBlock + MAX_BLOCKS_PER_TICK - 1n > latestBlock
      ? latestBlock
      : fromBlock + MAX_BLOCKS_PER_TICK - 1n;

  console.log(`Scan ${label}: ${fromBlock.toString()} to ${toBlock.toString()}`);
  const logs = await getLogs(fromBlock, toBlock);
  console.log(`Found ${String(logs.length)} ${label} events in range`);

  if (logs.length > 0) {
    const txHashes = logs.map((log) => log.transactionHash);
    const existing = await findExistingTxHashes(txHashes);
    console.log(`${String(existing.size)} of those transactions already processed`);

    // Cache block timestamps so multiple events in the same block hit the RPC once.
    const blockTimeCache = new Map<bigint, Date>();

    for (const log of logs) {
      if (existing.has(log.transactionHash)) continue;
      try {
        await processLog(log, blockTimeCache);
      } catch (err) {
        // Log and continue — one bad transaction must not stall the range or
        // block progress persistence (it would just be retried next tick if we
        // didn't advance, but we do advance, so surface it loudly here).
        console.error(`failed to process ${label} tx ${log.transactionHash}:`, err);
      }
    }
  }

  writeLastBlock(progressFile, toBlock);
}

/** Block timestamp as a Date, memoized per scan tick. */
export async function getBlockTime(
  blockNumber: bigint,
  blockTimeCache: Map<bigint, Date>
): Promise<Date> {
  const cached = blockTimeCache.get(blockNumber);
  if (cached) return cached;

  const block = await getBlock(blockNumber);
  const txTime = new Date(Number(block.timestamp) * 1000);
  blockTimeCache.set(blockNumber, txTime);
  return txTime;
}

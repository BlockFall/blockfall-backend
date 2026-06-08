import fs from 'node:fs';
import path from 'node:path';
import { formatUnits } from 'viem';
import { PAYMENT_TOKENS, VALID_PURCHASE_ITEM_TYPES } from '../constants.ts';
import { findExistingTxHashes, processPurchase } from '../db/purchases.ts';
import { findUserIdByAddress } from '../db/users.ts';
import {
  getBlock,
  getItemBoughtLogs,
  getLatestBlockNumber,
  type ItemBoughtLog,
} from '../utils/celo-rpc-reader.ts';

// Run cadence — index.ts schedules this with maintainAsyncJob.
export const SYNC_ITEM_BOUGHT_INTERVAL_MS = 60 * 1000;

// Most blocks to scan in a single tick, so we never ask an RPC for an
// unbounded range while catching up after downtime.
const MAX_BLOCKS_PER_TICK = 5000n;

// Where to start scanning when there is no saved progress yet (contract
// deployment-ish block). Stored back to disk as the last scanned block.
const DEFAULT_START_BLOCK = 63688900n;

const PROGRESS_FILE = path.join('data', 'last-item-bought-block.txt');

function readLastBlock(): bigint {
  try {
    const raw = fs.readFileSync(PROGRESS_FILE, 'utf8').trim();
    if (raw) return BigInt(raw);
  } catch {
    /* file missing or unreadable — fall back to the default start block */
  }
  return DEFAULT_START_BLOCK;
}

function writeLastBlock(block: bigint): void {
  fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, block.toString());
}

/**
 * Backfills purchases that the live /purchase/submit flow missed. Fetches
 * ItemBought events from the next unscanned block range (capped at
 * MAX_BLOCKS_PER_TICK), finds which transaction hashes are not yet in
 * user_transactions with a single query, and processes each missing one the
 * same way the endpoint does. Persists the scanned-to block so the next tick
 * resumes where this one stopped.
 */
export async function runSyncItemBoughtJob(): Promise<void> {
  const lastBlock = readLastBlock();
  const latestBlock = (await getLatestBlockNumber()) - 5n;

  const fromBlock = lastBlock + 1n;
  if (fromBlock > latestBlock) return; // nothing new on-chain yet

  const toBlock =
    fromBlock + MAX_BLOCKS_PER_TICK - 1n > latestBlock
      ? latestBlock
      : fromBlock + MAX_BLOCKS_PER_TICK - 1n;

  console.log(`Scan ItemBought: ${fromBlock.toString()} to ${toBlock.toString()}`);
  const logs = await getItemBoughtLogs(fromBlock, toBlock);
  console.log(`Found ${logs.length} ItemBought events in range`);

  if (logs.length > 0) {
    const txHashes = logs.map((log) => log.transactionHash);
    const existing = await findExistingTxHashes(txHashes);
    console.log(`${existing.size} of those transactions already processed`);

    // Cache block timestamps so multiple buys in the same block hit the RPC once.
    const blockTimeCache = new Map<bigint, Date>();

    for (const log of logs) {
      if (existing.has(log.transactionHash)) continue;
      try {
        await processItemBoughtLog(log, blockTimeCache);
      } catch (err) {
        // Log and continue — one bad transaction must not stall the range or
        // block progress persistence (it would just be retried next tick if we
        // didn't advance, but we do advance, so surface it loudly here).
        console.error(`failed to process ItemBought tx ${log.transactionHash}:`, err);
      }
    }
  }

  writeLastBlock(toBlock);
}

async function processItemBoughtLog(
  log: ItemBoughtLog,
  blockTimeCache: Map<bigint, Date>
): Promise<void> {
  const itemTypeId = Number(log.args.itemTypeId);
  const buyer = log.args.buyer.toLowerCase();

  if (!VALID_PURCHASE_ITEM_TYPES.has(itemTypeId)) {
    return; // unsupported item type — mirror the endpoint and skip
  }

  const userId = await findUserIdByAddress(buyer);
  if (userId === null) {
    console.warn(`ItemBought tx ${log.transactionHash}: no user for buyer ${buyer}, skipping`);
    return;
  }

  let txTime = blockTimeCache.get(log.blockNumber);
  if (!txTime) {
    const block = await getBlock(log.blockNumber);
    txTime = new Date(Number(block.timestamp) * 1000);
    blockTimeCache.set(log.blockNumber, txTime);
  }

  const eventParams = {
    itemTypeId,
    buyer,
    paymentToken: log.args.paymentToken,
    price: log.args.price.toString(),
  };

  const paymentToken = Object.values(PAYMENT_TOKENS).find(
    (t) => t.address.toLowerCase() === log.args.paymentToken.toLowerCase()
  );
  const revenue = paymentToken ? formatUnits(log.args.price, paymentToken.decimals) : '0';

  await processPurchase(userId, log.transactionHash, txTime, revenue, itemTypeId, eventParams);

  console.log(
    `synced ItemBought tx ${log.transactionHash} (item ${String(itemTypeId)}) for ${buyer}`
  );
}

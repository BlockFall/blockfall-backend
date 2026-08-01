import path from 'node:path';
import { formatUnits } from 'viem';
import { PAYMENT_TOKENS, VALID_PURCHASE_ITEM_TYPES } from '../constants.ts';
import { processPurchase } from '../db/purchases.ts';
import { findUserIdByAddress } from '../db/users.ts';
import { getItemBoughtLogs, type ItemBoughtLog } from '../utils/celo-rpc-reader.ts';
import { getBlockTime, runBlockScan } from './block-scanner.ts';

// Run cadence — index.ts schedules this with maintainAsyncJob.
export const SYNC_ITEM_BOUGHT_INTERVAL_MS = 60 * 1000;

// Where to start scanning when there is no saved progress yet (contract
// deployment-ish block). Stored back to disk as the last scanned block.
const DEFAULT_START_BLOCK = 63688900n;

const PROGRESS_FILE = path.join('data', 'last-item-bought-block.txt');

/**
 * Backfills purchases that the live /purchase/submit flow missed, processing
 * each unprocessed on-chain ItemBought event the same way the endpoint does.
 */
export async function runSyncItemBoughtJob(): Promise<void> {
  await runBlockScan<ItemBoughtLog>({
    label: 'ItemBought',
    progressFile: PROGRESS_FILE,
    defaultStartBlock: DEFAULT_START_BLOCK,
    getLogs: getItemBoughtLogs,
    processLog: processItemBoughtLog,
  });
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

  const txTime = await getBlockTime(log.blockNumber, blockTimeCache);

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

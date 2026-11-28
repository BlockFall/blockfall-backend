import path from 'node:path';
import { isConversionPack, VALID_PURCHASE_ITEM_TYPES } from '../constants.ts';
import { DepositAlreadyConfirmedError, findDepositForPayment } from '../db/deposits.ts';
import { processPurchase } from '../db/purchases.ts';
import { findUserIdByAddress } from '../db/users.ts';
import { confirmDepositEvent, DepositMismatchError, tokenIdByAddress } from '../deposits.ts';
import { getItemBoughtLogs, type ItemBoughtLog } from '../utils/celo-rpc-reader.ts';
import { revenueUsdForPayment } from '../utils/pricing.ts';
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
 * Conversion packs (CONVERSION_PACKS) are not purchases: they pay a conversion
 * request, so they are confirmed like /convert/submit does (no revenue).
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

  if (isConversionPack(itemTypeId)) {
    await processConversionPackLog(log, blockTimeCache);
    return;
  }

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

  const revenue = revenueUsdForPayment(log.args.paymentToken, log.args.price);

  await processPurchase(userId, log.transactionHash, txTime, revenue, itemTypeId, eventParams);

  console.log(
    `synced ItemBought tx ${log.transactionHash} (item ${String(itemTypeId)}) for ${buyer}`
  );
}

/**
 * A conversion pack bought without the app submitting it to /convert/submit:
 * match it to the buyer's newest open request with the same token and amount
 * and confirm it. Unmatched packs are logged; the tokens stay in the contract.
 */
async function processConversionPackLog(
  log: ItemBoughtLog,
  blockTimeCache: Map<bigint, Date>
): Promise<void> {
  const buyer = log.args.buyer.toLowerCase();
  const describe = () =>
    `pack ${String(log.args.itemTypeId)} (price ${log.args.price.toString()} of ` +
    `${log.args.paymentToken}) from ${buyer} (tx ${log.transactionHash})`;

  const tokenId = tokenIdByAddress(log.args.paymentToken);
  const userId = await findUserIdByAddress(buyer);
  if (tokenId === null || userId === null) {
    console.warn(`unmatched conversion ${describe()}: unknown token or buyer is not a player`);
    return;
  }

  const txTime = await getBlockTime(log.blockNumber, blockTimeCache);
  const deposit = await findDepositForPayment({
    userId,
    paymentToken: tokenId,
    amount: log.args.price,
    txTime,
  });
  if (!deposit) {
    console.warn(`unmatched conversion ${describe()}: no open request with this token and amount`);
    return;
  }

  try {
    const { payout_id } = await confirmDepositEvent({
      deposit,
      player: buyer,
      paymentToken: log.args.paymentToken,
      amount: log.args.price,
      txHash: log.transactionHash,
      txTime,
      source: 'pack',
      packItemTypeId: Number(log.args.itemTypeId),
    });
    console.log(
      `synced conversion pack tx ${log.transactionHash} (deposit ${deposit.deposit_id}, ` +
        `payout ${payout_id ?? 'none'}) for ${buyer}`
    );
  } catch (err) {
    if (err instanceof DepositAlreadyConfirmedError) return;
    if (err instanceof DepositMismatchError) {
      console.warn(`unmatched conversion ${describe()}: ${err.message}`);
      return;
    }
    throw err;
  }
}

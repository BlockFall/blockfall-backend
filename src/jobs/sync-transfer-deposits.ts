import path from 'node:path';
import { DepositAlreadyConfirmedError, findDepositForTransfer } from '../db/deposits.ts';
import { findUserIdByAddress } from '../db/users.ts';
import {
  confirmDepositEvent,
  DepositMismatchError,
  hasGameContractLogs,
  tokenIdByAddress,
} from '../deposits.ts';
import {
  getTransactionReceipt,
  getTransfersToGameLogs,
  type TransferToGameLog,
} from '../utils/celo-rpc-reader.ts';
import { getBlockTime, runBlockScan } from './block-scanner.ts';

// Run cadence — index.ts schedules this with maintainAsyncJob.
export const SYNC_TRANSFER_DEPOSIT_INTERVAL_MS = 60 * 1000;

// Transfer deposits were introduced at about this block (2026-11-28).
const DEFAULT_START_BLOCK = 83_970_000n;

const PROGRESS_FILE = path.join('data', 'last-transfer-deposit-block.txt');

/**
 * Safety net for transfer deposits: the user sent the requested token and
 * amount to the game contract with a plain ERC20 transfer, but the app never
 * submitted the tx hash to POST /convert/submit. Matches the transfer to the
 * user's newest open deposit request with the same token and amount (see
 * findDepositForTransfer) and confirms it, creating the conversion payout.
 *
 * Transfers made by buy()/deposit() calls are skipped: they are recorded by
 * the ItemBought / Deposited jobs, and runBlockScan already skips any tx hash
 * that is in user_transactions.
 */
export async function runSyncTransferDepositJob(): Promise<void> {
  await runBlockScan<TransferToGameLog>({
    label: 'Transfer to game',
    progressFile: PROGRESS_FILE,
    defaultStartBlock: DEFAULT_START_BLOCK,
    getLogs: getTransfersToGameLogs,
    processLog: processTransferLog,
  });
}

async function processTransferLog(
  log: TransferToGameLog,
  blockTimeCache: Map<bigint, Date>
): Promise<void> {
  const from = log.args.from.toLowerCase();
  const tokenId = tokenIdByAddress(log.address);
  if (tokenId === null) return;

  const userId = await findUserIdByAddress(from);
  if (userId === null) return; // not a player

  const txTime = await getBlockTime(log.blockNumber, blockTimeCache);
  const deposit = await findDepositForTransfer({
    userId,
    paymentToken: tokenId,
    amount: log.args.value,
    txTime,
  });
  if (!deposit) return; // a buy, or a transfer with no open request

  // Only plain transfers count: buy() and deposit() calls also move tokens to
  // the contract (and are recorded by their own jobs).
  const receipt = await getTransactionReceipt(log.transactionHash);
  if (receipt.status !== 'success' || hasGameContractLogs(receipt.logs)) return;

  try {
    const { payout_id } = await confirmDepositEvent({
      deposit,
      player: from,
      paymentToken: log.address,
      amount: log.args.value,
      txHash: log.transactionHash,
      txTime,
      source: 'transfer',
    });
    console.log(
      `synced transfer deposit tx ${log.transactionHash} (deposit ${deposit.deposit_id}, ` +
        `payout ${payout_id ?? 'none'}) for ${from}`
    );
  } catch (err) {
    if (err instanceof DepositAlreadyConfirmedError) return;
    if (err instanceof DepositMismatchError) {
      console.warn(`transfer deposit tx ${log.transactionHash}: ${err.message}, skipping`);
      return;
    }
    throw err;
  }
}

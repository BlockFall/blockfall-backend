import path from 'node:path';
import { toHex } from 'viem';
import { DepositAlreadyConfirmedError, findDepositByActionId } from '../db/deposits.ts';
import { findUserIdByAddress } from '../db/users.ts';
import { confirmDepositEvent, DepositMismatchError } from '../deposits.ts';
import { type DepositedLog, getDepositedLogs } from '../utils/celo-rpc-reader.ts';
import { getBlockTime, runBlockScan } from './block-scanner.ts';

// Run cadence — index.ts schedules this with maintainAsyncJob.
export const SYNC_DEPOSIT_INTERVAL_MS = 60 * 1000;

// Deposits were introduced with the G$ conversion feature; nothing earlier
// can match a user_deposits row. Mirrors sync-claim-events.ts.
const DEFAULT_START_BLOCK = 82_900_000n;

const PROGRESS_FILE = path.join('data', 'last-deposit-block.txt');

/**
 * Backfills deposits the live /convert/submit flow missed: the user deposited
 * on-chain but the frontend never submitted the tx hash (closed the app, lost
 * connection…). Confirms the deposit and, for conversion types, creates the
 * signed payout so it shows up under pending conversions.
 */
export async function runSyncDepositJob(): Promise<void> {
  await runBlockScan<DepositedLog>({
    label: 'Deposited',
    progressFile: PROGRESS_FILE,
    defaultStartBlock: DEFAULT_START_BLOCK,
    getLogs: getDepositedLogs,
    processLog: processDepositedLog,
  });
}

async function processDepositedLog(
  log: DepositedLog,
  blockTimeCache: Map<bigint, Date>
): Promise<void> {
  const player = log.args.player.toLowerCase();
  const actionIdHex = toHex(log.args.actionId);

  const deposit = await findDepositByActionId(actionIdHex);
  if (!deposit) {
    console.warn(
      `Deposited tx ${log.transactionHash}: no deposit for action ${actionIdHex}, skipping`
    );
    return;
  }
  if (deposit.confirmation_id !== null) return; // already confirmed

  const userId = await findUserIdByAddress(player);
  if (userId === null || userId !== deposit.user_id) {
    console.warn(
      `Deposited tx ${log.transactionHash}: deposit ${deposit.deposit_id} does not belong to ` +
        `player ${player}, skipping`
    );
    return;
  }

  const txTime = await getBlockTime(log.blockNumber, blockTimeCache);

  try {
    const { payout_id } = await confirmDepositEvent({
      deposit,
      player,
      paymentToken: log.args.paymentToken,
      amount: log.args.amount,
      txHash: log.transactionHash,
      txTime,
      source: 'deposit',
    });
    console.log(
      `synced Deposited tx ${log.transactionHash} (deposit ${deposit.deposit_id}, ` +
        `payout ${payout_id ?? 'none'}) for ${player}`
    );
  } catch (err) {
    if (err instanceof DepositAlreadyConfirmedError) return;
    if (err instanceof DepositMismatchError) {
      console.warn(`Deposited tx ${log.transactionHash}: ${err.message}, skipping`);
      return;
    }
    throw err;
  }
}

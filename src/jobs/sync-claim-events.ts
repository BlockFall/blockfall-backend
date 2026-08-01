import path from 'node:path';
import { toHex } from 'viem';
import { findPayoutByActionId, processClaim } from '../db/payouts.ts';
import { findUserIdByAddress } from '../db/users.ts';
import { type ClaimedLog, getClaimedLogs } from '../utils/celo-rpc-reader.ts';
import { getBlockTime, runBlockScan } from './block-scanner.ts';

// Run cadence — index.ts schedules this with maintainAsyncJob.
export const SYNC_CLAIM_INTERVAL_MS = 60 * 1000;

// Where to start scanning when there is no saved progress yet (contract
// deployment-ish block). Stored back to disk as the last scanned block.
const DEFAULT_START_BLOCK = 63688900n;

const PROGRESS_FILE = path.join('data', 'last-claim-block.txt');

/**
 * Backfills claims that the live /user_claims/submit flow missed: the payout
 * was claimed on-chain but the frontend never submitted the tx hash. Mirrors
 * the endpoint's validation, minus the checks that only make sense for an
 * authenticated request (the on-chain player is the source of truth here).
 */
export async function runSyncClaimJob(): Promise<void> {
  await runBlockScan<ClaimedLog>({
    label: 'Claimed',
    progressFile: PROGRESS_FILE,
    defaultStartBlock: DEFAULT_START_BLOCK,
    getLogs: getClaimedLogs,
    processLog: processClaimedLog,
  });
}

async function processClaimedLog(
  log: ClaimedLog,
  blockTimeCache: Map<bigint, Date>
): Promise<void> {
  const player = log.args.player.toLowerCase();
  const actionIdHex = toHex(log.args.actionId);
  const amount = log.args.amount.toString();

  const payout = await findPayoutByActionId(actionIdHex);
  if (!payout) {
    console.warn(
      `Claimed tx ${log.transactionHash}: no payout for action ${actionIdHex}, skipping`
    );
    return;
  }

  if (payout.claim_transaction_id !== null) {
    return; // already claimed under a different tx hash — nothing to backfill
  }

  const userId = await findUserIdByAddress(player);
  if (userId === null) {
    console.warn(`Claimed tx ${log.transactionHash}: no user for player ${player}, skipping`);
    return;
  }

  if (payout.user_id !== userId) {
    console.warn(
      `Claimed tx ${log.transactionHash}: payout ${payout.payout_id} belongs to user ` +
        `${payout.user_id}, not player ${player}, skipping`
    );
    return;
  }

  const txTime = await getBlockTime(log.blockNumber, blockTimeCache);

  const eventParams = {
    actionId: actionIdHex,
    player,
    paymentToken: log.args.paymentToken,
    amount,
  };

  await processClaim(userId, payout.payout_id, log.transactionHash, txTime, eventParams);

  console.log(
    `synced Claimed tx ${log.transactionHash} (payout ${payout.payout_id}) for ${player}`
  );
}

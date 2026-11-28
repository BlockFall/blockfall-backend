import { flushIngameEvents } from './db/game-plays.ts';
import {
  PROCESS_TOURNAMENT_INTERVAL_MS,
  runDailyTournamentJob,
} from './jobs/process-daily-tournament.ts';
import { runSyncClaimJob, SYNC_CLAIM_INTERVAL_MS } from './jobs/sync-claim-events.ts';
import { runSyncDepositJob, SYNC_DEPOSIT_INTERVAL_MS } from './jobs/sync-deposit-events.ts';
import {
  runSyncItemBoughtJob,
  SYNC_ITEM_BOUGHT_INTERVAL_MS,
} from './jobs/sync-item-bought-events.ts';
import {
  runSyncTransferDepositJob,
  SYNC_TRANSFER_DEPOSIT_INTERVAL_MS,
} from './jobs/sync-transfer-deposits.ts';
import { maintainAsyncJob } from './utils/index.ts';
import { startWebServer } from './webserver/index.ts';

maintainAsyncJob(flushIngameEvents, 1_000).catch((err: unknown) => {
  console.error('flush ingame events error:', err);
  process.exit(1);
});

maintainAsyncJob(runDailyTournamentJob, PROCESS_TOURNAMENT_INTERVAL_MS).catch((err: unknown) => {
  console.error('daily tournament job error:', err);
  process.exit(1);
});

maintainAsyncJob(runSyncItemBoughtJob, SYNC_ITEM_BOUGHT_INTERVAL_MS).catch((err: unknown) => {
  console.error('sync item bought job error:', err);
  process.exit(1);
});

maintainAsyncJob(runSyncClaimJob, SYNC_CLAIM_INTERVAL_MS).catch((err: unknown) => {
  console.error('sync claim job error:', err);
  process.exit(1);
});

maintainAsyncJob(runSyncDepositJob, SYNC_DEPOSIT_INTERVAL_MS).catch((err: unknown) => {
  console.error('sync deposit job error:', err);
  process.exit(1);
});

maintainAsyncJob(runSyncTransferDepositJob, SYNC_TRANSFER_DEPOSIT_INTERVAL_MS).catch(
  (err: unknown) => {
    console.error('sync transfer deposit job error:', err);
    process.exit(1);
  }
);

startWebServer().catch((err: unknown) => {
  console.error('webserver error:', err);
  process.exit(1);
});

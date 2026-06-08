import { flushIngameEvents } from './db/game-plays.ts';
import {
  PROCESS_TOURNAMENT_INTERVAL_MS,
  runDailyTournamentJob,
} from './jobs/process-daily-tournament.ts';
import {
  runSyncItemBoughtJob,
  SYNC_ITEM_BOUGHT_INTERVAL_MS,
} from './jobs/sync-item-bought-events.ts';
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

startWebServer().catch((err: unknown) => {
  console.error('webserver error:', err);
  process.exit(1);
});

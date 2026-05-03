import { flushIngameEvents } from './db/game-plays.ts';
import { maintainAsyncJob } from './utils/index.ts';
import { startWebServer } from './webserver/index.ts';

maintainAsyncJob(flushIngameEvents, 1_000).catch((err: unknown) => {
  console.error('flush ingame events error:', err);
  process.exit(1);
});

startWebServer().catch((err: unknown) => {
  console.error('webserver error:', err);
  process.exit(1);
});

import { startWebServer } from './webserver/index.ts';

startWebServer().catch((err: unknown) => {
  console.error('webserver error:', err);
  process.exit(1);
});

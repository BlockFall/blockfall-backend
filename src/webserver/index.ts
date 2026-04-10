import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import config from '../config.ts';

const app = new Hono()
  .get('/', (c) => c.json({ message: 'Hello from Blockfall!' }))
  .get('/health', (c) => c.json({ status: 'ok' as const }));

// Export the app type for use with hono/client on the frontend:
//   import { hc } from 'hono/client'
//   import type { AppType } from 'blockfall-backend/webserver'
//   const client = hc<AppType>('http://localhost:3000')
export type AppType = typeof app;

export function startWebServer(): Promise<void> {
  return new Promise((resolve) => {
    serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
      console.log(`Server running at http://${info.address}:${info.port.toString()}`);
      resolve();
    });
  });
}

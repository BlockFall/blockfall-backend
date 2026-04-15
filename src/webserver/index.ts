import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import config from '../config.ts';
import { authRoutes } from './routes/auth.ts';
import { checkinRoutes } from './routes/checkin.ts';
import { gameRoutes } from './routes/game.ts';
import { checkUserRoute, userRoutes } from './routes/user.ts';
import { purchaseRoutes } from './routes/purchase.ts';

const app = new Hono()
  .use('*', cors())
  .get('/', (c) => c.json({ message: 'Hello from Blockfall!' }))
  .get('/health', (c) => c.json({ status: 'ok' as const }))
  .route('/auth', authRoutes)
  .route('/user', userRoutes)
  .route('/checkuser', checkUserRoute)
  .route('/game', gameRoutes)
  .route('/purchase', purchaseRoutes)
  .route('/checkin', checkinRoutes);

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

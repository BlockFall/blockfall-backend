import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import config from '../config.ts';
import { authRoutes } from './routes/auth.ts';
import { checkinRoutes } from './routes/checkin.ts';
import { gameRoutes } from './routes/game.ts';
import { leaderboardRoutes } from './routes/leaderboard.ts';
import { purchaseRoutes } from './routes/purchase.ts';
import { checkUserRoute, userRoutes } from './routes/user.ts';
import { userClaimsRoutes } from './routes/userClaims.ts';

const app = new Hono()
  .use('*', cors())
  .get('/', (c) => c.json({ message: 'Hello from Blockfall!' }))
  .get('/health', (c) => c.json({ status: 'ok' as const }))
  .route('/auth', authRoutes)
  .route('/user', userRoutes)
  .route('/checkuser', checkUserRoute)
  .route('/game', gameRoutes)
  .route('/purchase', purchaseRoutes)
  .route('/user_claims', userClaimsRoutes)
  .route('/checkin', checkinRoutes)
  .route('/leaderboard', leaderboardRoutes);

// Export the app type for use with hono/client on the frontend:
//   import { hc } from 'hono/client'
//   import type { AppType } from 'blockfall-backend/webserver'
//   const client = hc<AppType>('http://localhost:3000')
export type AppType = typeof app;

export function startWebServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = createAdaptorServer({ fetch: app.fetch });
    server.listen(config.PORT, config.HOST, 10_000, () => {
      console.log(`Server running at http://${config.HOST}:${config.PORT}`);
      resolve();
    });
  });
}

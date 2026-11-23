import { Hono } from 'hono';
import { fetchGameStats } from '../../db/stats.ts';
import { makeSmartCached } from '../../utils/smart-cache.ts';

// Aggregate, non-personal numbers only — public, read by the UbeGames dashboard.
const getCachedStats = makeSmartCached(fetchGameStats, {
  cacheSeconds: 300,
  autoRefresh: true,
  fileBackupName: 'stats',
});

export const statsRoutes = new Hono().get('/', async (c) => {
  const stats = await getCachedStats();
  if (!stats) return c.json({ error: 'Stats not available yet' }, 503);
  c.header('Cache-Control', 'public, max-age=60');
  return c.json(stats);
});

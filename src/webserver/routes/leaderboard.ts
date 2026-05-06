import { Hono } from 'hono';
import {
  fetchOverallLeaderboard,
  fetchTodayLeaderboard,
  fetchYesterdayLeaderboard,
  type LeaderboardEntry,
  type YesterdayLeaderboardEntry,
} from '../../db/leaderboard.ts';
import { findUserIdByAddressCached } from '../../db/users.ts';
import { makeSmartCached } from '../../utils/smart-cache.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';

const TOP_N = 50;

const getCachedLeaderboards = makeSmartCached(
  async () => {
    const [yesterday, today, overall] = await Promise.all([
      fetchYesterdayLeaderboard(),
      fetchTodayLeaderboard(),
      fetchOverallLeaderboard(),
    ]);
    return { yesterday, today, overall };
  },
  { cacheSeconds: 10, autoRefresh: true, fileBackupName: 'leaderboard' }
);

function findMyRank<T extends LeaderboardEntry>(list: T[], userId: string): T | null {
  return list.find((e) => e.user_id === userId) ?? null;
}

export const leaderboardRoutes = new Hono<AuthEnv>().use(authMiddleware).get('/', async (c) => {
  const { address } = c.var.user;

  const user_id = await findUserIdByAddressCached(address);
  if (!user_id) {
    return c.json({ error: 'User not found' }, 404);
  }

  const cached = await getCachedLeaderboards();
  const yesterdayList: YesterdayLeaderboardEntry[] = cached?.yesterday ?? [];
  const todayList: LeaderboardEntry[] = cached?.today ?? [];
  const overallList: LeaderboardEntry[] = cached?.overall ?? [];

  return c.json({
    yesterday: {
      top: yesterdayList.slice(0, TOP_N),
      my_rank: findMyRank(yesterdayList, user_id),
    },
    today: {
      top: todayList.slice(0, TOP_N),
      my_rank: findMyRank(todayList, user_id),
    },
    overall: {
      top: overallList.slice(0, TOP_N),
      my_rank: findMyRank(overallList, user_id),
    },
  });
});

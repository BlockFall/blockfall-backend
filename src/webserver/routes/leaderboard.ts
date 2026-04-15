import { Hono } from 'hono';
import {
  fetchOverallLeaderboard,
  fetchTodayLeaderboard,
  fetchYesterdayLeaderboard,
  type LeaderboardEntry,
  type YesterdayLeaderboardEntry,
} from '../../db/leaderboard.ts';
import { findUserByAddress } from '../../db/users.ts';
import { makeSmartCached } from '../../utils/smart-cache.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';

const TOP_N = 50;

const getYesterday = makeSmartCached(fetchYesterdayLeaderboard, { cacheSeconds: 86_400 });
const getToday = makeSmartCached(fetchTodayLeaderboard, { cacheSeconds: 15 });
const getOverall = makeSmartCached(fetchOverallLeaderboard, { cacheSeconds: 15 });

function findMyRank<T extends LeaderboardEntry>(list: T[], userId: string): T | null {
  return list.find((e) => e.user_id === userId) ?? null;
}

export const leaderboardRoutes = new Hono<AuthEnv>()
  .use(authMiddleware)
  .get('/', async (c) => {
    const { address } = c.var.user;

    const user = await findUserByAddress(address);
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    const [yesterday, today, overall] = await Promise.all([
      getYesterday(),
      getToday(),
      getOverall(),
    ]);

    const yesterdayList: YesterdayLeaderboardEntry[] = yesterday ?? [];
    const todayList: LeaderboardEntry[] = today ?? [];
    const overallList: LeaderboardEntry[] = overall ?? [];

    return c.json({
      yesterday: {
        top: yesterdayList.slice(0, TOP_N),
        my_rank: findMyRank(yesterdayList, user.user_id),
      },
      today: {
        top: todayList.slice(0, TOP_N),
        my_rank: findMyRank(todayList, user.user_id),
      },
      overall: {
        top: overallList.slice(0, TOP_N),
        my_rank: findMyRank(overallList, user.user_id),
      },
    });
  });

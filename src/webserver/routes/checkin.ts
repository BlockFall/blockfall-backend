import { Hono } from 'hono';
import { getLastSevenDayCheckins, performDailyCheckin } from '../../db/daily-checkins.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';

export const checkinRoutes = new Hono<AuthEnv>()
  .use(authMiddleware)

  // GET /checkin — last seven days (UTC) with a checked_in flag per date
  .get('/', async (c) => {
    const { user_id } = c.var.user;

    const days = await getLastSevenDayCheckins(user_id);
    return c.json({ days });
  })

  // POST /checkin — perform today's check-in; grants 1 energy, and a mystery
  // box on every 7th consecutive day.
  .post('/', async (c) => {
    const { user_id } = c.var.user;

    const result = await performDailyCheckin(user_id);
    if (!result) {
      return c.json({ error: 'Already checked in today' }, 409);
    }

    return c.json(result);
  });

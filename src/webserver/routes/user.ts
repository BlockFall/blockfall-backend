import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { findUserByAddress, getUserInventory, getUserWithNumbers } from '../../db/users.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';

/**
 * GET /user — returns the authenticated user's profile + stats
 * Requires a valid Bearer JWT.
 */
export const userRoutes = new Hono<AuthEnv>().use(authMiddleware).get('/', async (c) => {
  const { address } = c.var.user;

  const user = await getUserWithNumbers(address);
  if (!user) {
    return c.json({ error: 'User not found. Please sign up first.' }, 404);
  }

  const inventory = await getUserInventory(user.user_id);

  return c.json({
    user_id: user.user_id,
    address: user.address,
    name: user.name,
    created_at: user.created_at,
    stats: {
      best_score: user.best_score,
      last_score: user.last_score,
      games_played: user.games_played,
      total_score: user.total_score,
      today_score: user.today_score,
      energy: user.energy,
    },
    inventory,
  });
});

/**
 * GET /checkuser?account — check if a wallet address is already registered.
 * Public endpoint — no auth required.
 */
export const checkUserRoute = new Hono().get(
  '/',
  validator('query', (value, c) => {
    const result = z
      .object({
        account: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/, 'account must be a valid Ethereum address'),
      })
      .safeParse(value);
    if (!result.success) {
      return c.json({ error: 'Invalid account address', details: result.error.issues }, 400);
    }
    return result.data;
  }),
  async (c) => {
    const { account } = c.req.valid('query');
    const user = await findUserByAddress(account);

    if (!user) {
      return c.json({ registered: false });
    }

    return c.json({ registered: true, name: user.name });
  }
);

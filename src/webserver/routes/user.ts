import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { getPendingPayouts } from '../../db/payouts.ts';
import {
  findUserByAddress,
  getUserInventory,
  getUserWithNumbers,
  renameUser,
} from '../../db/users.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';
import { nameSchema } from './auth.ts';

/**
 * GET  /user         — authenticated user's profile + stats
 * POST /user/rename  — change the authenticated user's display name
 */
export const userRoutes = new Hono<AuthEnv>()
  .use(authMiddleware)
  .get('/', async (c) => {
    const { address } = c.var.user;

    const user = await getUserWithNumbers(address);
    if (!user) {
      return c.json({ error: 'User not found. Please sign up first.' }, 404);
    }

    const [inventory, pendingClaims] = await Promise.all([
      getUserInventory(user.user_id),
      getPendingPayouts(user.user_id),
    ]);

    return c.json({
      user_id: user.user_id,
      address: user.address,
      name: user.name,
      user_source: user.user_source,
      is_banned: user.is_banned,
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
      pending_claims: pendingClaims,
    });
  })
  .post(
    '/rename',
    validator('json', (value, c) => {
      const result = z.object({ name: nameSchema }).safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid request body', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { address } = c.var.user;
      const { name } = c.req.valid('json');

      const result = await renameUser(address, name);
      if (!result.success) {
        if (result.reason === 'user_not_found') {
          return c.json({ error: 'User not found. Please sign up first.' }, 404);
        }
        if (result.reason === 'name_taken') {
          return c.json({ error: 'This name is already taken.' }, 409);
        }
        // no_change — name matches the current one; nothing to do.
        return c.json({ name });
      }

      return c.json({ name });
    }
  );

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

import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { openMysteryBox } from '../../db/mystery-box.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';

const openBodySchema = z.object({
  item_id: z.string().regex(/^\d+$/, 'item_id must be a numeric string'),
});

export const mysteryBoxRoutes = new Hono<AuthEnv>()
  .use(authMiddleware)

  // POST /mystery-box/open — opens a mystery box from the user's inventory.
  .post(
    '/open',
    validator('json', (value, c) => {
      const result = openBodySchema.safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid request body', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { user_id } = c.var.user;
      const { item_id } = c.req.valid('json');

      const result = await openMysteryBox(user_id, item_id);
      if (!result.success) {
        return c.json({ error: 'Mystery box not found or already opened' }, 404);
      }

      return c.json({
        prize_item_type: result.prize_item_type,
        prize_user_item_id: result.prize_user_item_id,
        energy_granted: result.energy_granted,
      });
    }
  );

import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { activateBooster } from '../../db/boosters.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';

const activateBodySchema = z.object({
  item_id: z.string().regex(/^\d+$/, 'item_id must be a numeric string'),
});

export const boosterRoutes = new Hono<AuthEnv>()
  .use(authMiddleware)

  // POST /booster/activate — consumes a booster item from the user's inventory
  // and starts its boost window. While the window is open, /game/start stamps
  // the booster's multiplier onto new game_plays.
  .post(
    '/activate',
    validator('json', (value, c) => {
      const result = activateBodySchema.safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid request body', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { user_id } = c.var.user;
      const { item_id } = c.req.valid('json');

      const outcome = await activateBooster(user_id, item_id);
      if (!outcome.ok) {
        switch (outcome.error) {
          case 'item_not_found':
            return c.json({ error: 'Booster item not found' }, 404);
          case 'item_already_used':
            return c.json({ error: 'Booster item has already been used' }, 409);
          case 'booster_already_active':
            return c.json({ error: 'A booster is already active' }, 409);
        }
      }

      const { activation } = outcome;
      return c.json({
        user_booster_activation_id: activation.user_booster_activation_id,
        item_id: activation.item_id,
        multiplier: activation.multiplier,
        started_at: activation.started_at,
        expires_at: activation.expires_at,
      });
    }
  );

import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { findUserByAddress } from '../../db/users.ts';
import { startGamePlay, endGamePlay, getOrCreateTodayTournament } from '../../db/game-plays.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';

export const gameRoutes = new Hono<AuthEnv>()
  .use(authMiddleware)

  // POST /game/start — begin a new game play session
  .post('/start', async (c) => {
    const { address } = c.var.user;

    const user = await findUserByAddress(address);
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    const dayId = await getOrCreateTodayTournament();
    const gamePlay = await startGamePlay(user.user_id, dayId);

    if (!gamePlay) {
      return c.json({ error: 'Not enough energy' }, 400);
    }

    return c.json({
      game_play_id: gamePlay.game_play_id,
      started_at: gamePlay.started_at,
    });
  })

  // POST /game/end — finish a game play session with a score
  .post(
    '/end',
    validator('json', (value, c) => {
      const result = z
        .object({
          game_play_id: z.string().min(1),
          score: z.number().int().min(0),
        })
        .safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid request body', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { address } = c.var.user;
      const { game_play_id, score } = c.req.valid('json');

      const user = await findUserByAddress(address);
      if (!user) {
        return c.json({ error: 'User not found' }, 404);
      }

      const gamePlay = await endGamePlay(game_play_id, user.user_id, score);

      if (!gamePlay) {
        return c.json(
          { error: 'Invalid game play: not found, already ended, or session expired (15 min limit)' },
          400,
        );
      }

      return c.json({
        game_play_id: gamePlay.game_play_id,
        score: gamePlay.score,
        started_at: gamePlay.started_at,
        ended_at: gamePlay.ended_at,
      });
    },
  );

import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import {
  bufferIngameEvent,
  endGamePlay,
  getOrCreateTodayTournament,
  startGamePlay,
} from '../../db/game-plays.ts';
import { findUserByAddressCached } from '../../db/users.ts';
import { dateFromId } from '../../utils/index.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';

export const gameRoutes = new Hono<AuthEnv>()
  .use(authMiddleware)

  // POST /game/start — begin a new game play session
  .post('/start', async (c) => {
    const { address } = c.var.user;

    const user = await findUserByAddressCached(address);
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
      started_at: dateFromId(gamePlay.game_play_id),
    });
  })

  // POST /game/end — finish a game play session with a score
  .post(
    '/end',
    validator('json', (value, c) => {
      const result = z
        .object({
          game_play_id: z.string().min(1),
          score: z.number().int().min(0).max(200_000),
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

      const user = await findUserByAddressCached(address);
      if (!user) {
        return c.json({ error: 'User not found' }, 404);
      }

      const outcome = await endGamePlay(game_play_id, user.user_id, score);

      if (!outcome.ok) {
        switch (outcome.error) {
          case 'invalid_session':
            return c.json(
              { error: 'Invalid game play: not found, wrong user, or already ended' },
              400
            );
          case 'session_expired':
          case 'time_too_short':
          case 'too_few_line_clears':
            return c.json({ error: 'Suspicious activity' }, 422);
        }
      }

      const { result } = outcome;
      return c.json({
        game_play_id: result.game_play_id,
        score: result.score,
        started_at: dateFromId(result.game_play_id),
        ended_at: result.ended_at,
      });
    }
  )

  // POST /game/event — record an in-game analytics event (pause, resume,
  // line_clear, etc.). event_time is server-generated.
  .post(
    '/event',
    validator('json', (value, c) => {
      const result = z
        .object({
          game_play_id: z.string().min(1),
          event_type: z.string().min(1).max(64),
          intval: z.number().int().nullish(),
          textval: z.string().max(1024).nullish(),
          extra_data: z.unknown().nullish(),
        })
        .safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid request body', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { address } = c.var.user;
      const { game_play_id, event_type, intval, textval, extra_data } = c.req.valid('json');

      const user = await findUserByAddressCached(address);
      if (!user) {
        return c.json({ error: 'User not found' }, 404);
      }

      // Buffered: returns immediately. Ownership and not-yet-ended checks are
      // applied at flush time (every ~1s) — bad rows are silently dropped.
      const { event_time } = bufferIngameEvent(
        game_play_id,
        user.user_id,
        event_type,
        intval ?? null,
        textval ?? null,
        extra_data ?? null
      );

      return c.json({ event_time });
    }
  );

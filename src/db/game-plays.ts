import { dateFromId, generateId } from '../utils/index.ts';
import { sql } from './index.ts';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface GamePlayRow {
  game_play_id: string;
  user_id: string;
  daily_tournament_id: string;
  boost_multiplier: number;
}

export interface GamePlayResultRow {
  game_play_id: string;
  ended_at: Date;
  score: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Starts a game play session. Transactionally:
 * 1. Checks that user has energy > 0
 * 2. Decrements energy by 1
 * 3. Inserts a new game_plays row
 *
 * Returns the new game play row, or null if energy is 0.
 */
export async function startGamePlay(userId: string, dayId: string): Promise<GamePlayRow | null> {
  const gamePlayId = generateId().toString();

  const rows = await sql.begin(async (tx) => {
    // Decrement energy and increment games_played atomically;
    // the WHERE energy > 0 prevents going below zero.
    const updated = await tx<{ energy: number }[]>`
      UPDATE user_numbers
      SET    energy = energy - 1,
             games_played = games_played + 1,
             updated_at = now()
      WHERE  user_id = ${userId}
        AND  energy > 0
      RETURNING energy
    `;

    if (updated.length === 0) {
      return null;
    }

    const inserted = await tx<GamePlayRow[]>`
      INSERT INTO game_plays (game_play_id, user_id, daily_tournament_id, boost_multiplier)
      VALUES (
        ${gamePlayId},
        ${userId},
        ${dayId},
        COALESCE(
          (SELECT multiplier FROM user_active_boost
           WHERE user_id = ${userId} AND expires_at > now()),
          100
        )
      )
      RETURNING game_play_id, user_id, daily_tournament_id, boost_multiplier
    `;

    return inserted;
  });

  return rows?.[0] ?? null;
}

const GAME_PLAY_MAX_DURATION_MS = 15 * 60 * 1000;

/**
 * Sums durations of all pause→resume intervals for a game play. If the last
 * pause has no matching resume, that interval extends to now() (the user is
 * still paused at end-of-game).
 */
async function getPausedDurationMs(gamePlayId: string): Promise<number> {
  const rows = await sql<{ paused_ms: string }[]>`
    WITH pr AS (
      SELECT event_time,
             event_type,
             LEAD(event_time) OVER (ORDER BY event_time, event_id) AS next_time,
             LEAD(event_type) OVER (ORDER BY event_time, event_id) AS next_type
      FROM   game_ingame_events
      WHERE  game_play_id = ${gamePlayId}
        AND  event_type IN ('pause', 'resume')
    )
    SELECT COALESCE(
             SUM(EXTRACT(EPOCH FROM (COALESCE(next_time, now()) - event_time)) * 1000),
             0
           )::BIGINT AS paused_ms
    FROM   pr
    WHERE  event_type = 'pause'
      AND  (next_type = 'resume' OR next_type IS NULL)
  `;
  return Number(rows[0]?.paused_ms ?? 0);
}

/**
 * Ends a game play session. Validates:
 * 1. The game play exists and belongs to the given user
 * 2. It hasn't already ended (no row in game_play_results)
 * 3. Active play time is within 15 minutes (wall-clock since start, minus
 *    pause→resume intervals from game_ingame_events)
 *
 * Inserts a game_play_results row, and updates user_numbers
 * (last_score, best_score, total_score).
 *
 * Returns the inserted result row, or null if validation fails.
 */
export async function endGamePlay(
  gamePlayId: string,
  userId: string,
  score: number
): Promise<GamePlayResultRow | null> {
  const startedAt = dateFromId(gamePlayId);
  const pausedMs = await getPausedDurationMs(gamePlayId);
  if (Date.now() - startedAt.getTime() - pausedMs > GAME_PLAY_MAX_DURATION_MS) {
    return null;
  }

  const rows = await sql.begin(async (tx) => {
    // Atomic insert: succeeds only if the game_play exists with the right
    // user and no result row exists yet. PK on game_play_results prevents
    // double-end races.
    const inserted = await tx<GamePlayResultRow[]>`
      INSERT INTO game_play_results (game_play_id, ended_at, score)
      SELECT ${gamePlayId}, now(), ${score}
      WHERE EXISTS (
        SELECT 1 FROM game_plays
        WHERE game_play_id = ${gamePlayId}
          AND user_id = ${userId}
      )
      ON CONFLICT (game_play_id) DO NOTHING
      RETURNING game_play_id, ended_at, score
    `;

    if (inserted.length === 0) {
      return null;
    }

    await tx`
      UPDATE user_numbers
      SET    last_score  = ${score},
             best_score  = GREATEST(best_score, ${score}),
             total_score = total_score + ${score},
             updated_at  = now()
      WHERE  user_id = ${userId}
    `;

    return inserted;
  });

  return rows?.[0] ?? null;
}

export interface IngameEventRow {
  event_id: string;
  game_play_id: string;
  event_time: Date;
  event_type: string;
  intval: number | null;
  textval: string | null;
  extra_data: unknown;
}

/**
 * Inserts an in-game analytics event. Verifies the game_play exists, belongs
 * to the given user, and has not yet ended. Returns the inserted row, or
 * null if those checks fail.
 */
export async function insertIngameEvent(
  gamePlayId: string,
  userId: string,
  eventType: string,
  intval: number | null,
  textval: string | null,
  extraData: unknown
): Promise<IngameEventRow | null> {
  const eventId = generateId().toString();
  const extraJson = extraData === null || extraData === undefined ? null : JSON.stringify(extraData);

  const inserted = await sql<IngameEventRow[]>`
    INSERT INTO game_ingame_events (event_id, game_play_id, event_time, event_type, intval, textval, extra_data)
    SELECT ${eventId}, ${gamePlayId}, now(), ${eventType}, ${intval}, ${textval}, ${extraJson}::jsonb
    WHERE EXISTS (
      SELECT 1 FROM game_plays
      WHERE game_play_id = ${gamePlayId}
        AND user_id = ${userId}
    )
    AND NOT EXISTS (
      SELECT 1 FROM game_play_results
      WHERE game_play_id = ${gamePlayId}
    )
    RETURNING event_id, game_play_id, event_time, event_type, intval, textval, extra_data
  `;

  return inserted[0] ?? null;
}

/**
 * Gets today's tournament, creating it if it doesn't exist.
 */
export async function getOrCreateTodayTournament(): Promise<string> {
  const existing = await sql<{ daily_tournament_id: string }[]>`
    SELECT daily_tournament_id
    FROM   daily_tournaments
    WHERE  tournament_date = (now() AT TIME ZONE 'UTC')::date
  `;

  if (existing[0]) {
    return existing[0].daily_tournament_id;
  }

  const tournamentId = generateId().toString();
  await sql`
    INSERT INTO daily_tournaments (daily_tournament_id, tournament_date)
    VALUES (${tournamentId}, (now() AT TIME ZONE 'UTC')::date)
    ON CONFLICT (tournament_date) DO NOTHING
  `;

  // Re-fetch in case of race condition
  const rows = await sql<{ daily_tournament_id: string }[]>`
    SELECT daily_tournament_id
    FROM   daily_tournaments
    WHERE  tournament_date = (now() AT TIME ZONE 'UTC')::date
  `;
  if (rows[0] == null) {
    throw new Error("Failed to create or fetch today's tournament");
  }
  return rows[0].daily_tournament_id;
}

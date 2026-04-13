import { sql } from './index.ts';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type GamePlayRow = {
  game_play_id: string;
  user_id: string;
  started_at: Date;
  ended_at: Date | null;
  score: number | null;
  day_id: string;
};

// ---------------------------------------------------------------------------
// ID generation (same as users.ts)
// ---------------------------------------------------------------------------

function generateId(): bigint {
  const ts = BigInt(Date.now()) & 0x3ffffffffffn;
  const rand = BigInt(Math.floor(Math.random() * (1 << 21)));
  return (ts << 21n) | rand;
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
    // Decrement energy atomically; the WHERE energy > 0 prevents going below zero.
    const updated = await tx<{ energy: number }[]>`
      UPDATE user_numbers
      SET    energy = energy - 1,
             updated_at = now()
      WHERE  user_id = ${userId}
        AND  energy > 0
      RETURNING energy
    `;

    if (updated.length === 0) {
      return null;
    }

    const inserted = await tx<GamePlayRow[]>`
      INSERT INTO game_plays (game_play_id, user_id, started_at, day_id)
      VALUES (${gamePlayId}, ${userId}, now(), ${dayId})
      RETURNING game_play_id, user_id, started_at, ended_at, score, day_id
    `;

    return inserted;
  });

  return rows?.[0] ?? null;
}

/**
 * Ends a game play session. Validates:
 * 1. The game play belongs to the given user
 * 2. It hasn't already ended
 * 3. It started within the last 15 minutes
 *
 * Updates score and ended_at, and also updates user_numbers
 * (last_score, best_score, total_score).
 *
 * Returns the updated game play row, or null if validation fails.
 */
export async function endGamePlay(
  gamePlayId: string,
  userId: string,
  score: number,
): Promise<GamePlayRow | null> {
  const rows = await sql.begin(async (tx) => {
    // Fetch and validate the game play
    const existing = await tx<GamePlayRow[]>`
      SELECT game_play_id, user_id, started_at, ended_at, score, day_id
      FROM   game_plays
      WHERE  game_play_id = ${gamePlayId}
        AND  user_id = ${userId}
        AND  ended_at IS NULL
        AND  started_at > now() - interval '15 minutes'
      FOR UPDATE
    `;

    if (existing.length === 0) {
      return null;
    }

    // Update the game play with score and end time
    const updated = await tx<GamePlayRow[]>`
      UPDATE game_plays
      SET    score = ${score},
             ended_at = now()
      WHERE  game_play_id = ${gamePlayId}
      RETURNING game_play_id, user_id, started_at, ended_at, score, day_id
    `;

    // Update user_numbers: last_score, best_score, total_score
    await tx`
      UPDATE user_numbers
      SET    last_score  = ${score},
             best_score  = GREATEST(best_score, ${score}),
             total_score = total_score + ${score},
             updated_at  = now()
      WHERE  user_id = ${userId}
    `;

    return updated;
  });

  return rows?.[0] ?? null;
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
  return rows[0]!.daily_tournament_id;
}

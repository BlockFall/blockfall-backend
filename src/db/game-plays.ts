import { dateFromId } from '../utils/index.ts';
import { sql, withTransaction } from './index.ts';

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
  return withTransaction(async (tx) => {
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
      INSERT INTO game_plays (user_id, daily_tournament_id, boost_multiplier)
      VALUES (
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

    return inserted[0] ?? null;
  });
}

const GAME_PLAY_MAX_DURATION_MS = 30 * 60 * 1000;

// Anti-cheat: minimum active play time required to be eligible for a score.
function requiredPlayMs(score: number): number {
  if (score >= 50_000) return 3 * 60_000;
  if (score >= 25_000) return 1 * 60_000;
  if (score >= 10_000) return 1 * 60_000;
  return 0;
}

// Anti-cheat: minimum line_clear events required to be eligible for a score.
function requiredLineClears(score: number): number {
  if (score >= 6_000) return 20;
  if (score >= 3_000) return 8;
  if (score >= 1_000) return 4;
  return 0;
}

export type EndGamePlayError =
  | 'invalid_session' // not found, wrong user, or already ended
  | 'session_expired' // active play time exceeded 30-min cap
  | 'time_too_short' // score too high for elapsed active play time
  | 'too_few_line_clears'; // score too high for observed line_clear count

export type EndGamePlayOutcome =
  | { ok: true; result: GamePlayResultRow }
  | { ok: false; error: EndGamePlayError };

/**
 * Single roundtrip to compute:
 * - paused_ms: total duration spent in pause→resume intervals (an unmatched
 *   trailing pause extends to now())
 * - line_clears: count of `line_clear` events
 *
 * Caller should flush the in-memory event buffer first so recent events are
 * visible.
 */
async function getGamePlayStats(
  gamePlayId: string
): Promise<{ pausedMs: number; lineClears: number }> {
  const rows = await sql<{ paused_ms: string; line_clears: string }[]>`
    WITH pr AS (
      SELECT event_time,
             event_type,
             LEAD(event_time) OVER (ORDER BY event_time, event_id) AS next_time,
             LEAD(event_type) OVER (ORDER BY event_time, event_id) AS next_type
      FROM   game_ingame_events
      WHERE  game_play_id = ${gamePlayId}
        AND  event_type IN ('pause', 'resume')
    )
    SELECT
      (SELECT COALESCE(
                SUM(EXTRACT(EPOCH FROM (COALESCE(next_time, now()) - event_time)) * 1000),
                0
              )::BIGINT
       FROM   pr
       WHERE  event_type = 'pause'
         AND  (next_type = 'resume' OR next_type IS NULL)) AS paused_ms,
      (SELECT SUM(intval)::BIGINT
       FROM   game_ingame_events
       WHERE  game_play_id = ${gamePlayId}
         AND  event_type   = 'line_clear') AS line_clears
  `;
  return {
    pausedMs: Number(rows[0]?.paused_ms ?? 0),
    lineClears: Number(rows[0]?.line_clears ?? 0),
  };
}

/**
 * Ends a game play session. Validates:
 * 1. Active play time is within 30 minutes (wall-clock since start, minus
 *    pause→resume intervals from game_ingame_events)
 * 2. Score is plausible for the observed active play time
 * 3. Score is plausible for the observed line_clear event count
 * 4. The game play exists, belongs to the given user, and hasn't ended yet
 *
 * On success inserts a game_play_results row and updates user_numbers
 * (last_score, best_score, total_score).
 */
export async function endGamePlay(
  gamePlayId: string,
  userId: string,
  score: number
): Promise<EndGamePlayOutcome> {
  const startedAt = dateFromId(gamePlayId);
  await flushIngameEvents();
  const { pausedMs, lineClears } = await getGamePlayStats(gamePlayId);
  const activePlayMs = Date.now() - startedAt.getTime() - pausedMs;

  if (activePlayMs > GAME_PLAY_MAX_DURATION_MS) {
    return { ok: false, error: 'session_expired' };
  }
  if (activePlayMs < requiredPlayMs(score)) {
    return { ok: false, error: 'time_too_short' };
  }
  if (lineClears < requiredLineClears(score)) {
    return { ok: false, error: 'too_few_line_clears' };
  }

  const result = await withTransaction(async (tx) => {
    // Atomic insert: succeeds only if the game_play exists with the right
    // user and no result row exists yet. PK on game_play_results prevents
    // double-end races.
    const inserted = await tx<GamePlayResultRow[]>`
      INSERT INTO game_play_results (game_play_id, score)
      SELECT ${gamePlayId}, ${score}
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

    // today_score is keyed on the *game's* tournament_date, not now()::date —
    // a play started near midnight UTC may end after the day rolls over but
    // still belongs to yesterday's tournament. GREATEST treats NULL as
    // missing, so a fresh row (today_score_date IS NULL) is initialized to
    // dt.tournament_date. The CASE only resets today_score forward in time;
    // a late-finishing play from an earlier day must not overwrite a newer
    // day's accumulated score.
    await tx`
      UPDATE user_numbers
      SET    last_score        = ${score},
             best_score        = GREATEST(best_score, ${score}),
             total_score       = total_score + ${score},
             today_score       = CASE
               WHEN user_numbers.today_score_date = dt.tournament_date
                 THEN user_numbers.today_score + ${score}
               WHEN user_numbers.today_score_date IS NULL
                 OR user_numbers.today_score_date < dt.tournament_date
                 THEN ${score}
               ELSE user_numbers.today_score
             END,
             today_score_date  = GREATEST(user_numbers.today_score_date, dt.tournament_date),
             updated_at        = now()
      FROM   game_plays gp
      JOIN   daily_tournaments dt ON dt.daily_tournament_id = gp.daily_tournament_id
      WHERE  user_numbers.user_id = ${userId}
        AND  gp.game_play_id = ${gamePlayId}
    `;

    return inserted[0] ?? null;
  });

  if (!result) {
    return { ok: false, error: 'invalid_session' };
  }
  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// In-game events: buffered batch insert
//
// The /game/event endpoint is high-frequency (pause, resume, line_clear, …),
// so we don't write per-request. Events are pushed into an in-memory buffer
// and flushed by a 1s timer (see index.ts)
// ---------------------------------------------------------------------------

interface BufferedIngameEvent {
  game_play_id: string;
  event_time: Date;
  event_type: string;
  intval: number | null;
  textval: string | null;
  extra_data_json: string | null;
}

let ingameEventBuffer: BufferedIngameEvent[] = [];
let flushInFlight: Promise<void> | null = null;

export function bufferIngameEvent(
  gamePlayId: string,
  eventType: string,
  intval: number | null,
  textval: string | null,
  extraData: unknown
): { event_time: Date } {
  const event_time = new Date();
  ingameEventBuffer.push({
    game_play_id: gamePlayId,
    event_time,
    event_type: eventType,
    intval,
    textval,
    extra_data_json:
      extraData === null || extraData === undefined ? null : JSON.stringify(extraData),
  });
  return { event_time };
}

async function doFlushIngameEvents(): Promise<void> {
  if (ingameEventBuffer.length === 0) return;
  const batch = ingameEventBuffer;
  ingameEventBuffer = [];

  try {
    await sql`
      INSERT INTO game_ingame_events (game_play_id, event_time, event_type, intval, textval, extra_data)
      SELECT t.game_play_id::bigint,
             t.event_time::timestamptz,
             t.event_type,
             t.intval::int,
             t.textval,
             t.extra_data::jsonb
      FROM   UNNEST(
               ${batch.map((e) => e.game_play_id)}::text[],
               ${sql.array(batch.map((e) => e.event_time))}::timestamptz[],
               ${batch.map((e) => e.event_type)}::text[],
               ${batch.map((e) => e.intval)}::int[],
               ${batch.map((e) => e.textval)}::text[],
               ${batch.map((e) => e.extra_data_json)}::text[]
             ) AS t(game_play_id, event_time, event_type, intval, textval, extra_data)
      WHERE  EXISTS (
               SELECT 1 FROM game_plays gp
               WHERE  gp.game_play_id = t.game_play_id::bigint
             )
        AND  NOT EXISTS (
               SELECT 1 FROM game_play_results gpr
               WHERE  gpr.game_play_id = t.game_play_id::bigint
             )
    `;
  } catch (err) {
    console.error('flush ingame events failed:', err);
  }
}

/**
 * Flushes the in-game event buffer. Concurrent calls share a single in-flight
 * flush so the bulk insert never overlaps itself.
 */
export function flushIngameEvents(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = doFlushIngameEvents().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
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

  await sql`
    INSERT INTO daily_tournaments (tournament_date)
    VALUES ((now() AT TIME ZONE 'UTC')::date)
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

import type postgres from 'postgres';
import { withTransaction } from '../db/index.ts';

type Sql = postgres.Sql | postgres.ReservedSql | postgres.TransactionSql;

// Criteria thresholds — tweak here if cheating patterns shift.
const AVG_SCORE_THRESHOLD = 70_000;
const MIN_GAMES_FOR_AVG = 3;
const SCORE_RANGE_MAX = 10_000;
const MIN_SCORE_FOR_RANGE = 50_000;
const MAX_USERS_PER_IP = 20;

/**
 * Bans users in `dailyTournamentId` whose play patterns match any of the
 * cheating heuristics below. Inserts a fresh `user_mutable_data` row with
 * `is_banned = true` per banned user, preserving their current name. Already-
 * banned users are skipped so re-runs don't create duplicate ban rows.
 *
 * Criteria (any one match → ban):
 *  1. Average score > 70k AND >3 completed games — sustained high scores.
 *  2. Score range (max-min) < 10k AND min score > 50k across > 3 games —
 *     suspiciously tight cluster at a high level (bot-like).
 *  3. All users sharing an IP that >20 distinct accounts played from —
 *     multi-accounting / farm.
 *
 * Returns the banned user_ids (empty if no one matched). Pass an existing
 * `tx` to run inside a caller's transaction (e.g. processDailyTournamentTick);
 * otherwise this opens its own short transaction.
 */
export async function banSuspiciousUsers(dailyTournamentId: string, tx?: Sql): Promise<string[]> {
  if (tx) {
    return runBan(tx, dailyTournamentId);
  }
  return withTransaction((t) => runBan(t, dailyTournamentId));
}

async function runBan(tx: Sql, dailyTournamentId: string): Promise<string[]> {
  const rows = await tx<{ user_id: string }[]>`
    WITH cheaters AS (
      -- Criterion 1: high average across many games.
      SELECT gp.user_id
      FROM   game_plays gp
      JOIN   game_play_results gpr ON gpr.game_play_id = gp.game_play_id
      WHERE  gp.daily_tournament_id = ${dailyTournamentId}
      GROUP BY gp.user_id
      HAVING AVG(gpr.score * 100.0 / gp.boost_multiplier) > ${AVG_SCORE_THRESHOLD}
         AND COUNT(*) > ${MIN_GAMES_FOR_AVG}

      UNION

      -- Criterion 2: tight high-score cluster on unboosted scores.
      SELECT gp.user_id
      FROM   game_plays gp
      JOIN   game_play_results gpr ON gpr.game_play_id = gp.game_play_id
      WHERE  gp.daily_tournament_id = ${dailyTournamentId}
      GROUP BY gp.user_id
      HAVING COUNT(*) > 3
         AND MAX(gpr.score * 100.0 / gp.boost_multiplier)
           - MIN(gpr.score * 100.0 / gp.boost_multiplier) < ${SCORE_RANGE_MAX}
         AND MIN(gpr.score * 100.0 / gp.boost_multiplier) > ${MIN_SCORE_FOR_RANGE}

      UNION

      -- Criterion 3: every user playing from a shared IP with >20 distinct accounts on it.
      SELECT DISTINCT gp.user_id
      FROM   game_plays gp
      WHERE  gp.daily_tournament_id = ${dailyTournamentId}
        AND  gp.ip_address IS NOT NULL
        AND  gp.ip_address IN (
          SELECT ip_address
          FROM   game_plays
          WHERE  daily_tournament_id = ${dailyTournamentId}
            AND  ip_address IS NOT NULL
          GROUP BY ip_address
          HAVING COUNT(DISTINCT user_id) > ${MAX_USERS_PER_IP}
        )
    )
    INSERT INTO user_mutable_data (user_id, name, is_banned)
    SELECT u.user_id, u.name, TRUE
    FROM   cheaters c
    JOIN   users_with_data u ON u.user_id = c.user_id
    WHERE  NOT u.is_banned
    RETURNING user_id
  `;
  return rows.map((r) => r.user_id);
}

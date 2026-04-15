import { sql } from './index.ts';

// ---------------------------------------------------------------------------
// Row types
// postgres.js: BIGINT → string, NUMERIC → string, INT → number.
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  user_id: string;
  name: string;
  address: string;
  total_score: number;
  rank: number;
}

export interface YesterdayLeaderboardEntry extends LeaderboardEntry {
  reward: string | null;
}

// ---------------------------------------------------------------------------
// Queries — each returns the FULL sorted list so callers can both slice the
// top-N and look up any user's rank without a second query.
// ---------------------------------------------------------------------------

export async function fetchYesterdayLeaderboard(): Promise<YesterdayLeaderboardEntry[]> {
  return sql<YesterdayLeaderboardEntry[]>`
    SELECT u.user_id,
           u.name,
           u.address,
           dts.total_score,
           dts.rank,
           p.amount AS reward
    FROM   daily_total_scores dts
    JOIN   users u ON u.user_id = dts.user_id
    LEFT JOIN daily_tournaments dt ON dt.tournament_date = dts.score_date
    LEFT JOIN user_payouts p
           ON p.user_id = dts.user_id
          AND p.daily_tournament_id = dt.daily_tournament_id
          AND p.payout_type = 'daily_reward'
    WHERE  dts.score_date = (now() AT TIME ZONE 'UTC')::date - INTERVAL '1 day'
    ORDER BY dts.rank
  `;
}

export async function fetchTodayLeaderboard(): Promise<LeaderboardEntry[]> {
  return sql<LeaderboardEntry[]>`
    SELECT user_id,
           name,
           address,
           total_score,
           RANK() OVER (ORDER BY total_score DESC)::int AS rank
    FROM (
      SELECT u.user_id,
             u.name,
             u.address,
             SUM(gp.score)::int AS total_score
      FROM   game_plays gp
      JOIN   daily_tournaments dt ON dt.daily_tournament_id = gp.daily_tournament_id
      JOIN   users u ON u.user_id = gp.user_id
      WHERE  dt.tournament_date = (now() AT TIME ZONE 'UTC')::date
        AND  gp.score IS NOT NULL
      GROUP BY u.user_id, u.name, u.address
    ) t
    ORDER BY rank, user_id
  `;
}

export async function fetchOverallLeaderboard(): Promise<LeaderboardEntry[]> {
  return sql<LeaderboardEntry[]>`
    SELECT u.user_id,
           u.name,
           u.address,
           un.total_score::int AS total_score,
           RANK() OVER (ORDER BY un.total_score DESC)::int AS rank
    FROM   user_numbers un
    JOIN   users u ON u.user_id = un.user_id
    WHERE  un.total_score > 0
    ORDER BY rank, u.user_id
  `;
}

import type postgres from 'postgres';
import { sql } from './index.ts';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface UnprocessedTournamentRow {
  daily_tournament_id: string;
  tournament_date: string; // YYYY-MM-DD (UTC)
}

export interface RankedPlayerRow {
  user_id: string;
  address: string;
  total_score: number;
  rank: number;
}

export interface PreviousResultRow {
  revenue: string; // NUMERIC → string
  inherited_revenue: string;
  used_for_payout: string;
}

export interface PayoutInsert {
  user_id: string;
  action_id: string;
  amount: string;
  payment_token: number;
  signature: string;
}

// ---------------------------------------------------------------------------
// Queries — every function takes a `tx` (postgres.Sql) so the caller controls
// the transaction. The job runs the whole sequence inside one transaction
// guarded by an advisory lock keyed on the tournament id.
// ---------------------------------------------------------------------------

type Sql = postgres.Sql | postgres.ReservedSql | postgres.TransactionSql;

/**
 * Returns the oldest daily_tournament whose tournament_date is strictly before
 * today (UTC) and which has no daily_tournament_results row yet.
 */
export async function findOldestUnprocessedTournament(): Promise<UnprocessedTournamentRow | null> {
  const rows = await sql<UnprocessedTournamentRow[]>`
    SELECT dt.daily_tournament_id,
           to_char(dt.tournament_date, 'YYYY-MM-DD') AS tournament_date
    FROM   daily_tournaments dt
    WHERE  dt.tournament_date < (now() AT TIME ZONE 'UTC')::date
      AND  NOT EXISTS (
        SELECT 1 FROM daily_tournament_results dtr
        WHERE  dtr.daily_tournament_id = dt.daily_tournament_id
      )
    ORDER BY dt.tournament_date ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Computes per-user total scores for the tournament, ranks them with
 * RANK() (matches fetchTodayLeaderboard), and inserts into daily_total_scores.
 * Excludes plays that never produced a result row, and excludes banned users
 * before ranking so the resulting ranks have no gaps and downstream payouts
 * never target a banned address.
 */
export async function insertDailyTotalScores(
  tx: Sql,
  tournamentId: string,
  tournamentDate: string
): Promise<void> {
  await tx`
    INSERT INTO daily_total_scores (user_id, score_date, total_score, rank)
    SELECT user_id, ${tournamentDate}::date, total_score, rank
    FROM (
      SELECT gp.user_id,
             SUM(gpr.score)::int AS total_score,
             RANK() OVER (ORDER BY SUM(gpr.score) DESC)::int AS rank
      FROM   game_plays gp
      JOIN   game_play_results gpr ON gpr.game_play_id = gp.game_play_id
      JOIN   users_with_data u ON u.user_id = gp.user_id
      WHERE  gp.daily_tournament_id = ${tournamentId}
        AND  NOT u.is_banned
      GROUP BY gp.user_id
    ) t
  `;
}

/**
 * Top 50 ranked players for the given tournament date, joined with their
 * on-chain address. Order by rank ascending, ties broken by user_id for a
 * deterministic order.
 */
export async function fetchTopRankedPlayers(
  tx: Sql,
  tournamentDate: string
): Promise<RankedPlayerRow[]> {
  return tx<RankedPlayerRow[]>`
    SELECT dts.user_id,
           u.address,
           dts.total_score,
           dts.rank
    FROM   daily_total_scores dts
    JOIN   users u ON u.user_id = dts.user_id
    WHERE  dts.score_date = ${tournamentDate}::date
      AND  dts.rank <= 50
    ORDER BY dts.rank, dts.user_id
  `;
}

/**
 * Sum of `revenue` from user_transactions with tx_time inside the tournament
 * day's UTC window.
 */
export async function fetchDayRevenue(tx: Sql, tournamentDate: string): Promise<string> {
  const rows = await tx<{ revenue: string }[]>`
    SELECT COALESCE(SUM(revenue), 0)::text AS revenue
    FROM   user_transactions
    WHERE  tx_time >= (${tournamentDate}::date)::timestamp AT TIME ZONE 'UTC'
      AND  tx_time <  ((${tournamentDate}::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'UTC')
  `;
  return rows[0]?.revenue ?? '0';
}

/**
 * Returns the most recent processed tournament strictly before
 * `tournamentDate`, or null if none exists. Used to compute inherited_revenue
 * — looking up the latest prior result (not strictly D-1) so that gaps in
 * `daily_tournaments` (days nobody played) don't drop the rollover.
 *
 * Safe to use because the job drains tournaments oldest-first, so by the time
 * we process day D, every earlier daily_tournaments row already has a result.
 */
export async function fetchPreviousDayResult(
  tx: Sql,
  tournamentDate: string
): Promise<PreviousResultRow | null> {
  const rows = await tx<PreviousResultRow[]>`
    SELECT dtr.revenue::text         AS revenue,
           dtr.inherited_revenue::text AS inherited_revenue,
           dtr.used_for_payout::text AS used_for_payout
    FROM   daily_tournaments dt
    JOIN   daily_tournament_results dtr ON dtr.daily_tournament_id = dt.daily_tournament_id
    WHERE  dt.tournament_date < ${tournamentDate}::date
    ORDER BY dt.tournament_date DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function insertUserPayouts(
  tx: Sql,
  tournamentId: string,
  payouts: PayoutInsert[]
): Promise<void> {
  if (payouts.length === 0) return;
  await tx`
    INSERT INTO user_payouts (user_id, payout_type, action_id, amount, payment_token, signature, daily_tournament_id)
    SELECT t.user_id::bigint,
           'daily_reward',
           t.action_id,
           t.amount::numeric,
           t.payment_token::smallint,
           t.signature,
           ${tournamentId}::bigint
    FROM UNNEST(
      ${payouts.map((p) => p.user_id)}::text[],
      ${payouts.map((p) => p.action_id)}::text[],
      ${payouts.map((p) => p.amount)}::text[],
      ${payouts.map((p) => p.payment_token)}::int[],
      ${payouts.map((p) => p.signature)}::text[]
    ) AS t(user_id, action_id, amount, payment_token, signature)
  `;
}

export async function insertDailyTournamentResult(
  tx: Sql,
  tournamentId: string,
  revenue: string,
  inheritedRevenue: string,
  usedForPayout: string
): Promise<void> {
  await tx`
    INSERT INTO daily_tournament_results
      (daily_tournament_id, revenue, inherited_revenue, used_for_payout)
    VALUES
      (${tournamentId}, ${revenue}::numeric, ${inheritedRevenue}::numeric, ${usedForPayout}::numeric)
  `;
}

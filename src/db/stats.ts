import type postgres from 'postgres';
import { GD_ADDRESS, GD_TOKEN_ID } from '../constants.ts';
import { sql } from './index.ts';

// ---------------------------------------------------------------------------
// Public game stats for the UbeGames dashboard (GET /stats).
//
// Definitions (all days are UTC):
//   active user  – a non-banned user who played a game, checked in or made an
//                  on-chain transaction that day
//   tx           – on-chain transactions recorded in user_transactions
//                  (purchases, claims, deposits)
//   G$ earned    – G$ rewards created for players: daily tournament rewards
//                  and mystery box G$ prizes (conversions are not earnings)
//   G$ spent     – G$ paid for in-game items
//   G$ bought    – G$ paid out for stablecoins (confirmed stablecoin → G$ conversions)
//   G$ sold      – G$ converted back to stablecoins (confirmed G$ deposits)
//   retention    – weekly signup cohorts; active[k] = cohort users active in
//                  the cohort's 7-day window shifted k weeks forward
// ---------------------------------------------------------------------------

export const STATS_DAYS = 30;
export const RETENTION_WEEKS = 8;

export interface GameStats {
  game: 'blockfall';
  generated_at: string;
  /** 'YYYY-MM-DD', oldest first, last entry is today (partial day). */
  days: string[];
  dau: number[];
  tx: number[];
  /** Human-readable G$ (not wei). */
  gd_earned: number[];
  gd_spent: number[];
  gd_bought: number[];
  gd_sold: number[];
  retention: {
    /** Oldest first. Cohort c has RETENTION_WEEKS - c entries in `active`. */
    cohorts: { start: string; size: number; active: number[] }[];
  };
}

const DAY_MS = 86_400_000;

function utcDay(offsetDays: number, from = Date.now()): Date {
  const d = new Date(from + offsetDays * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);

const notBanned = (userId: postgres.Fragment) => sql`
  NOT EXISTS (
    SELECT 1 FROM user_mutable_data umd
    WHERE  umd.user_id = ${userId}
      AND  umd.is_banned
      AND  umd.user_change_id = (SELECT MAX(user_change_id) FROM user_mutable_data WHERE user_id = ${userId})
  )
`;

/** Distinct (user_id, day) pairs of activity since `since` (UTC midnight). */
const activitySince = (since: Date) => sql`
  SELECT DISTINCT a.user_id, a.day
  FROM (
    SELECT user_id, (date_from_id(game_play_id) AT TIME ZONE 'UTC')::date AS day
    FROM   game_plays
    WHERE  game_play_id >= generate_id_at_det(${since})
    UNION ALL
    SELECT user_id, check_in_date
    FROM   daily_checkins
    WHERE  check_in_date >= ${ymd(since)}::date
    UNION ALL
    SELECT user_id, (tx_time AT TIME ZONE 'UTC')::date
    FROM   user_transactions
    WHERE  tx_time >= ${since}
  ) a
  WHERE ${notBanned(sql`a.user_id`)}
`;

interface DayRow {
  day: string;
  value: number;
}

export async function fetchGameStats(): Promise<GameStats> {
  const today = utcDay(0);
  const start = utcDay(-(STATS_DAYS - 1), today.getTime());
  const retStart = utcDay(-(RETENTION_WEEKS * 7 - 1), today.getTime());
  const gdAddress = GD_ADDRESS.toLowerCase();

  const [dauRows, txRows, earnedRows, spentRows, boughtRows, soldRows, sizeRows, retRows] =
    await Promise.all([
      sql<DayRow[]>`
      SELECT day::text, COUNT(*)::int AS value
      FROM   (${activitySince(start)}) act
      GROUP BY day
    `,
      sql<DayRow[]>`
      SELECT (tx_time AT TIME ZONE 'UTC')::date::text AS day, COUNT(*)::int AS value
      FROM   user_transactions
      WHERE  tx_time >= ${start}
      GROUP BY 1
    `,
      sql<DayRow[]>`
      SELECT (date_from_id(payout_id) AT TIME ZONE 'UTC')::date::text AS day,
             (SUM(amount) / 1e18)::float8 AS value
      FROM   user_payouts
      WHERE  payout_id >= generate_id_at_det(${start})
        AND  payment_token = ${GD_TOKEN_ID}
        AND  payout_type IN ('daily_reward', 'mystery_box')
      GROUP BY 1
    `,
      sql<DayRow[]>`
      SELECT (tx_time AT TIME ZONE 'UTC')::date::text AS day,
             (SUM((event_params->>'price')::numeric) / 1e18)::float8 AS value
      FROM   user_transactions
      WHERE  tx_time >= ${start}
        AND  event_params ? 'itemTypeId'
        AND  lower(event_params->>'paymentToken') = ${gdAddress}
      GROUP BY 1
    `,
      sql<DayRow[]>`
      SELECT (ut.tx_time AT TIME ZONE 'UTC')::date::text AS day,
             (SUM(p.amount) / 1e18)::float8 AS value
      FROM   user_deposit_confirmations dc
      JOIN   user_payouts p ON p.payout_id = dc.payout_id
      JOIN   user_transactions ut ON ut.transaction_id = dc.deposit_transaction_id
      WHERE  ut.tx_time >= ${start}
        AND  p.payout_type = 'conversion'
        AND  p.payment_token = ${GD_TOKEN_ID}
      GROUP BY 1
    `,
      sql<DayRow[]>`
      SELECT (ut.tx_time AT TIME ZONE 'UTC')::date::text AS day,
             (SUM(d.amount) / 1e18)::float8 AS value
      FROM   user_deposit_confirmations dc
      JOIN   user_deposits d ON d.deposit_id = dc.deposit_id
      JOIN   user_transactions ut ON ut.transaction_id = dc.deposit_transaction_id
      WHERE  ut.tx_time >= ${start}
        AND  d.payment_token = ${GD_TOKEN_ID}
      GROUP BY 1
    `,
      sql<{ c: number; size: number }[]>`
      SELECT ((date_from_id(user_id) AT TIME ZONE 'UTC')::date - ${ymd(retStart)}::date) / 7 AS c,
             COUNT(*)::int AS size
      FROM   users u
      WHERE  user_id >= generate_id_at_det(${retStart})
        AND  ${notBanned(sql`u.user_id`)}
      GROUP BY 1
    `,
      sql<{ c: number; k: number; active: number }[]>`
      WITH cohort_users AS (
        SELECT user_id,
               ((date_from_id(user_id) AT TIME ZONE 'UTC')::date - ${ymd(retStart)}::date) / 7 AS c
        FROM   users
        WHERE  user_id >= generate_id_at_det(${retStart})
      )
      SELECT cu.c,
             (act.day - (${ymd(retStart)}::date + cu.c * 7)) / 7 AS k,
             COUNT(DISTINCT cu.user_id)::int AS active
      FROM   cohort_users cu
      JOIN   (${activitySince(retStart)}) act ON act.user_id = cu.user_id
      WHERE  act.day >= ${ymd(retStart)}::date + cu.c * 7 + 7 -- week 1 onwards
      GROUP BY 1, 2
    `,
    ]);

  const days = Array.from({ length: STATS_DAYS }, (_, i) => ymd(utcDay(i, start.getTime())));
  const series = (rows: DayRow[]) => {
    const byDay = new Map(rows.map((r) => [r.day, r.value]));
    return days.map((d) => byDay.get(d) ?? 0);
  };

  const sizes = new Map(sizeRows.map((r) => [r.c, r.size]));
  const active = new Map(retRows.map((r) => [`${String(r.c)}:${String(r.k)}`, r.active]));
  const cohorts = Array.from({ length: RETENTION_WEEKS }, (_, c) => {
    const size = sizes.get(c) ?? 0;
    return {
      start: ymd(utcDay(c * 7, retStart.getTime())),
      size,
      active: Array.from({ length: RETENTION_WEEKS - c }, (_, k) =>
        k === 0 ? size : (active.get(`${String(c)}:${String(k)}`) ?? 0)
      ),
    };
  });

  return {
    game: 'blockfall',
    generated_at: new Date().toISOString(),
    days,
    dau: series(dauRows),
    tx: series(txRows),
    gd_earned: series(earnedRows),
    gd_spent: series(spentRows),
    gd_bought: series(boughtRows),
    gd_sold: series(soldRows),
    retention: { cohorts },
  };
}

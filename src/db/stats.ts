import type postgres from 'postgres';
import { GD_ADDRESS, GD_TOKEN_ID, STATS_START_DATE } from '../constants.ts';
import { sql } from './index.ts';

// ---------------------------------------------------------------------------
// Public game stats for the UbeGames dashboard (GET /stats).
// Everything is counted from STATS_START_DATE (G$ integration day, UTC).
//
// Definitions (all days are UTC):
//   active user     – a non-banned user who played a game, checked in or made
//                     an on-chain transaction that day
//   tx              – on-chain transactions recorded in user_transactions
//                     (purchases, claims, deposits)
//   G$ circulation  – G$ that actually moved on-chain, dated by the tx:
//                       claimed (G$ payouts claimed: daily rewards, mystery box
//                                prizes, stablecoin → G$ conversions)
//                     + spent   (G$ paid for in-game items)
//                     + sold    (confirmed G$ deposits converted to stablecoins)
//                     Unclaimed payouts and unconfirmed deposits are not counted.
//   retention       – weeks are 7-day blocks starting at STATS_START_DATE.
//                     Share of users active in the week before the latest
//                     complete week who were also active in the latest one.
//                     null until two complete weeks exist.
// ---------------------------------------------------------------------------

export interface GameStats {
  game: 'blockfall';
  generated_at: string;
  /** 'YYYY-MM-DD' — first day counted. */
  since: string;
  /** Since `since`, including today so far. */
  totals: { users: number; tx: number; gd_circulation: number };
  /** Complete days only: `since` … yesterday, oldest first. */
  days: string[];
  dau: number[];
  tx: number[];
  /** Human-readable G$ (not wei). */
  gd_circulation: number[];
  retention: {
    week_start: string;
    previous_week_start: string;
    previous_week_users: number;
    retained_users: number;
  } | null;
}

const DAY_MS = 86_400_000;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

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
  const start = new Date(`${STATS_START_DATE}T00:00:00Z`);
  const today = utcToday();
  const gdAddress = GD_ADDRESS.toLowerCase();

  // Retention weeks: 7-day blocks from `start`; use the last two complete ones.
  const completeWeeks = Math.max(0, Math.floor((today.getTime() - start.getTime()) / (7 * DAY_MS)));
  const latestWeek = completeWeeks >= 2 ? addDays(start, (completeWeeks - 1) * 7) : null;
  const prevWeek = latestWeek ? addDays(latestWeek, -7) : null;

  const [dauRows, txRows, gdRows, userRows, retRows] = await Promise.all([
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
      SELECT day::text, (SUM(amount) / 1e18)::float8 AS value
      FROM (
        -- claimed G$ payouts (rewards, mystery box prizes, conversions)
        SELECT (ut.tx_time AT TIME ZONE 'UTC')::date AS day, p.amount
        FROM   user_claims c
        JOIN   user_payouts p ON p.payout_id = c.payout_id
        JOIN   user_transactions ut ON ut.transaction_id = c.claim_transaction_id
        WHERE  ut.tx_time >= ${start}
          AND  p.payment_token = ${GD_TOKEN_ID}
        UNION ALL
        -- spent on items. event_params is written with JSON.stringify, so it is
        -- stored as a JSON string holding the object; unwrap it either way.
        SELECT day, (ep->>'price')::numeric
        FROM (
          SELECT (tx_time AT TIME ZONE 'UTC')::date AS day,
                 CASE WHEN jsonb_typeof(event_params) = 'string'
                      THEN (event_params #>> '{}')::jsonb
                      ELSE event_params
                 END AS ep
          FROM   user_transactions
          WHERE  tx_time >= ${start}
        ) t
        WHERE  ep ? 'itemTypeId'
          AND  lower(ep->>'paymentToken') = ${gdAddress}
        UNION ALL
        -- sold for stablecoins (G$ deposited)
        SELECT (ut.tx_time AT TIME ZONE 'UTC')::date, d.amount
        FROM   user_deposit_confirmations dc
        JOIN   user_deposits d ON d.deposit_id = dc.deposit_id
        JOIN   user_transactions ut ON ut.transaction_id = dc.deposit_transaction_id
        WHERE  ut.tx_time >= ${start}
          AND  d.payment_token = ${GD_TOKEN_ID}
      ) flows
      GROUP BY day
    `,
    sql<{ users: number }[]>`
      SELECT COUNT(DISTINCT user_id)::int AS users FROM (${activitySince(start)}) act
    `,
    latestWeek && prevWeek
      ? sql<{ previous_week_users: number; retained_users: number }[]>`
          SELECT COUNT(*) FILTER (WHERE in_prev)::int               AS previous_week_users,
                 COUNT(*) FILTER (WHERE in_prev AND in_latest)::int AS retained_users
          FROM (
            SELECT user_id,
                   bool_or(day >= ${ymd(prevWeek)}::date AND day < ${ymd(latestWeek)}::date) AS in_prev,
                   bool_or(day >= ${ymd(latestWeek)}::date AND day < ${ymd(addDays(latestWeek, 7))}::date) AS in_latest
            FROM   (${activitySince(prevWeek)}) act
            GROUP BY user_id
          ) u
        `
      : Promise.resolve(null),
  ]);

  // Complete days only: start … yesterday
  const dayCount = Math.max(0, Math.round((today.getTime() - start.getTime()) / DAY_MS));
  const days = Array.from({ length: dayCount }, (_, i) => ymd(addDays(start, i)));
  const series = (rows: DayRow[]) => {
    const byDay = new Map(rows.map((r) => [r.day, r.value]));
    return days.map((d) => byDay.get(d) ?? 0);
  };
  const total = (rows: DayRow[]) => rows.reduce((s, r) => s + r.value, 0);

  const ret = retRows?.[0];
  return {
    game: 'blockfall',
    generated_at: new Date().toISOString(),
    since: STATS_START_DATE,
    totals: {
      users: userRows[0]?.users ?? 0,
      tx: total(txRows),
      gd_circulation: total(gdRows),
    },
    days,
    dau: series(dauRows),
    tx: series(txRows),
    gd_circulation: series(gdRows),
    retention:
      ret && latestWeek && prevWeek
        ? {
            week_start: ymd(latestWeek),
            previous_week_start: ymd(prevWeek),
            previous_week_users: ret.previous_week_users,
            retained_users: ret.retained_users,
          }
        : null,
  };
}

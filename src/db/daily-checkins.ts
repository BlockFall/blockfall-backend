import { MYSTERY_BOX_ITEM_TYPE } from '../constants.ts';
import { sql } from './index.ts';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface CheckInDayRow {
  date: string; // 'YYYY-MM-DD' (UTC)
  checked_in: boolean;
}

export interface CheckInResult {
  check_in_id: string;
  energy_granted: number;
  streak: number;
  mystery_box_item_id: string | null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const DAILY_CHECK_IN_ENERGY = 1;

/**
 * Returns the last seven UTC dates (including today) with a flag indicating
 * whether the user checked in that day.
 */
export async function getLastSevenDayCheckins(userId: string): Promise<CheckInDayRow[]> {
  return sql<CheckInDayRow[]>`
    SELECT to_char(d::date, 'YYYY-MM-DD')   AS date,
           (c.check_in_date IS NOT NULL)    AS checked_in
    FROM   generate_series(
             (now() AT TIME ZONE 'UTC')::date - INTERVAL '6 days',
             (now() AT TIME ZONE 'UTC')::date,
             INTERVAL '1 day'
           ) AS d
    LEFT JOIN daily_checkins c
           ON c.user_id = ${userId}
          AND c.check_in_date = d::date
    ORDER BY d
  `;
}

/**
 * Performs a daily check-in. Transactionally:
 *  1. Inserts a daily_checkins row for today (UTC); returns null if already checked in.
 *  2. Grants 1 energy via energy_issuance + user_numbers.energy bump.
 *  3. Computes the current consecutive-day streak ending today.
 *  4. If streak is a multiple of 7, inserts a mystery-box user_items row.
 *
 * Returns null if the user has already checked in today.
 */
export async function performDailyCheckin(userId: string): Promise<CheckInResult | null> {
  return sql.begin<CheckInResult | null>(async (tx) => {
    const inserted = await tx<{ check_in_id: string }[]>`
      INSERT INTO daily_checkins (user_id, check_in_date)
      VALUES (${userId}, (now() AT TIME ZONE 'UTC')::date)
      ON CONFLICT (user_id, check_in_date) DO NOTHING
      RETURNING check_in_id
    `;

    if (inserted.length === 0) {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const checkInId = inserted[0]!.check_in_id;

    await tx`
      INSERT INTO energy_issuance (user_id, issuance_type, amount, check_in_id)
      VALUES (${userId}, 'daily_check_in', ${DAILY_CHECK_IN_ENERGY}, ${checkInId})
    `;

    await tx`
      UPDATE user_numbers
      SET    energy = energy + ${DAILY_CHECK_IN_ENERGY},
             updated_at = now()
      WHERE  user_id = ${userId}
    `;

    // Count the length of the consecutive-day streak ending today by walking
    // backwards one day at a time through daily_checkins for this user.
    const streakRows = await tx<{ streak: number }[]>`
      WITH RECURSIVE s(d, n) AS (
        SELECT (now() AT TIME ZONE 'UTC')::date, 1
        UNION ALL
        SELECT s.d - 1, s.n + 1
        FROM   s
        WHERE  EXISTS (
          SELECT 1 FROM daily_checkins
          WHERE  user_id = ${userId}
            AND  check_in_date = s.d - 1
        )
      )
      SELECT COALESCE(MAX(n), 0)::int AS streak FROM s
    `;
    const streak = streakRows[0]?.streak ?? 1;

    let mysteryBoxItemId: string | null = null;
    if (streak > 0 && streak % 7 === 0) {
      const itemRows = await tx<{ item_id: string }[]>`
        INSERT INTO user_items (user_id, item_type, acquisition_type)
        VALUES (${userId}, ${MYSTERY_BOX_ITEM_TYPE}, 'daily_check_in')
        RETURNING item_id
      `;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      mysteryBoxItemId = itemRows[0]!.item_id;
    }

    return {
      check_in_id: checkInId,
      energy_granted: DAILY_CHECK_IN_ENERGY,
      streak,
      mystery_box_item_id: mysteryBoxItemId,
    };
  });
}

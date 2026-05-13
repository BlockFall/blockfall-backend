import { BOOST_INFO_BY_ITEM_TYPE } from '../constants.ts';
import { sql, withTransaction } from './index.ts';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface BoosterActivationRow {
  user_booster_activation_id: string;
  item_id: string;
  multiplier: number;
  started_at: Date;
  expires_at: Date;
}

export type ActivateBoosterError =
  | 'item_not_found' // not in user's inventory, or not a booster item type
  | 'item_already_used' // item was already consumed (activated before, or otherwise used)
  | 'booster_already_active'; // user has another booster still in its window

export type ActivateBoosterOutcome =
  | { ok: true; activation: BoosterActivationRow }
  | { ok: false; error: ActivateBoosterError };

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns the user's currently-active booster (latest activation whose window
 * is still open), or null if none. Uses idx_user_booster_activations_latest.
 */
export async function getActiveBooster(userId: string): Promise<BoosterActivationRow | null> {
  const rows = await sql<BoosterActivationRow[]>`
    SELECT user_booster_activation_id, item_id, multiplier, started_at, expires_at
    FROM   user_booster_activations
    WHERE  user_id = ${userId}
      AND  expires_at > now()
    ORDER  BY user_booster_activation_id DESC
    LIMIT  1
  `;
  return rows[0] ?? null;
}

/**
 * Activates a booster item owned by `userId`. Transactionally:
 *   1. Verifies the item exists, belongs to the user, is a known booster type,
 *      and hasn't been used.
 *   2. Verifies the user has no other booster whose window is still open.
 *   3. Inserts user_item_usages for the booster item (marks it as used). The
 *      UNIQUE(item_id) constraint there is the race guard against double-spend.
 *   4. Inserts a user_booster_activations row with multiplier + expires_at
 *      derived from BOOST_INFO_BY_ITEM_TYPE.
 */
export async function activateBooster(
  userId: string,
  itemId: string
): Promise<ActivateBoosterOutcome> {
  return withTransaction<ActivateBoosterOutcome>(async (tx) => {
    const itemRows = await tx<{ item_type: number; is_used: boolean }[]>`
      SELECT ui.item_type,
             EXISTS (
               SELECT 1 FROM user_item_usages u WHERE u.item_id = ui.item_id
             ) AS is_used
      FROM   user_items ui
      WHERE  ui.item_id = ${itemId}
        AND  ui.user_id = ${userId}
      FOR UPDATE OF ui
    `;
    const item = itemRows[0];
    if (!item) {
      return { ok: false, error: 'item_not_found' };
    }
    const info = BOOST_INFO_BY_ITEM_TYPE[item.item_type];
    if (!info) {
      return { ok: false, error: 'item_not_found' };
    }
    if (item.is_used) {
      return { ok: false, error: 'item_already_used' };
    }

    const activeRows = await tx<{ user_booster_activation_id: string }[]>`
      SELECT user_booster_activation_id
      FROM   user_booster_activations
      WHERE  user_id = ${userId}
        AND  expires_at > now()
      ORDER  BY user_booster_activation_id DESC
      LIMIT  1
    `;
    if (activeRows.length > 0) {
      return { ok: false, error: 'booster_already_active' };
    }

    await tx`
      INSERT INTO user_item_usages (item_id)
      VALUES (${itemId})
    `;

    const inserted = await tx<BoosterActivationRow[]>`
      INSERT INTO user_booster_activations (user_id, item_id, multiplier, expires_at)
      VALUES (
        ${userId},
        ${itemId},
        ${info.multiplier},
        now() + (${info.durationMinutes} || ' minutes')::interval
      )
      RETURNING user_booster_activation_id, item_id, multiplier, started_at, expires_at
    `;

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return { ok: true, activation: inserted[0]! };
  });
}

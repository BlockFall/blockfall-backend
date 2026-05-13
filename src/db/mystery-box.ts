import type postgres from 'postgres';
import {
  ENERGY_BY_ITEM_TYPE,
  MYSTERY_BOX_ITEM_TYPE,
  MYSTERY_BOX_PRIZES,
} from '../constants.ts';
import { sql, withTransaction } from './index.ts';

// ---------------------------------------------------------------------------
// Mystery-box opening
// ---------------------------------------------------------------------------

export type OpenMysteryBoxResult =
  | {
      success: true;
      prize_item_type: number;
      // Set when the prize is a booster — energy prizes don't create a
      // user_items row, they're credited directly to user_numbers.energy.
      prize_user_item_id: string | null;
      energy_granted: number | null;
    }
  | { success: false; reason: 'not_found_or_already_opened' };

// Stable advisory-lock key used to serialize batch generation across
// concurrent openers. Any int8-fitting constant works.
const PRIZE_BATCH_LOCK_KEY = 0x6d795f626f78; // ascii "my_box"

/**
 * Opens a mystery box owned by `userId`. Transactionally:
 *   1. Verifies the box exists, belongs to the user, and hasn't been used.
 *   2. Picks the lowest-id unused mystery_box_prizes row, generating a fresh
 *      randomized batch of 40 if the pool is empty.
 *   3. Inserts user_item_usages for the box (marks it as used).
 *   4. Inserts mystery_box_given_items linking the prize to that usage.
 *   5. Inserts a user_items row for the prize (acquisition_type='mystery_box',
 *      source_mystery_box_id = the box). If the prize is an energy package the
 *      energy is issued immediately and the prize item is auto-marked as used.
 */
export async function openMysteryBox(
  userId: string,
  mysteryBoxItemId: string
): Promise<OpenMysteryBoxResult> {
  return withTransaction<OpenMysteryBoxResult>(async (tx) => {
    const boxRows = await tx<{ item_id: string }[]>`
      SELECT ui.item_id
      FROM   user_items ui
      WHERE  ui.item_id   = ${mysteryBoxItemId}
        AND  ui.user_id   = ${userId}
        AND  ui.item_type = ${MYSTERY_BOX_ITEM_TYPE}
        AND  NOT EXISTS (
          SELECT 1 FROM user_item_usages u WHERE u.item_id = ui.item_id
        )
      FOR UPDATE OF ui
    `;
    if (boxRows.length === 0) {
      return { success: false, reason: 'not_found_or_already_opened' };
    }

    const prize = await pickNextPrize(tx);

    const usageRows = await tx<{ item_usage_id: string }[]>`
      INSERT INTO user_item_usages (item_id)
      VALUES (${mysteryBoxItemId})
      RETURNING item_usage_id
    `;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const itemUsageId = usageRows[0]!.item_usage_id;

    await tx`
      INSERT INTO mystery_box_given_items (mystery_box_prize_id, item_usage_id)
      VALUES (${prize.mystery_box_prize_id}, ${itemUsageId})
    `;

    const energyAmount = ENERGY_BY_ITEM_TYPE[prize.item_type];
    let energyGranted: number | null = null;
    let prizeItemId: string | null = null;

    if (energyAmount) {
      // Energy prizes are credited directly — no inventory row.
      energyGranted = energyAmount;
      await tx`
        INSERT INTO energy_issuance (user_id, issuance_type, amount)
        VALUES (${userId}, 'mystery_box', ${energyAmount})
      `;
      await tx`
        UPDATE user_numbers
        SET    energy = energy + ${energyAmount},
               updated_at = now()
        WHERE  user_id = ${userId}
      `;
    } else {
      // Booster (or any non-energy prize) — add to inventory for later use.
      const prizeItemRows = await tx<{ item_id: string }[]>`
        INSERT INTO user_items (user_id, item_type, acquisition_type, source_mystery_box_id)
        VALUES (${userId}, ${prize.item_type}, 'mystery_box', ${mysteryBoxItemId})
        RETURNING item_id
      `;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      prizeItemId = prizeItemRows[0]!.item_id;
    }

    return {
      success: true,
      prize_item_type: prize.item_type,
      prize_user_item_id: prizeItemId,
      energy_granted: energyGranted,
    };
  });
}

interface PrizeRow {
  mystery_box_prize_id: string;
  item_type: number;
}

async function pickNextPrize(tx: postgres.ReservedSql): Promise<PrizeRow> {
  const existing = await tx<PrizeRow[]>`
    SELECT mbp.mystery_box_prize_id, mbp.item_type
    FROM   mystery_box_prizes mbp
    WHERE  NOT EXISTS (
      SELECT 1 FROM mystery_box_given_items g
      WHERE  g.mystery_box_prize_id = mbp.mystery_box_prize_id
    )
    ORDER  BY mbp.mystery_box_prize_id
    LIMIT  1
    FOR UPDATE OF mbp SKIP LOCKED
  `;
  if (existing[0]) return existing[0];

  // Pool empty (or all rows currently locked by another opener). Serialize
  // batch generation so concurrent openers don't each insert their own batch.
  await tx`SELECT pg_advisory_xact_lock(${PRIZE_BATCH_LOCK_KEY})`;

  const afterLock = await tx<PrizeRow[]>`
    SELECT mbp.mystery_box_prize_id, mbp.item_type
    FROM   mystery_box_prizes mbp
    WHERE  NOT EXISTS (
      SELECT 1 FROM mystery_box_given_items g
      WHERE  g.mystery_box_prize_id = mbp.mystery_box_prize_id
    )
    ORDER  BY mbp.mystery_box_prize_id
    LIMIT  1
    FOR UPDATE OF mbp SKIP LOCKED
  `;
  if (afterLock[0]) return afterLock[0];

  const batch = buildShuffledBatch();
  await tx`
    INSERT INTO mystery_box_prizes (item_type)
    SELECT * FROM unnest(${sql.array(batch)}::int[])
  `;

  const freshRows = await tx<PrizeRow[]>`
    SELECT mbp.mystery_box_prize_id, mbp.item_type
    FROM   mystery_box_prizes mbp
    WHERE  NOT EXISTS (
      SELECT 1 FROM mystery_box_given_items g
      WHERE  g.mystery_box_prize_id = mbp.mystery_box_prize_id
    )
    ORDER  BY mbp.mystery_box_prize_id
    LIMIT  1
    FOR UPDATE OF mbp
  `;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return freshRows[0]!;
}

function buildShuffledBatch(): number[] {
  const batch: number[] = [];
  for (const [itemType, { countInBatch }] of Object.entries(MYSTERY_BOX_PRIZES)) {
    const t = Number(itemType);
    for (let i = 0; i < countInBatch; i++) batch.push(t);
  }
  // Fisher-Yates shuffle so consumers pulling the lowest-id row receive a
  // randomized prize order.
  for (let i = batch.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    [batch[i], batch[j]] = [batch[j]!, batch[i]!];
  }
  return batch;
}

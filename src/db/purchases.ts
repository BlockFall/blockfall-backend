import { sql } from './index.ts';

// ---------------------------------------------------------------------------
// ID generation (same as other modules)
// ---------------------------------------------------------------------------

function generateId(): bigint {
  const ts = BigInt(Date.now()) & 0x3ffffffffffn;
  const rand = BigInt(Math.floor(Math.random() * (1 << 21)));
  return (ts << 21n) | rand;
}

// ---------------------------------------------------------------------------
// Energy amounts by item type
// ---------------------------------------------------------------------------

const ENERGY_BY_ITEM_TYPE: Record<number, number> = {
  1: 1,
  2: 10,
  3: 25,
  4: 50,
};

const MYSTERY_BOX_ITEM_TYPE = 5;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Checks if a transaction hash already exists in user_transactions.
 */
export async function findTransactionByHash(txHash: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM user_transactions WHERE tx_hash = ${txHash}
  `;
  return rows.length > 0;
}

/**
 * Processes a purchase transaction. Transactionally:
 * 1. Inserts into user_transactions
 * 2. If energy package (itemTypeId 1-4): inserts energy_issuance, increments user energy
 * 3. If mystery box (itemTypeId 5): inserts into user_items
 */
export async function processPurchase(
  userId: string,
  txHash: string,
  itemTypeId: number,
  eventParams: object,
): Promise<{ transaction_id: string }> {
  const transactionId = generateId().toString();

  await sql.begin(async (tx) => {
    // 1. Save transaction
    await tx`
      INSERT INTO user_transactions (transaction_id, user_id, tx_hash, event_params)
      VALUES (${transactionId}, ${userId}, ${txHash}, ${JSON.stringify(eventParams)})
    `;

    const energyAmount = ENERGY_BY_ITEM_TYPE[itemTypeId];

    if (energyAmount) {
      // 2a. Energy package — issue energy
      const issuanceId = generateId().toString();
      await tx`
        INSERT INTO energy_issuance (energy_issuance_id, user_id, issuance_type, amount, transaction_id)
        VALUES (${issuanceId}, ${userId}, 'buy_package', ${energyAmount}, ${transactionId})
      `;
      await tx`
        UPDATE user_numbers
        SET    energy = energy + ${energyAmount},
               updated_at = now()
        WHERE  user_id = ${userId}
      `;
    } else if (itemTypeId === MYSTERY_BOX_ITEM_TYPE) {
      // 2b. Mystery box — add item
      const itemId = generateId().toString();
      await tx`
        INSERT INTO user_items (item_id, user_id, item_type, acquisition_type, buy_date)
        VALUES (${itemId}, ${userId}, ${MYSTERY_BOX_ITEM_TYPE}, 'buy_package', now())
      `;
    }
  });

  return { transaction_id: transactionId };
}

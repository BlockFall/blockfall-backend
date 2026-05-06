import { ENERGY_BY_ITEM_TYPE, MYSTERY_BOX_ITEM_TYPE } from '../constants.ts';
import { sql, withTransaction } from './index.ts';

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
 * 3. If mystery box (itemTypeId 101): inserts into user_items
 */
export async function processPurchase(
  userId: string,
  txHash: string,
  txTime: Date,
  revenue: string,
  itemTypeId: number,
  eventParams: object
): Promise<{ transaction_id: string }> {
  return withTransaction(async (tx) => {
    // 1. Save transaction
    const txRows = await tx<{ transaction_id: string }[]>`
      INSERT INTO user_transactions (user_id, tx_hash, tx_time, revenue, event_params)
      VALUES (${userId}, ${txHash}, ${txTime}, ${revenue}, ${JSON.stringify(eventParams)})
      RETURNING transaction_id
    `;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const transactionId = txRows[0]!.transaction_id;

    const energyAmount = ENERGY_BY_ITEM_TYPE[itemTypeId];

    if (energyAmount) {
      // 2a. Energy package — issue energy
      await tx`
        INSERT INTO energy_issuance (user_id, issuance_type, amount, transaction_id)
        VALUES (${userId}, 'buy_package', ${energyAmount}, ${transactionId})
      `;
      await tx`
        UPDATE user_numbers
        SET    energy = energy + ${energyAmount},
               updated_at = now()
        WHERE  user_id = ${userId}
      `;
    } else if (itemTypeId === MYSTERY_BOX_ITEM_TYPE) {
      // 2b. Mystery box — add item
      await tx`
        INSERT INTO user_items (user_id, item_type, acquisition_type, buy_transaction_id)
        VALUES (${userId}, ${MYSTERY_BOX_ITEM_TYPE}, 'buy_package', ${transactionId})
      `;
    }

    return { transaction_id: transactionId };
  });
}

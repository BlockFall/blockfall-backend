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
// Row types
// ---------------------------------------------------------------------------

export interface PendingPayoutRow {
  payout_id: string;
  payout_type: string;
  action_id: string;
  amount: string;
  payment_token: number;
  signature: string;
}

export interface PayoutForClaimRow {
  payout_id: string;
  user_id: string;
  amount: string;
  payment_token: number;
  claim_date: Date | null;
  claim_transaction_id: string | null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getPendingPayouts(userId: string): Promise<PendingPayoutRow[]> {
  return sql<PendingPayoutRow[]>`
    SELECT payout_id, payout_type, action_id, amount, payment_token, signature
    FROM   user_payouts
    WHERE  user_id = ${userId}
      AND  claim_date IS NULL
    ORDER BY payout_id
  `;
}

export async function findPayoutByActionId(actionId: string): Promise<PayoutForClaimRow | null> {
  const rows = await sql<PayoutForClaimRow[]>`
    SELECT payout_id, user_id, amount, payment_token, claim_date, claim_transaction_id
    FROM   user_payouts
    WHERE  action_id = ${actionId}
  `;
  return rows[0] ?? null;
}

/**
 * Processes a claim transaction. Transactionally:
 * 1. Inserts into user_transactions (revenue = 0)
 * 2. Updates user_payouts with claim_transaction_id and claim_date
 *
 * Uses a conditional UPDATE to guard against concurrent double-claims.
 */
export async function processClaim(
  userId: string,
  payoutId: string,
  txHash: string,
  txTime: Date,
  eventParams: object
): Promise<{ transaction_id: string }> {
  const transactionId = generateId().toString();

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO user_transactions (transaction_id, user_id, tx_hash, tx_time, revenue, event_params)
      VALUES (${transactionId}, ${userId}, ${txHash}, ${txTime}, 0, ${JSON.stringify(eventParams)})
    `;

    const updated = await tx`
      UPDATE user_payouts
      SET    claim_transaction_id = ${transactionId},
             claim_date           = ${txTime}
      WHERE  payout_id  = ${payoutId}
        AND  claim_date IS NULL
    `;

    if (updated.count === 0) {
      throw new Error('Payout already claimed');
    }
  });

  return { transaction_id: transactionId };
}

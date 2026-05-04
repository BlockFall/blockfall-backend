import { sql } from './index.ts';

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
  claim_transaction_id: string | null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getPendingPayouts(userId: string): Promise<PendingPayoutRow[]> {
  return sql<PendingPayoutRow[]>`
    SELECT p.payout_id, p.payout_type, p.action_id, p.amount, p.payment_token, p.signature
    FROM   user_payouts p
    WHERE  p.user_id = ${userId}
      AND  NOT EXISTS (SELECT 1 FROM user_claims c WHERE c.payout_id = p.payout_id)
    ORDER BY p.payout_id
  `;
}

export async function findPayoutByActionId(actionId: string): Promise<PayoutForClaimRow | null> {
  const rows = await sql<PayoutForClaimRow[]>`
    SELECT p.payout_id, p.user_id, p.amount, p.payment_token, c.claim_transaction_id
    FROM   user_payouts p
    LEFT JOIN user_claims c ON c.payout_id = p.payout_id
    WHERE  p.action_id = ${actionId}
  `;
  return rows[0] ?? null;
}

/**
 * Processes a claim transaction. Transactionally:
 * 1. Inserts into user_transactions (revenue = 0)
 * 2. Inserts into user_claims
 *
 * Relies on the user_claims PK to guard against concurrent double-claims.
 */
export async function processClaim(
  userId: string,
  payoutId: string,
  txHash: string,
  txTime: Date,
  eventParams: object
): Promise<{ transaction_id: string }> {
  try {
    return await sql.begin(async (tx) => {
      const txRows = await tx<{ transaction_id: string }[]>`
        INSERT INTO user_transactions (user_id, tx_hash, tx_time, revenue, event_params)
        VALUES (${userId}, ${txHash}, ${txTime}, 0, ${JSON.stringify(eventParams)})
        RETURNING transaction_id
      `;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const transactionId = txRows[0]!.transaction_id;

      await tx`
        INSERT INTO user_claims (payout_id, claim_transaction_id)
        VALUES (${payoutId}, ${transactionId})
      `;

      return { transaction_id: transactionId };
    });
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      throw new Error('Payout already claimed', { cause: err });
    }
    throw err;
  }
}

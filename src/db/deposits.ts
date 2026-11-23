import type { DepositType, PaymentTokenId } from '../constants.ts';
import { sql, withTransaction } from './index.ts';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface DepositRow {
  deposit_id: string;
  user_id: string;
  deposit_type: DepositType;
  action_id: string;
  payment_token: number;
  amount: string;
  quoted_payout_amount: string | null;
  signature: string;
  expires_at: Date;
  /** Set once the on-chain deposit has been confirmed. */
  confirmation_id: string | null;
  /** Payout created with the confirmation (NULL for types without a payout). */
  payout_id: string | null;
}

export interface DepositPayoutRow {
  payout_id: string;
  payout_type: string;
  action_id: string;
  amount: string;
  payment_token: number;
  signature: string;
  claimed: boolean;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function insertDeposit(params: {
  userId: string;
  depositType: DepositType;
  actionId: string;
  paymentToken: PaymentTokenId;
  amount: string;
  quotedPayoutAmount: string | null;
  signature: string;
  expiresAt: Date;
}): Promise<{ deposit_id: string }> {
  const rows = await sql<{ deposit_id: string }[]>`
    INSERT INTO user_deposits
      (user_id, deposit_type, action_id, payment_token, amount, quoted_payout_amount, signature, expires_at)
    VALUES (${params.userId}, ${params.depositType}, ${params.actionId}, ${params.paymentToken},
            ${params.amount}, ${params.quotedPayoutAmount}, ${params.signature}, ${params.expiresAt})
    RETURNING deposit_id
  `;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return rows[0]!;
}

export async function findDepositByActionId(actionId: string): Promise<DepositRow | null> {
  const rows = await sql<DepositRow[]>`
    SELECT d.deposit_id, d.user_id, d.deposit_type, d.action_id, d.payment_token,
           d.amount::text AS amount, d.quoted_payout_amount::text AS quoted_payout_amount,
           d.signature, d.expires_at, c.confirmation_id, c.payout_id
    FROM   user_deposits d
    LEFT JOIN user_deposit_confirmations c ON c.deposit_id = d.deposit_id
    WHERE  d.action_id = ${actionId}
  `;
  return rows[0] ?? null;
}

export async function getDepositPayout(payoutId: string): Promise<DepositPayoutRow | null> {
  const rows = await sql<DepositPayoutRow[]>`
    SELECT p.payout_id, p.payout_type, p.action_id, p.amount::text AS amount, p.payment_token,
           p.signature,
           EXISTS (SELECT 1 FROM user_claims c WHERE c.payout_id = p.payout_id) AS claimed
    FROM   user_payouts p
    WHERE  p.payout_id = ${payoutId}
  `;
  return rows[0] ?? null;
}

/**
 * Records a confirmed on-chain deposit. In one transaction:
 * 1. Inserts into user_transactions (revenue = 0 — deposits are not revenue)
 * 2. Inserts the 'conversion' payout, when the deposit type has one
 * 3. Inserts user_deposit_confirmations, linking the deposit, tx and payout
 *
 * The UNIQUE(deposit_id) on user_deposit_confirmations guards against the
 * endpoint and the sync job confirming the same deposit concurrently.
 */
export async function confirmDeposit(params: {
  userId: string;
  depositId: string;
  txHash: string;
  txTime: Date;
  eventParams: object;
  payout: {
    actionId: string;
    amount: string;
    paymentToken: PaymentTokenId;
    signature: string;
  } | null;
}): Promise<{ confirmation_id: string; payout_id: string | null }> {
  try {
    return await withTransaction(async (tx) => {
      const txRows = await tx<{ transaction_id: string }[]>`
        INSERT INTO user_transactions (user_id, tx_hash, tx_time, revenue, event_params)
        VALUES (${params.userId}, ${params.txHash}, ${params.txTime}, 0,
                ${JSON.stringify(params.eventParams)})
        RETURNING transaction_id
      `;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const transactionId = txRows[0]!.transaction_id;

      let payoutId: string | null = null;
      if (params.payout) {
        const payoutRows = await tx<{ payout_id: string }[]>`
          INSERT INTO user_payouts (user_id, payout_type, action_id, amount, payment_token, signature)
          VALUES (${params.userId}, 'conversion', ${params.payout.actionId}, ${params.payout.amount},
                  ${params.payout.paymentToken}, ${params.payout.signature})
          RETURNING payout_id
        `;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        payoutId = payoutRows[0]!.payout_id;
      }

      const confRows = await tx<{ confirmation_id: string }[]>`
        INSERT INTO user_deposit_confirmations (deposit_id, deposit_transaction_id, payout_id)
        VALUES (${params.depositId}, ${transactionId}, ${payoutId})
        RETURNING confirmation_id
      `;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return { confirmation_id: confRows[0]!.confirmation_id, payout_id: payoutId };
    });
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      throw new DepositAlreadyConfirmedError({ cause: err });
    }
    throw err;
  }
}

export class DepositAlreadyConfirmedError extends Error {
  constructor(options?: ErrorOptions) {
    super('Deposit already confirmed', options);
  }
}

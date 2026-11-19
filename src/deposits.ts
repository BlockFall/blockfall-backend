import { toHex } from 'viem';
import {
  DEPOSIT_TYPES,
  type DepositType,
  type DepositTypeDef,
  PAYMENT_TOKENS,
  type PaymentTokenId,
} from './constants.ts';
import { confirmDeposit, type DepositRow } from './db/deposits.ts';
import { getBlockfallSeed } from './utils/celo-rpc-reader.ts';
import { getSigner, randomActionId, signClaim } from './utils/signer.ts';

export class DepositMismatchError extends Error {}

export function isDepositType(value: string): value is DepositType {
  return Object.hasOwn(DEPOSIT_TYPES, value);
}

/** The deposit type that converts `depositToken` into `payoutToken`, if any. */
export function findConversionType(
  depositToken: number,
  payoutToken: PaymentTokenId
): DepositType | null {
  for (const [type, def] of Object.entries(DEPOSIT_TYPES) as [string, DepositTypeDef][]) {
    if (def.depositToken === depositToken && def.payoutToken === payoutToken) {
      return type as DepositType;
    }
  }
  return null;
}

/**
 * Records a confirmed on-chain Deposited event and, when the deposit type has
 * a payout, creates the signed 'conversion' payout in the same transaction.
 * Shared by POST /convert/submit and the Deposited sync job. Callers must
 * already have checked that the event's player owns `deposit` and that it is
 * unconfirmed.
 *
 * The payout is always quoted_payout_amount, even if the deposit landed after
 * expires_at (the stablecoin is already in the contract by then).
 */
export async function confirmDepositEvent(params: {
  deposit: DepositRow;
  player: string;
  paymentToken: string;
  amount: bigint;
  txHash: string;
  txTime: Date;
}): Promise<{ confirmation_id: string; payout_id: string | null }> {
  const { deposit, player, paymentToken, amount, txHash, txTime } = params;

  // Widened on purpose: future deposit types may have no payout.
  const def: DepositTypeDef = DEPOSIT_TYPES[deposit.deposit_type];
  const token = PAYMENT_TOKENS[def.depositToken];
  if (paymentToken.toLowerCase() !== token.address.toLowerCase()) {
    throw new DepositMismatchError('Deposited token does not match request');
  }
  if (amount !== BigInt(deposit.amount)) {
    throw new DepositMismatchError('Deposited amount does not match request');
  }

  let payout = null;
  if (def.payoutToken !== null) {
    if (deposit.quoted_payout_amount === null) {
      throw new DepositMismatchError(`Deposit ${deposit.deposit_id} has no quoted payout amount`);
    }
    const payoutAmount = BigInt(deposit.quoted_payout_amount);
    const payoutToken = PAYMENT_TOKENS[def.payoutToken];
    const seed = await getBlockfallSeed();
    const claimActionId = randomActionId();
    const signature = await signClaim(
      getSigner(),
      seed,
      claimActionId,
      player,
      payoutToken.address,
      payoutAmount
    );
    payout = {
      actionId: toHex(claimActionId),
      amount: payoutAmount.toString(),
      paymentToken: def.payoutToken,
      signature,
    };
  }

  return confirmDeposit({
    userId: deposit.user_id,
    depositId: deposit.deposit_id,
    txHash,
    txTime,
    eventParams: {
      depositType: deposit.deposit_type,
      actionId: deposit.action_id,
      player,
      paymentToken,
      amount: amount.toString(),
    },
    payout,
  });
}

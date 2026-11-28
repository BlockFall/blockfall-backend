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

type ConversionType = {
  [K in DepositType]: (typeof DEPOSIT_TYPES)[K]['payoutToken'] extends null ? never : K;
}[DepositType];

/** Deposit types that convert one token into another (have a payout). */
export const CONVERSION_TYPES = (Object.keys(DEPOSIT_TYPES) as DepositType[]).filter(
  (type): type is ConversionType => (DEPOSIT_TYPES[type] as DepositTypeDef).payoutToken !== null
);

/**
 * Deposits can arrive two ways:
 *   - 'deposit': the contract's deposit(actionId, …) call, which emits Deposited
 *   - 'pack': buy() of a conversion pack (CONVERSION_PACKS) whose price equals
 *     the requested amount. MiniPay blocks deposit() but allows buy(), so this
 *     is what the app uses.
 */
export type DepositSource = 'deposit' | 'pack';

const TOKEN_ID_BY_ADDRESS = new Map(
  (Object.entries(PAYMENT_TOKENS) as [string, { address: string }][]).map(([id, t]) => [
    t.address.toLowerCase(),
    Number(id) as PaymentTokenId,
  ])
);

export function tokenIdByAddress(address: string): PaymentTokenId | null {
  return TOKEN_ID_BY_ADDRESS.get(address.toLowerCase()) ?? null;
}

/**
 * Records a confirmed on-chain deposit (Deposited event or conversion-pack
 * buy) and, when the deposit type has a payout, creates the signed 'conversion' payout in the same transaction.
 * Shared by POST /convert/submit and the Deposited / ItemBought sync jobs.
 * Callers must already have checked that the player owns `deposit` and that
 * it is unconfirmed.
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
  source: DepositSource;
  /** Conversion pack item id, for source 'pack'. */
  packItemTypeId?: number | undefined;
}): Promise<{ confirmation_id: string; payout_id: string | null }> {
  const { deposit, player, paymentToken, amount, txHash, txTime, source, packItemTypeId } = params;

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
    // Never use the key 'itemTypeId' here: stats count transactions with it as
    // G$ spent on items.
    eventParams: {
      source,
      ...(packItemTypeId !== undefined && { packItemTypeId }),
      depositType: deposit.deposit_type,
      actionId: deposit.action_id,
      player,
      paymentToken,
      amount: amount.toString(),
    },
    payout,
  });
}

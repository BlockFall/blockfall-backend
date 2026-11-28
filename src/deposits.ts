import { erc20Abi, type Log, parseEventLogs, toHex } from 'viem';
import {
  BLOCKFALL_GAME_ADDRESS,
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
 *   - 'transfer': a plain ERC20 transfer of the requested token and amount to
 *     the game contract. MiniPay only allows whitelisted contract calls, and a
 *     token transfer is always allowed, so the app uses this one.
 */
export type DepositSource = 'deposit' | 'transfer';

export interface TransferToGame {
  from: string;
  tokenId: PaymentTokenId;
  tokenAddress: string;
  amount: bigint;
}

const TOKEN_ID_BY_ADDRESS = new Map(
  (Object.entries(PAYMENT_TOKENS) as [string, { address: string }][]).map(([id, t]) => [
    t.address.toLowerCase(),
    Number(id) as PaymentTokenId,
  ])
);

export function tokenIdByAddress(address: string): PaymentTokenId | null {
  return TOKEN_ID_BY_ADDRESS.get(address.toLowerCase()) ?? null;
}

/** True when the transaction emitted any event from the game contract (buy, deposit, claim…). */
export function hasGameContractLogs(logs: readonly Log[]): boolean {
  const game = BLOCKFALL_GAME_ADDRESS.toLowerCase();
  return logs.some((log) => log.address.toLowerCase() === game);
}

/**
 * Payment-token Transfer events to the game contract in a transaction's logs.
 * Callers must make sure the transaction did not call the game contract
 * itself (hasGameContractLogs): buy() and deposit() also move tokens to it.
 */
export function transfersToGame(logs: Log[]): TransferToGame[] {
  const game = BLOCKFALL_GAME_ADDRESS.toLowerCase();
  return parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs, strict: true }).flatMap(
    (log) => {
      const tokenId = tokenIdByAddress(log.address);
      if (tokenId === null || log.args.to.toLowerCase() !== game) return [];
      return [
        {
          from: log.args.from.toLowerCase(),
          tokenId,
          tokenAddress: log.address,
          amount: log.args.value,
        },
      ];
    }
  );
}

/**
 * Records a confirmed on-chain deposit (Deposited event or plain transfer) and, when the deposit type has
 * a payout, creates the signed 'conversion' payout in the same transaction.
 * Shared by POST /convert/submit and the Deposited / Transfer sync jobs.
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
}): Promise<{ confirmation_id: string; payout_id: string | null }> {
  const { deposit, player, paymentToken, amount, txHash, txTime, source } = params;

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
      source,
      depositType: deposit.deposit_type,
      actionId: deposit.action_id,
      player,
      paymentToken,
      amount: amount.toString(),
    },
    payout,
  });
}

import { type Context, Hono } from 'hono';
import { validator } from 'hono/validator';
import { parseEventLogs, parseUnits, toHex } from 'viem';
import { z } from 'zod';
import blockFallGameAbi from '../../abis/blockfall-game.abi.ts';
import {
  BLOCKFALL_GAME_ADDRESS,
  CONVERT_MAX_USD,
  DAILY_PAYOUT_TOKEN_ID,
  DEPOSIT_TTL_MS,
  DEPOSIT_TYPES,
  GD_PER_USD_BUY,
  GD_PER_USD_ITEM,
  GD_PER_USD_SELL,
  GD_TOKEN_ID,
  PAYMENT_TOKENS,
  STABLE_TOKEN_IDS,
} from '../../constants.ts';
import {
  DepositAlreadyConfirmedError,
  type DepositRow,
  findDepositByActionId,
  findDepositByTxHash,
  findDepositForTransfer,
  getDepositPayout,
  insertDeposit,
} from '../../db/deposits.ts';
import {
  confirmDepositEvent,
  CONVERSION_TYPES,
  DepositMismatchError,
  type DepositSource,
  hasGameContractLogs,
  isDepositType,
  transfersToGame,
} from '../../deposits.ts';
import { getBlock, getBlockfallSeed, getTransactionReceipt } from '../../utils/celo-rpc-reader.ts';
import { quoteConversion } from '../../utils/pricing.ts';
import { getSigner, randomActionId, signDeposit } from '../../utils/signer.ts';
import { type AuthEnv, authMiddleware } from '../middleware/auth.ts';

// USD amounts are compared in 18-decimal fixed point.
const maxUsdWei = parseUnits(CONVERT_MAX_USD, 18);

/**
 * Conversions between stablecoins and G$, in both directions. Two on-chain
 * transactions:
 *   1. POST /convert/request → a deposit request (and signed deposit() params);
 *      the user sends the "from" token (stablecoin for *_to_gd, G$ for gd_to_*)
 *      either with deposit() or with a plain ERC20 transfer to the contract
 *      (what the app does: MiniPay only allows whitelisted contract calls)
 *   2. POST /convert/submit  → verifies the deposit and returns the
 *      signed claim() payout in the "to" token (also listed in GET /user
 *      pending_conversions), which the user claims through /user_claims.
 * Rates: stablecoin → G$ at GD_PER_USD_BUY, G$ → stablecoin at GD_PER_USD_SELL.
 */
export const convertRoutes = new Hono<AuthEnv>()
  // GET /convert/config — public: rates, limits and supported conversions
  .get('/config', (c) =>
    c.json({
      rates: {
        // G$ per 1 USD
        item: GD_PER_USD_ITEM.toString(),
        buy: GD_PER_USD_BUY.toString(),
        sell: GD_PER_USD_SELL.toString(),
      },
      max_usd: CONVERT_MAX_USD,
      gd_token: { id: GD_TOKEN_ID, ...PAYMENT_TOKENS[GD_TOKEN_ID] },
      stable_tokens: STABLE_TOKEN_IDS.map((id) => ({ id, ...PAYMENT_TOKENS[id] })),
      conversions: CONVERSION_TYPES.map((type) => {
        const def = DEPOSIT_TYPES[type];
        return {
          deposit_type: type,
          from_token: { id: def.depositToken, ...PAYMENT_TOKENS[def.depositToken] },
          to_token: { id: def.payoutToken, ...PAYMENT_TOKENS[def.payoutToken] },
        };
      }),
      // Token daily rewards are currently paid in (see DAILY_PAYOUT_TOKEN_ID).
      reward_token: { id: DAILY_PAYOUT_TOKEN_ID, ...PAYMENT_TOKENS[DAILY_PAYOUT_TOKEN_ID] },
    })
  )

  .use(authMiddleware)

  // POST /convert/request — quote + signed deposit params
  // Body: { deposit_type, amount } — amount is human-readable, in the "from" token.
  .post(
    '/request',
    validator('json', (value, c) => {
      const result = z
        .object({
          deposit_type: z.string(),
          amount: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/, 'Invalid amount'),
        })
        .safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid request body', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { user_id, address } = c.var.user;
      const { deposit_type, amount: amountHuman } = c.req.valid('json');

      if (!isDepositType(deposit_type)) {
        return c.json({ error: 'Unsupported conversion' }, 400);
      }
      const depositType = deposit_type;
      const { depositToken } = DEPOSIT_TYPES[depositType];
      const token = PAYMENT_TOKENS[depositToken];
      const amount = parseUnits(amountHuman, token.decimals);

      const quote = quoteConversion(depositType, amount);
      if (quote === null) {
        return c.json({ error: 'Unsupported conversion' }, 400);
      }
      // No minimum, but both sides must be greater than 0 (tiny G$ amounts can
      // round down to 0 stablecoin).
      if (amount === 0n || quote.payoutAmount === 0n) {
        return c.json({ error: 'Amount is too small' }, 400);
      }
      if (quote.usdWei > maxUsdWei) {
        return c.json({ error: `Maximum is $${CONVERT_MAX_USD} per conversion` }, 400);
      }

      const seed = await getBlockfallSeed();
      const actionIdBigInt = randomActionId();
      const actionId = toHex(actionIdBigInt);
      const signature = await signDeposit(
        getSigner(),
        seed,
        actionIdBigInt,
        address,
        token.address,
        amount
      );
      const expiresAt = new Date(Date.now() + DEPOSIT_TTL_MS);

      await insertDeposit({
        userId: user_id,
        depositType,
        actionId,
        paymentToken: depositToken,
        amount: amount.toString(),
        quotedPayoutAmount: quote.payoutAmount.toString(),
        signature,
        expiresAt,
      });

      return c.json({
        action_id: actionId,
        deposit_type: depositType,
        payment_token: depositToken,
        token_address: token.address,
        amount: amount.toString(),
        quoted_payout_amount: quote.payoutAmount.toString(),
        signature,
        expires_at: expiresAt.toISOString(),
      });
    }
  )

  // POST /convert/submit — confirm the deposit tx, get the signed claim
  // Body: { tx_hash, action_id? }. The tx is either a deposit() call or a plain
  // ERC20 transfer of the requested amount to the game contract; action_id
  // (from /convert/request) says which request a transfer pays for.
  .post(
    '/submit',
    validator('json', (value, c) => {
      const result = z
        .object({
          tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid transaction hash'),
          action_id: z
            .string()
            .regex(/^0x[0-9a-fA-F]{1,64}$/, 'Invalid action id')
            .optional(),
        })
        .safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid request body', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { user_id, address } = c.var.user;
      const { tx_hash, action_id } = c.req.valid('json');
      const player = address.toLowerCase();

      let receipt;
      try {
        receipt = await getTransactionReceipt(tx_hash as `0x${string}`);
      } catch {
        return c.json({ error: 'Transaction not found on chain' }, 404);
      }

      if (receipt.status !== 'success') {
        return c.json({ error: 'Transaction was not successful' }, 400);
      }

      // Idempotent: the sync jobs (or a retry) may already have confirmed it.
      const alreadyConfirmed = await findDepositByTxHash(tx_hash);
      if (alreadyConfirmed) {
        if (alreadyConfirmed.user_id !== user_id) {
          return c.json({ error: 'Conversion does not belong to authenticated user' }, 403);
        }
        return payoutResponse(c, alreadyConfirmed.payout_id);
      }

      const gameAddress = BLOCKFALL_GAME_ADDRESS.toLowerCase();
      const depositedEvent = parseEventLogs({
        abi: blockFallGameAbi,
        eventName: 'Deposited',
        logs: receipt.logs,
      }).find((log) => log.address.toLowerCase() === gameAddress);

      // Resolve which request this tx pays for, and with what token/amount.
      let deposit: DepositRow | null = null;
      let paymentToken: string;
      let amount: bigint;
      let source: DepositSource;

      if (depositedEvent) {
        // deposit(actionId, …) call
        if (depositedEvent.args.player.toLowerCase() !== player) {
          return c.json({ error: 'Transaction player does not match authenticated user' }, 403);
        }
        deposit = await findDepositByActionId(toHex(depositedEvent.args.actionId));
        paymentToken = depositedEvent.args.paymentToken;
        amount = depositedEvent.args.amount;
        source = 'deposit';
      } else {
        // Plain ERC20 transfer to the game contract. Buys and other contract
        // calls also move tokens to it, so they never count as a deposit.
        if (hasGameContractLogs(receipt.logs)) {
          return c.json({ error: 'Transaction is not a deposit' }, 400);
        }
        const transfers = transfersToGame(receipt.logs).filter((t) => t.from === player);
        if (transfers.length === 0) {
          return c.json({ error: 'No transfer to the game contract found in transaction' }, 400);
        }

        let transfer;
        if (action_id !== undefined) {
          deposit = await findDepositByActionId(action_id);
          transfer = deposit
            ? transfers.find(
                (t) => t.tokenId === deposit?.payment_token && t.amount === BigInt(deposit.amount)
              )
            : undefined;
          if (deposit && !transfer) {
            return c.json({ error: 'Transferred token or amount does not match request' }, 400);
          }
        } else {
          const txTime = await blockTime(receipt.blockNumber);
          for (const t of transfers) {
            deposit = await findDepositForTransfer({
              userId: user_id,
              paymentToken: t.tokenId,
              amount: t.amount,
              txTime,
            });
            if (deposit) {
              transfer = t;
              break;
            }
          }
        }
        if (!transfer) {
          return c.json({ error: 'Conversion request not found for transfer' }, 404);
        }
        paymentToken = transfer.tokenAddress;
        amount = transfer.amount;
        source = 'transfer';
      }

      if (!deposit) {
        return c.json({ error: 'Conversion request not found' }, 404);
      }
      if (deposit.user_id !== user_id) {
        return c.json({ error: 'Conversion does not belong to authenticated user' }, 403);
      }
      if (deposit.confirmation_id !== null) {
        // Confirmed by a different transaction.
        return c.json({ error: 'Conversion request was already paid' }, 409);
      }

      let payoutId: string | null;
      try {
        const result = await confirmDepositEvent({
          deposit,
          player,
          paymentToken,
          amount,
          txHash: tx_hash,
          txTime: await blockTime(receipt.blockNumber),
          source,
        });
        payoutId = result.payout_id;
      } catch (err) {
        if (err instanceof DepositMismatchError) {
          return c.json({ error: err.message }, 400);
        }
        if (!(err instanceof DepositAlreadyConfirmedError)) throw err;
        // A sync job confirmed it concurrently (possibly against another request).
        const confirmed = await findDepositByTxHash(tx_hash);
        if (confirmed?.user_id !== user_id) {
          return c.json({ error: 'Conversion request was already paid' }, 409);
        }
        payoutId = confirmed.payout_id;
      }

      return payoutResponse(c, payoutId);
    }
  );

async function blockTime(blockNumber: bigint): Promise<Date> {
  const block = await getBlock(blockNumber);
  return new Date(Number(block.timestamp) * 1000);
}

// Conversion deposit types always create a payout with the confirmation.
async function payoutResponse(c: Context<AuthEnv>, payoutId: string | null) {
  const payout = payoutId ? await getDepositPayout(payoutId) : null;
  if (!payout) {
    return c.json({ error: 'Conversion payout not found' }, 500);
  }
  return c.json({ payout });
}

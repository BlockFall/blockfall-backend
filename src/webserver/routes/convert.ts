import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { parseEventLogs, parseUnits, toHex } from 'viem';
import { z } from 'zod';
import blockFallGameAbi from '../../abis/blockfall-game.abi.ts';
import {
  BLOCKFALL_GAME_ADDRESS,
  CONVERT_MAX_USD,
  CONVERT_MIN_USD,
  DAILY_PAYOUT_TOKEN_ID,
  DEPOSIT_TTL_MS,
  DEPOSIT_TYPES,
  GD_PER_USD,
  GD_TOKEN_ID,
  PAYMENT_TOKENS,
  STABLE_TOKEN_IDS,
} from '../../constants.ts';
import {
  countRecentDeposits,
  DepositAlreadyConfirmedError,
  findDepositByActionId,
  getDepositPayout,
  insertDeposit,
} from '../../db/deposits.ts';
import { confirmDepositEvent, DepositMismatchError, findConversionType } from '../../deposits.ts';
import { getBlock, getBlockfallSeed, getTransactionReceipt } from '../../utils/celo-rpc-reader.ts';
import { stableToGdWei } from '../../utils/pricing.ts';
import { getSigner, randomActionId, signDeposit } from '../../utils/signer.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';

const MAX_DEPOSITS_PER_HOUR = 20;

// USD amounts are compared in 18-decimal fixed point.
const minUsdWei = parseUnits(CONVERT_MIN_USD, 18);
const maxUsdWei = parseUnits(CONVERT_MAX_USD, 18);

/**
 * Stablecoin → G$ conversion. Two on-chain transactions, both signed by the
 * backend:
 *   1. POST /convert/request → signed deposit() params; user deposits stablecoin
 *   2. POST /convert/submit  → verifies the Deposited event and returns a signed
 *      G$ claim() payout (also listed in GET /user pending_claims), which the
 *      user then claims through the normal /user_claims flow.
 */
export const convertRoutes = new Hono<AuthEnv>()
  // GET /convert/config — public: rate, limits and supported tokens
  .get('/config', (c) =>
    c.json({
      gd_per_usd: GD_PER_USD.toString(),
      min_usd: CONVERT_MIN_USD,
      max_usd: CONVERT_MAX_USD,
      gd_token: { id: GD_TOKEN_ID, ...PAYMENT_TOKENS[GD_TOKEN_ID] },
      stable_tokens: STABLE_TOKEN_IDS.map((id) => ({ id, ...PAYMENT_TOKENS[id] })),
      // Token daily rewards are currently paid in (see DAILY_PAYOUT_TOKEN_ID).
      reward_token: { id: DAILY_PAYOUT_TOKEN_ID, ...PAYMENT_TOKENS[DAILY_PAYOUT_TOKEN_ID] },
    })
  )

  .use(authMiddleware)

  // POST /convert/request — quote + signed deposit params
  .post(
    '/request',
    validator('json', (value, c) => {
      const result = z
        .object({
          payment_token: z.number().int(),
          amount_usd: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/, 'Invalid amount'),
        })
        .safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid request body', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { user_id, address } = c.var.user;
      const { payment_token, amount_usd } = c.req.valid('json');

      // Converting into G$: payment_token picks usdt_to_gd / usdc_to_gd / usdm_to_gd.
      const depositType = findConversionType(payment_token, GD_TOKEN_ID);
      if (depositType === null) {
        return c.json({ error: 'Unsupported payment token' }, 400);
      }
      const { depositToken } = DEPOSIT_TYPES[depositType];

      const usdWei = parseUnits(amount_usd, 18);
      if (usdWei < minUsdWei || usdWei > maxUsdWei) {
        return c.json(
          { error: `Amount must be between $${CONVERT_MIN_USD} and $${CONVERT_MAX_USD}` },
          400
        );
      }

      if ((await countRecentDeposits(user_id)) >= MAX_DEPOSITS_PER_HOUR) {
        return c.json({ error: 'Too many conversion requests. Please try again later.' }, 429);
      }

      const token = PAYMENT_TOKENS[depositToken];
      const amount = parseUnits(amount_usd, token.decimals);
      const quotedPayoutAmount = stableToGdWei(amount, token.decimals);

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
        quotedPayoutAmount: quotedPayoutAmount.toString(),
        signature,
        expiresAt,
      });

      return c.json({
        action_id: actionId,
        deposit_type: depositType,
        payment_token: depositToken,
        token_address: token.address,
        amount: amount.toString(),
        quoted_payout_amount: quotedPayoutAmount.toString(),
        signature,
        expires_at: expiresAt.toISOString(),
      });
    }
  )

  // POST /convert/submit — confirm the deposit tx, get the signed G$ claim
  .post(
    '/submit',
    validator('json', (value, c) => {
      const result = z
        .object({
          tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid transaction hash'),
        })
        .safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid request body', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { user_id, address } = c.var.user;
      const { tx_hash } = c.req.valid('json');

      let receipt;
      try {
        receipt = await getTransactionReceipt(tx_hash as `0x${string}`);
      } catch {
        return c.json({ error: 'Transaction not found on chain' }, 404);
      }

      if (receipt.status !== 'success') {
        return c.json({ error: 'Transaction was not successful' }, 400);
      }

      if (receipt.to?.toLowerCase() !== BLOCKFALL_GAME_ADDRESS.toLowerCase()) {
        return c.json({ error: 'Transaction is not for the BlockFallGame contract' }, 400);
      }

      const depositedLogs = parseEventLogs({
        abi: blockFallGameAbi,
        eventName: 'Deposited',
        logs: receipt.logs,
      });
      const event = depositedLogs[0];
      if (event == null) {
        return c.json({ error: 'No Deposited event found in transaction' }, 400);
      }

      const player = event.args.player.toLowerCase();
      if (player !== address.toLowerCase()) {
        return c.json({ error: 'Transaction player does not match authenticated user' }, 403);
      }

      const deposit = await findDepositByActionId(toHex(event.args.actionId));
      if (!deposit) {
        return c.json({ error: 'Conversion request not found for action_id' }, 404);
      }
      if (deposit.user_id !== user_id) {
        return c.json({ error: 'Conversion does not belong to authenticated user' }, 403);
      }

      // Idempotent: the sync job (or a retry) may already have confirmed it.
      let payoutId = deposit.payout_id;
      if (deposit.confirmation_id === null) {
        const block = await getBlock(receipt.blockNumber);
        const txTime = new Date(Number(block.timestamp) * 1000);
        try {
          const result = await confirmDepositEvent({
            deposit,
            player,
            paymentToken: event.args.paymentToken,
            amount: event.args.amount,
            txHash: tx_hash,
            txTime,
          });
          payoutId = result.payout_id;
        } catch (err) {
          if (err instanceof DepositMismatchError) {
            return c.json({ error: err.message }, 400);
          }
          if (!(err instanceof DepositAlreadyConfirmedError)) throw err;
          payoutId = (await findDepositByActionId(deposit.action_id))?.payout_id ?? null;
        }
      }

      // Conversion deposit types always create a payout with the confirmation.
      const payout = payoutId ? await getDepositPayout(payoutId) : null;
      if (!payout) {
        return c.json({ error: 'Conversion payout not found' }, 500);
      }

      return c.json({ payout });
    }
  );

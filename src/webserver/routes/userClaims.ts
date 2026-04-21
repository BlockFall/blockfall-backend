import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { parseEventLogs, toHex } from 'viem';
import { z } from 'zod';
import blockFallGameAbi from '../../abis/blockfall-game.abi.ts';
import { blockFallGameContractAddress } from '../../constants.ts';
import { findPayoutByActionId, processClaim } from '../../db/payouts.ts';
import { findTransactionByHash } from '../../db/purchases.ts';
import { findUserByAddress } from '../../db/users.ts';
import { getBlock, getTransactionReceipt } from '../../utils/celo-rpc-reader.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';

export const userClaimsRoutes = new Hono<AuthEnv>()
  .use(authMiddleware)

  // POST /user_claims/submit — submit a claim transaction hash for verification
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
      const { address } = c.var.user;
      const { tx_hash } = c.req.valid('json');

      // 1. Check user exists
      const user = await findUserByAddress(address);
      if (!user) {
        return c.json({ error: 'User not found' }, 404);
      }

      // 2. Check for duplicate transaction
      const exists = await findTransactionByHash(tx_hash);
      if (exists) {
        return c.json({ error: 'Transaction already processed' }, 409);
      }

      // 3. Fetch transaction receipt from blockchain
      let receipt;
      try {
        receipt = await getTransactionReceipt(tx_hash as `0x${string}`);
      } catch {
        return c.json({ error: 'Transaction not found on chain' }, 404);
      }

      if (receipt.status !== 'success') {
        return c.json({ error: 'Transaction was not successful' }, 400);
      }

      // 4. Verify the transaction was sent to our contract
      if (receipt.to?.toLowerCase() !== blockFallGameContractAddress.toLowerCase()) {
        return c.json({ error: 'Transaction is not for the BlockFallGame contract' }, 400);
      }

      // 5. Parse Claimed event from logs
      const claimedLogs = parseEventLogs({
        abi: blockFallGameAbi,
        eventName: 'Claimed',
        logs: receipt.logs,
      });

      if (claimedLogs.length === 0) {
        return c.json({ error: 'No Claimed event found in transaction' }, 400);
      }

      const event = claimedLogs[0]!;
      const player = event.args.player.toLowerCase();
      const actionIdHex = toHex(event.args.actionId);
      const amount = event.args.amount.toString();

      // 6. Validate player is the current user
      if (player !== address.toLowerCase()) {
        return c.json({ error: 'Transaction player does not match authenticated user' }, 403);
      }

      // 7. Look up the matching payout record
      const payout = await findPayoutByActionId(actionIdHex);
      if (!payout) {
        return c.json({ error: 'Payout record not found for action_id' }, 404);
      }

      if (payout.user_id !== user.user_id) {
        return c.json({ error: 'Payout does not belong to authenticated user' }, 403);
      }

      if (payout.claim_date !== null || payout.claim_transaction_id !== null) {
        return c.json({ error: 'Payout already claimed' }, 409);
      }

      // 8. Fetch block for transaction timestamp
      const block = await getBlock(receipt.blockNumber);
      const txTime = new Date(Number(block.timestamp) * 1000);

      // 9. Process the claim
      const eventParams = {
        actionId: actionIdHex,
        player,
        paymentToken: event.args.paymentToken,
        amount,
      };

      const result = await processClaim(
        user.user_id,
        payout.payout_id,
        tx_hash,
        txTime,
        eventParams
      );

      return c.json({
        transaction_id: result.transaction_id,
        payout_id: payout.payout_id,
        action_id: actionIdHex,
        amount,
      });
    }
  );

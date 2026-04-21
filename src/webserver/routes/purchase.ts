import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { parseEventLogs } from 'viem';
import { z } from 'zod';
import blockFallGameAbi from '../../abis/blockfall-game.abi.ts';
import { blockFallGameContractAddress } from '../../constants.ts';
import { findTransactionByHash, processPurchase } from '../../db/purchases.ts';
import { findUserByAddress } from '../../db/users.ts';
import { getBlock, getTransactionReceipt } from '../../utils/celo-rpc-reader.ts';
import { authMiddleware, type AuthEnv } from '../middleware/auth.ts';

const VALID_ITEM_TYPES = new Set([1, 2, 3, 4, 5]);

export const purchaseRoutes = new Hono<AuthEnv>()
  .use(authMiddleware)

  // POST /purchase/submit — submit a purchase transaction hash for verification
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

      // 5. Parse ItemBought event from logs
      const itemBoughtLogs = parseEventLogs({
        abi: blockFallGameAbi,
        eventName: 'ItemBought',
        logs: receipt.logs,
      });

      if (itemBoughtLogs.length === 0) {
        return c.json({ error: 'No ItemBought event found in transaction' }, 400);
      }

      const event = itemBoughtLogs[0]!;
      const itemTypeId = Number(event.args.itemTypeId);
      const buyer = event.args.buyer.toLowerCase();

      // 6. Validate buyer is the current user
      if (buyer !== address.toLowerCase()) {
        return c.json({ error: 'Transaction buyer does not match authenticated user' }, 403);
      }

      // 7. Validate item type
      if (!VALID_ITEM_TYPES.has(itemTypeId)) {
        return c.json({ error: 'Invalid item type' }, 400);
      }

      // 8. Fetch block for transaction timestamp
      const block = await getBlock(receipt.blockNumber);
      const txTime = new Date(Number(block.timestamp) * 1000);

      // 9. Process the purchase
      const price = event.args.price.toString();
      const eventParams = {
        itemTypeId,
        buyer,
        paymentToken: event.args.paymentToken,
        price,
      };

      const result = await processPurchase(
        user.user_id,
        tx_hash,
        txTime,
        price,
        itemTypeId,
        eventParams
      );

      return c.json({
        transaction_id: result.transaction_id,
        item_type_id: itemTypeId,
      });
    }
  );

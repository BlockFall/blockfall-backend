import { formatUnits } from 'viem';
import {
  GD_ADDRESS,
  GD_PER_USD,
  GD_TOKEN_ID,
  PAYMENT_TOKENS,
  type PaymentTokenId,
} from '../constants.ts';

const GD_DECIMALS = PAYMENT_TOKENS[4].decimals;

export function findPaymentTokenByAddress(address: string) {
  const lower = address.toLowerCase();
  return Object.values(PAYMENT_TOKENS).find((t) => t.address.toLowerCase() === lower) ?? null;
}

/**
 * Converts a stablecoin amount (in the token's smallest unit) to G$ wei at the
 * fixed GD_PER_USD rate. Stablecoins are treated as exactly 1 USD.
 */
export function stableToGdWei(amount: bigint, stableDecimals: number): bigint {
  if (stableDecimals > GD_DECIMALS) {
    throw new Error(`Unsupported stablecoin decimals: ${String(stableDecimals)}`);
  }
  return amount * 10n ** BigInt(GD_DECIMALS - stableDecimals) * GD_PER_USD;
}

/** Converts a USD amount expressed with `decimals` precision into G$ wei. */
export function usdToGdWei(usdAmount: bigint, decimals: number): bigint {
  return stableToGdWei(usdAmount, decimals);
}

/**
 * Converts a USD amount expressed with `usdDecimals` precision into the
 * smallest unit of `tokenId`: G$ at GD_PER_USD, stablecoins at face value
 * (rounded down to the token's decimals).
 */
export function usdToTokenWei(
  usdAmount: bigint,
  usdDecimals: number,
  tokenId: PaymentTokenId
): bigint {
  if (tokenId === GD_TOKEN_ID) return usdToGdWei(usdAmount, usdDecimals);
  const { decimals } = PAYMENT_TOKENS[tokenId];
  return decimals >= usdDecimals
    ? usdAmount * 10n ** BigInt(decimals - usdDecimals)
    : usdAmount / 10n ** BigInt(usdDecimals - decimals);
}

/**
 * USD value (human-readable string) of a payment made to the contract. Used as
 * user_transactions.revenue so revenue stays in one unit (USD) regardless of
 * the token paid with: stablecoins at face value, G$ divided by GD_PER_USD.
 * Unknown tokens count as 0.
 */
export function revenueUsdForPayment(tokenAddress: string, amount: bigint): string {
  if (tokenAddress.toLowerCase() === GD_ADDRESS.toLowerCase()) {
    return formatUnits(amount / GD_PER_USD, GD_DECIMALS);
  }
  const token = findPaymentTokenByAddress(tokenAddress);
  return token ? formatUnits(amount, token.decimals) : '0';
}

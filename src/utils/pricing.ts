import { formatUnits } from 'viem';
import {
  DEPOSIT_TYPES,
  type DepositType,
  type DepositTypeDef,
  GD_ADDRESS,
  GD_PER_USD_BUY,
  GD_PER_USD_ITEM,
  GD_PER_USD_SELL,
  GD_TOKEN_ID,
  PAYMENT_TOKENS,
  type PaymentTokenId,
} from '../constants.ts';

const GD_DECIMALS = PAYMENT_TOKENS[GD_TOKEN_ID].decimals;

export function findPaymentTokenByAddress(address: string) {
  const lower = address.toLowerCase();
  return Object.values(PAYMENT_TOKENS).find((t) => t.address.toLowerCase() === lower) ?? null;
}

function checkStableDecimals(decimals: number): void {
  if (decimals > GD_DECIMALS) {
    throw new Error(`Unsupported stablecoin decimals: ${String(decimals)}`);
  }
}

/**
 * Buying G$: stablecoin amount (smallest unit) → G$ wei at GD_PER_USD_BUY.
 * Stablecoins are treated as exactly 1 USD.
 */
export function stableToGdWei(amount: bigint, stableDecimals: number): bigint {
  checkStableDecimals(stableDecimals);
  return amount * 10n ** BigInt(GD_DECIMALS - stableDecimals) * GD_PER_USD_BUY;
}

/**
 * Selling G$: G$ wei → stablecoin amount (smallest unit) at GD_PER_USD_SELL,
 * rounded down.
 */
export function gdToStableWei(gdWei: bigint, stableDecimals: number): bigint {
  checkStableDecimals(stableDecimals);
  return gdWei / (10n ** BigInt(GD_DECIMALS - stableDecimals) * GD_PER_USD_SELL);
}

/**
 * Converts a USD amount expressed with `usdDecimals` precision into the
 * smallest unit of `tokenId`: G$ at GD_PER_USD_BUY (daily reward pool),
 * stablecoins at face value (rounded down to the token's decimals).
 */
export function usdToTokenWei(
  usdAmount: bigint,
  usdDecimals: number,
  tokenId: PaymentTokenId
): bigint {
  if (tokenId === GD_TOKEN_ID) return stableToGdWei(usdAmount, usdDecimals);
  const { decimals } = PAYMENT_TOKENS[tokenId];
  return decimals >= usdDecimals
    ? usdAmount * 10n ** BigInt(decimals - usdDecimals)
    : usdAmount / 10n ** BigInt(usdDecimals - decimals);
}

export interface ConversionQuote {
  /** Payout amount in the payout token's smallest unit. */
  payoutAmount: bigint;
  /** USD value of the conversion in 18-decimal fixed point (for limits). */
  usdWei: bigint;
}

/**
 * Quotes a conversion deposit: `amount` of the deposit token (smallest unit)
 * → payout token. Stablecoin → G$ uses GD_PER_USD_BUY, G$ → stablecoin uses
 * GD_PER_USD_SELL. Returns null for deposit types that are not conversions.
 */
export function quoteConversion(depositType: DepositType, amount: bigint): ConversionQuote | null {
  // Widened on purpose: future deposit types may have no payout.
  const def: DepositTypeDef = DEPOSIT_TYPES[depositType];
  if (def.payoutToken === null) return null;

  if (def.payoutToken === GD_TOKEN_ID) {
    const { decimals } = PAYMENT_TOKENS[def.depositToken];
    return {
      payoutAmount: stableToGdWei(amount, decimals),
      usdWei: amount * 10n ** BigInt(18 - decimals),
    };
  }
  if (def.depositToken === GD_TOKEN_ID) {
    const { decimals } = PAYMENT_TOKENS[def.payoutToken];
    const payoutAmount = gdToStableWei(amount, decimals);
    return { payoutAmount, usdWei: payoutAmount * 10n ** BigInt(18 - decimals) };
  }
  return null;
}

/**
 * USD value (human-readable string) of a purchase paid to the contract. Used as
 * user_transactions.revenue so revenue stays in one unit (USD) regardless of
 * the token paid with: stablecoins at face value, G$ ÷ GD_PER_USD_ITEM (the
 * static item price rate). Unknown tokens count as 0.
 */
export function revenueUsdForPayment(tokenAddress: string, amount: bigint): string {
  if (tokenAddress.toLowerCase() === GD_ADDRESS.toLowerCase()) {
    return formatUnits(amount / GD_PER_USD_ITEM, GD_DECIMALS);
  }
  const token = findPaymentTokenByAddress(tokenAddress);
  return token ? formatUnits(amount, token.decimals) : '0';
}

export const chainId = 42220;
export const rpcUrls = [
  'https://forno.celo.org',
  'https://rpc.ankr.com/celo',
  'https://celo-json-rpc.stakely.io',
  'https://rpc.celocolombia.org',
  'https://celo-mainnet.infura.io/v3/334f70b8ccb84c4ca47736432704fd00',
];

// ---------------------------------------------------------------------------
// Item types
// 1-100 is reserved for energy packages
// 101-200 is reserved for mystery boxes
// 201-300 is for boosts
// 301-400 is for G$ prizes (mystery box only, paid out as a claimable payout)
// ---------------------------------------------------------------------------

export const ENERGY_BY_ITEM_TYPE: Record<number, number> = {
  1: 1,
  2: 10,
  3: 25,
  4: 50,
  5: 5,
};

export const MYSTERY_BOX_ITEM_TYPE = 101;

// Item types accepted by the purchase flow (/purchase/submit and the ItemBought
// sync job). Buys for any other item type are ignored as unsupported.
export const VALID_PURCHASE_ITEM_TYPES = new Set([1, 2, 3, 4, 5]);

export const BOOST_INFO_BY_ITEM_TYPE: Record<
  number,
  { multiplier: number; durationMinutes: number }
> = {
  201: { multiplier: 125, durationMinutes: 60 },
  202: { multiplier: 125, durationMinutes: 180 },
  203: { multiplier: 125, durationMinutes: 360 },
  204: { multiplier: 150, durationMinutes: 60 },
  205: { multiplier: 150, durationMinutes: 180 },
};

// G$ mystery-box prizes: item type → human-readable G$ amount. Opening a box
// that yields one of these creates a signed 'mystery_box' user_payouts row the
// user claims on-chain (no user_items row).
export const GD_PRIZE_BY_ITEM_TYPE: Record<number, string> = {
  301: '25',
  302: '50',
  303: '100',
};

// ---------------------------------------------------------------------------

export const BLOCKFALL_GAME_ADDRESS = '0x8388DdfD12da76adA04BcF38De85F861fA3FeE54';
export const USDT_ADDRESS = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
export const USDC_ADDRESS = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
export const USDm_ADDRESS = '0x765DE816845861e75A25fCA122bb6898B8B1282a';

export const GD_ADDRESS = '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A'; // GoodDollar (G$)

export const GD_TOKEN_ID = 4 as const;

export const PAYMENT_TOKENS = {
  1: { address: USDT_ADDRESS, symbol: 'USDT', decimals: 6 },
  2: { address: USDC_ADDRESS, symbol: 'USDC', decimals: 6 },
  3: { address: USDm_ADDRESS, symbol: 'USDm', decimals: 18 },
  4: { address: GD_ADDRESS, symbol: 'G$', decimals: 18 },
};

export type PaymentTokenId = keyof typeof PAYMENT_TOKENS;

// Stablecoins that can be converted to and from G$.
export const STABLE_TOKEN_IDS = [1, 2, 3] as const;
export type StableTokenId = (typeof STABLE_TOKEN_IDS)[number];

// ---------------------------------------------------------------------------
// Deposit types (user_deposits.deposit_type)
// ---------------------------------------------------------------------------

// What each deposit is for. `payoutToken` is the token paid back to the user
// as a 'conversion' payout once the deposit is confirmed, or null for deposit
// types that produce no payout. Adding a type: add it here AND to the
// deposit_type CHECK in schema.sql (plus a migration).
export interface DepositTypeDef {
  depositToken: PaymentTokenId;
  payoutToken: PaymentTokenId | null;
}

export const DEPOSIT_TYPES = {
  usdt_to_gd: { depositToken: 1, payoutToken: GD_TOKEN_ID },
  usdc_to_gd: { depositToken: 2, payoutToken: GD_TOKEN_ID },
  usdm_to_gd: { depositToken: 3, payoutToken: GD_TOKEN_ID },
  gd_to_usdt: { depositToken: GD_TOKEN_ID, payoutToken: 1 },
  gd_to_usdc: { depositToken: GD_TOKEN_ID, payoutToken: 2 },
  gd_to_usdm: { depositToken: GD_TOKEN_ID, payoutToken: 3 },
} as const satisfies Record<string, DepositTypeDef>;

export type DepositType = keyof typeof DEPOSIT_TYPES;

// ---------------------------------------------------------------------------
// G$ economy
// ---------------------------------------------------------------------------

// Fixed rates, in G$ per 1 USD. Stablecoins count as exactly 1 USD.

// Item prices: G$ item price = USD price × this (static on-chain prices, see
// setup-game.ts in the contracts repo: 1 energy = 100 G$, 10 = 700 G$, …).
// Also used to turn G$ purchases back into USD revenue.
export const GD_PER_USD_ITEM = 10_000n;

// Buying G$ (stablecoin → G$ conversions): $1 = 8,500 G$. Also used to turn the
// USD daily reward pool into G$.
export const GD_PER_USD_BUY = 8_500n;

// Selling G$ (G$ → stablecoin conversions): 9,000 G$ = $1.
export const GD_PER_USD_SELL = 9_000n;

// Per-conversion maximum, in human-readable USD (both directions; for G$ →
// stablecoin the USD value is the stablecoin received). There is no minimum:
// any amount works as long as both sides are greater than 0.
export const CONVERT_MAX_USD = '20';

// How long a deposit request is valid. The frontend must not submit the
// deposit after this (it requests a fresh one instead). The contract cannot
// enforce it, so a late deposit is still honoured at quoted_payout_amount.
export const DEPOSIT_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Daily tournament payouts
// ---------------------------------------------------------------------------

// Token used for daily reward payouts. Matches keys in PAYMENT_TOKENS.
//
// Rewards can be paid in only one token at a time:
//   GD_TOKEN_ID (4) — current
//   1 (USDT)        — the old stablecoin setup
// The value is exposed to the frontend via GET /convert/config (reward_token),
// so the app's texts follow this switch automatically. Payouts already
// created keep the token they were signed with.
export const DAILY_PAYOUT_TOKEN_ID: PaymentTokenId = GD_TOKEN_ID;

// Minimum total revenue (revenue + inherited_revenue), in USD, required to
// trigger a payout. Only purchases count as revenue; it is stored in USD
// (G$ purchases ÷ GD_PER_USD_ITEM). The pool is converted to the payout token
// when paid out (G$: × GD_PER_USD_BUY). If total is below this, the day's
// revenue rolls over to the next day.
export const MIN_PAYOUT_THRESHOLD_USD = '0.5';

// Mystery box prize selected as next item from a randomized batch (mystery_box_prizes).
// If there are no more items to give, a new batch is created from these counts
// (currently 60 prizes) and shuffled.
// Record<itemId, { countInBatch: number }>
export const MYSTERY_BOX_PRIZES = {
  5: { countInBatch: 5 }, // 5 energy
  2: { countInBatch: 3 }, // 10 energy
  3: { countInBatch: 2 }, // 25 energy
  4: { countInBatch: 1 }, // 50 energy
  201: { countInBatch: 8 }, // 1.25x Boost (1 Hour)
  202: { countInBatch: 6 }, // 1.25x Boost (3 Hour)
  203: { countInBatch: 5 }, // 1.25x Boost (6 Hour)
  204: { countInBatch: 6 }, // 1.5x Boost (1 Hour)
  205: { countInBatch: 4 }, // 1.5x Boost (3 Hour)
  301: { countInBatch: 10 }, // 25 G$
  302: { countInBatch: 6 }, // 50 G$
  303: { countInBatch: 4 }, // 100 G$
};

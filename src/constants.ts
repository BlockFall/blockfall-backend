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

// Stablecoins a user can convert into G$ (deposit side of /convert).
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
} as const satisfies Record<string, DepositTypeDef>;

export type DepositType = keyof typeof DEPOSIT_TYPES;

// ---------------------------------------------------------------------------
// G$ economy
// ---------------------------------------------------------------------------

// Fixed exchange rate: how many G$ one US dollar buys. Used for stablecoin →
// G$ conversions, for G$ item prices (USD price × rate, see setup-game.ts in
// the contracts repo) and for normalising G$ revenue back to USD.
// Changing this requires re-running setPrice for the G$ item prices.
export const GD_PER_USD = 8500n;

// Per-conversion limits, in human-readable USD.
export const CONVERT_MIN_USD = '0.10';
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
// Rewards can be paid in only one token at a time, so this is the single
// switch between the old stablecoin version and the G$ version:
//   1 (USDT)        — while the stablecoin frontend is still live (current)
//   GD_TOKEN_ID (4) — once everyone is on the G$ frontend
// Buying (stablecoin or G$) and G$ conversions work the same either way.
// The value is exposed to the frontend via GET /convert/config (reward_token),
// so the app's texts follow this switch automatically. Payouts already
// created keep the token they were signed with.
export const DAILY_PAYOUT_TOKEN_ID: PaymentTokenId = 1;

// Minimum total revenue (revenue + inherited_revenue), in USD, required to
// trigger a payout. Revenue is always stored in USD (G$ purchases are
// normalised with GD_PER_USD); the pool is converted to DAILY_PAYOUT_TOKEN_ID
// when paid out. If total is below this, the day's revenue rolls over to the
// next day.
export const MIN_PAYOUT_THRESHOLD_USD = '0.5';

// Mystery box prize selected as next item from 40 randomized prizes in a batch (mystery_box_prizes)
// If there is no more items to give, It should create 40 new items according to count and randomize them.
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
};

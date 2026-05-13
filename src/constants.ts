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

export const PAYMENT_TOKENS = {
  1: { address: USDT_ADDRESS, symbol: 'USDT', decimals: 6 },
  2: { address: USDC_ADDRESS, symbol: 'USDC', decimals: 6 },
  3: { address: USDm_ADDRESS, symbol: 'USDm', decimals: 18 },
};

// ---------------------------------------------------------------------------
// Daily tournament payouts
// ---------------------------------------------------------------------------

// Token used for daily reward payouts. Matches keys in PAYMENT_TOKENS.
export const DAILY_PAYOUT_TOKEN_ID = 1 as const; // USDT

// Minimum total revenue (revenue + inherited_revenue), in human-readable
// USDT, required to trigger a payout. If total is below this, the day's
// revenue rolls over to the next day's inherited_revenue.
export const MIN_PAYOUT_THRESHOLD_USDT = '2';

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

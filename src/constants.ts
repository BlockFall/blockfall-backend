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

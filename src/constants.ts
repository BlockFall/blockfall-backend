export const chainId = 42220;
export const rpcUrls = [
  'https://forno.celo.org',
  'https://rpc.ankr.com/celo',
  'https://celo-json-rpc.stakely.io',
  'https://rpc.celocolombia.org',
  'https://celo-mainnet.infura.io/v3/334f70b8ccb84c4ca47736432704fd00',
];
export const blockFallGameContractAddress = '0x8388DdfD12da76adA04BcF38De85F861fA3FeE54';

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

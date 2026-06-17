const percentageByRank: Record<number, number> = {
  1: 17.0,
  2: 12.0,
  3: 8.0,
  4: 5.227,
  5: 5.002,
  6: 4.777,
  7: 4.552,
  8: 4.327,
  9: 4.102,
  10: 3.877,
  11: 3.652,
  12: 3.427,
  13: 3.202,
  14: 2.977,
  15: 2.752,
  16: 2.527,
  17: 2.302,
  18: 2.077,
  19: 1.852,
  20: 1.627,
  21: 1.402,
  22: 1.177,
  23: 0.952,
  24: 0.727,
  25: 0.5,
};

export function getPercentageByRank(rank: number): number {
  if (rank < 1) {
    throw new Error('Rank must be at least 1');
  }
  if (rank > 25) {
    return 0;
  }
  return percentageByRank[rank] ?? 0;
}

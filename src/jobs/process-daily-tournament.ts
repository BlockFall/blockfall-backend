import { formatUnits, parseUnits, toHex } from 'viem';
import { DAILY_PAYOUT_TOKEN_ID, MIN_PAYOUT_THRESHOLD_USD, PAYMENT_TOKENS } from '../constants.ts';
import { withTransaction } from '../db/index.ts';
import {
  fetchDayRevenue,
  fetchPreviousDayResult,
  fetchTopRankedPlayers,
  findOldestUnprocessedTournament,
  insertDailyTotalScores,
  insertDailyTournamentResult,
  insertUserPayouts,
  type PayoutInsert,
  type RankedPlayerRow,
} from '../db/tournaments.ts';
import { getPercentageByRank } from '../distribution-rates.ts';
import { getBlockfallSeed } from '../utils/celo-rpc-reader.ts';
import { usdToTokenWei } from '../utils/pricing.ts';
import { getSigner, randomActionId, signClaim } from '../utils/signer.ts';
import { banSuspiciousUsers } from './ban-suspicious-users.ts';

// Run cadence — index.ts schedules this with maintainAsyncJob.
export const PROCESS_TOURNAMENT_INTERVAL_MS = 10 * 60 * 1000;

// Percentages have at most 3 decimal places (see distribution-rates.ts).
// Multiplying by 1000 converts them into integer "milli-percent" so we can do
// the per-rank multiplication in BigInt without losing precision.
const PERCENTAGE_SCALE = 1000n;

// Revenue is stored in USD (NUMERIC). We do the arithmetic in 18-decimal
// fixed point so G$-derived revenue (USD = G$ / GD_PER_USD_ITEM) keeps precision.
const USD_DECIMALS = 18;

const payoutToken = PAYMENT_TOKENS[DAILY_PAYOUT_TOKEN_ID];

/**
 * Picks the oldest unprocessed daily tournament (strictly before today UTC)
 * and processes it: writes daily_total_scores, computes revenue + inherited
 * revenue, and (if total revenue clears MIN_PAYOUT_THRESHOLD_USD) signs and
 * inserts user_payouts in DAILY_PAYOUT_TOKEN_ID for the top-25 ranked players
 * (USD pool converted to that token). Always finalises by
 * inserting daily_tournament_results, which marks the tournament processed.
 *
 * Concurrency: every step inside the transaction sits behind a
 * pg_advisory_xact_lock keyed on the tournament_id, so multiple backend
 * instances racing this job will serialize per-tournament. The transaction
 * also re-checks for a result row after taking the lock, so the second
 * instance returns immediately when the first commits.
 *
 * Returns the tournament_id that was processed, or null if there was nothing
 * to do this tick.
 */
export async function processDailyTournamentTick(): Promise<string | null> {
  const tournament = await findOldestUnprocessedTournament();
  if (!tournament) return null;

  // SEED is fetched once and cached. Doing it before opening the transaction
  // keeps the RPC call out of the transaction's lock window.
  const seed = await getBlockfallSeed();
  const signer = getSigner();

  await withTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${tournament.daily_tournament_id}::bigint)`;

    // Re-check after taking the lock: another instance may have processed
    // this tournament between our findOldestUnprocessedTournament() and the
    // lock acquisition.
    const already = await tx`
      SELECT 1 FROM daily_tournament_results
      WHERE  daily_tournament_id = ${tournament.daily_tournament_id}
    `;
    if (already.length > 0) return;

    // Ban cheaters before computing the day's leaderboard so banned users are
    // excluded from daily_total_scores and from any payout.
    await banSuspiciousUsers(tournament.daily_tournament_id, tx);

    await insertDailyTotalScores(tx, tournament.daily_tournament_id, tournament.tournament_date);

    const topPlayers = await fetchTopRankedPlayers(tx, tournament.tournament_date);
    const dayRevenue = await fetchDayRevenue(tx, tournament.tournament_date);
    const prev = await fetchPreviousDayResult(tx, tournament.tournament_date);

    // Inherited revenue rolls over only if the previous day's payout was
    // skipped (used_for_payout = 0).
    const inheritedRevenueWei =
      prev && parseUnits(prev.used_for_payout, USD_DECIMALS) === 0n
        ? parseUnits(prev.revenue, USD_DECIMALS) + parseUnits(prev.inherited_revenue, USD_DECIMALS)
        : 0n;

    const revenueWei = parseUnits(dayRevenue, USD_DECIMALS);
    const totalRevenueWei = revenueWei + inheritedRevenueWei;
    const thresholdWei = parseUnits(MIN_PAYOUT_THRESHOLD_USD, USD_DECIMALS);

    // We pay out only if there's enough revenue AND there are players to pay.
    // No-players-but-revenue (rare edge case) rolls over to next day rather
    // than burning half the revenue.
    const willPayOut = totalRevenueWei >= thresholdWei && topPlayers.length > 0;
    const usedForPayoutWei = willPayOut ? totalRevenueWei : 0n;

    if (willPayOut) {
      const payoutPoolWei = usdToTokenWei(usedForPayoutWei, USD_DECIMALS, DAILY_PAYOUT_TOKEN_ID);
      const payouts = buildPayouts(topPlayers, payoutPoolWei);
      const signedPayouts = await Promise.all(
        payouts.map(async (p) => ({
          ...p,
          signature: await signClaim(
            signer,
            seed,
            p.actionIdBigInt,
            p.address,
            payoutToken.address,
            p.amountWei
          ),
        }))
      );

      const payoutInserts: PayoutInsert[] = signedPayouts.map((p) => ({
        user_id: p.user_id,
        action_id: p.action_id,
        amount: p.amountWei.toString(),
        payment_token: DAILY_PAYOUT_TOKEN_ID,
        signature: p.signature,
      }));

      await insertUserPayouts(tx, tournament.daily_tournament_id, payoutInserts);
    }

    await insertDailyTournamentResult(
      tx,
      tournament.daily_tournament_id,
      dayRevenue,
      formatUnits(inheritedRevenueWei, USD_DECIMALS),
      formatUnits(usedForPayoutWei, USD_DECIMALS)
    );
  });

  return tournament.daily_tournament_id;
}

/**
 * One job tick: drain every unprocessed day back-to-back. Catches the system
 * up after downtime without waiting 10 minutes per day. maintainAsyncJob
 * (see index.ts) handles the inter-run sleep.
 */
export async function runDailyTournamentJob(): Promise<void> {
  for (;;) {
    const processedId = await processDailyTournamentTick();
    if (processedId === null) break;
    console.log(`processed daily tournament ${processedId}`);
  }
}

interface BuiltPayout {
  user_id: string;
  address: string;
  amountWei: bigint;
  actionIdBigInt: bigint;
  action_id: string;
}

function buildPayouts(players: RankedPlayerRow[], payoutPoolWei: bigint): BuiltPayout[] {
  const result: BuiltPayout[] = [];
  for (const player of players) {
    const percentage = getPercentageByRank(player.rank);
    if (percentage === 0) continue;

    const percentageScaled = BigInt(Math.round(percentage * Number(PERCENTAGE_SCALE)));
    // Total scale: 100 (percent) * PERCENTAGE_SCALE
    const amountWei = (payoutPoolWei * percentageScaled) / (100n * PERCENTAGE_SCALE);
    if (amountWei === 0n) continue;

    const actionIdBigInt = randomActionId();
    result.push({
      user_id: player.user_id,
      address: player.address,
      amountWei,
      actionIdBigInt,
      action_id: toHex(actionIdBigInt),
    });
  }
  return result;
}

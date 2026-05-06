// Stress test runner — drives concurrent virtual users against the API using
// the tokens produced by setup.ts.
//
// Run:
//   node --experimental-strip-types src/stress/run.ts
//
// Per virtual user:
//   - Wait a random 0-10s before starting (stagger).
//   - Loop: /game/start → 2 events/sec for 60s → /game/end → 0-5s wait,
//     until /game/start fails (no energy left).
//   - Concurrently: poll /user every 1s and /leaderboard every 5s while
//     games are still being played.

import fs from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = 'http://localhost:3000';
const TOKENS_FILE = path.resolve('src/stress/tokens.json');

const STAGGER_MAX_MS = 10_000;
const GAME_DURATION_MS = 60_000;
const EVENT_INTERVAL_MS = 500; // 2 events/sec
const POST_GAME_WAIT_MAX_MS = 5_000;
const USER_POLL_MS = 1_000;
const LEADERBOARD_POLL_MS = 5_000;
const REPORT_INTERVAL_MS = 5_000;

interface TestUser {
  privateKey: string;
  address: string;
  name: string;
  token: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Stats {
  private latencies: number[] = [];
  private byStatus = new Map<number, number>();
  private errorCount = 0;
  private intervalCount = 0;

  record(latencyMs: number, status: number): void {
    this.latencies.push(latencyMs);
    this.byStatus.set(status, (this.byStatus.get(status) ?? 0) + 1);
    this.intervalCount++;
    if (status === 0 || status >= 400) this.errorCount++;
  }

  takeIntervalCount(): number {
    const n = this.intervalCount;
    this.intervalCount = 0;
    return n;
  }

  summary(): {
    count: number;
    errors: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    byStatus: Record<string, number>;
  } | null {
    if (this.latencies.length === 0) return null;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return {
      count: sorted.length,
      errors: this.errorCount,
      p50: Math.round(at(0.5)),
      p95: Math.round(at(0.95)),
      p99: Math.round(at(0.99)),
      max: Math.round(sorted[sorted.length - 1] ?? 0),
      byStatus: Object.fromEntries([...this.byStatus.entries()].map(([k, v]) => [k.toString(), v])),
    };
  }
}

const stats = {
  user: new Stats(),
  leaderboard: new Stats(),
  start: new Stats(),
  end: new Stats(),
  event: new Stats(),
};

interface Timed<T> {
  status: number;
  body: T | null;
}

async function timed<T>(s: Stats, fn: () => Promise<Response>): Promise<Timed<T>> {
  const t0 = performance.now();
  let status = 0;
  let body: T | null = null;
  try {
    const res = await fn();
    status = res.status;
    if (res.ok) {
      body = (await res.json()) as T;
    } else {
      await res.text(); // drain
    }
  } catch {
    status = 0;
  }
  s.record(performance.now() - t0, status);
  return { status, body };
}

async function runUser(user: TestUser): Promise<void> {
  await sleep(Math.random() * STAGGER_MAX_MS);

  const auth = { Authorization: `Bearer ${user.token}` };
  let done = false;

  const userPolling = (async () => {
    while (!done) {
      await timed(stats.user, () => fetch(`${BASE_URL}/user`, { headers: auth }));
      if (done) break;
      await sleep(USER_POLL_MS);
    }
  })();

  const lbPolling = (async () => {
    while (!done) {
      await timed(stats.leaderboard, () => fetch(`${BASE_URL}/leaderboard`, { headers: auth }));
      if (done) break;
      await sleep(LEADERBOARD_POLL_MS);
    }
  })();

  const cnPolling = (async () => {
    while (!done) {
      await timed(stats.leaderboard, () =>
        fetch(`${BASE_URL}/auth/checkname?name=testABC`, { headers: auth })
      );
      if (done) break;
      await sleep(Math.random() * USER_POLL_MS);
    }
  })();

  while (true) {
    const startRes = await timed<{ game_play_id: string }>(stats.start, () =>
      fetch(`${BASE_URL}/game/start`, { method: 'POST', headers: auth })
    );
    if (!startRes.body) break; // out of energy or unrecoverable error

    const gameId = startRes.body.game_play_id;
    const gameEnd = Date.now() + GAME_DURATION_MS;
    let eventIdx = 0;
    while (Date.now() < gameEnd) {
      const tickStart = Date.now();
      await timed(stats.event, () =>
        fetch(`${BASE_URL}/game/event`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({
            game_play_id: gameId,
            event_type: 'tick',
            intval: eventIdx++,
          }),
        })
      );
      const elapsed = Date.now() - tickStart;
      await sleep(Math.max(0, EVENT_INTERVAL_MS - elapsed));
    }

    const score = Math.floor(Math.random() * 5000);
    await timed(stats.end, () =>
      fetch(`${BASE_URL}/game/end`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ game_play_id: gameId, score }),
      })
    );

    await sleep(Math.random() * POST_GAME_WAIT_MAX_MS);
  }

  done = true;
  await Promise.all([userPolling, lbPolling, cnPolling]);
}

function formatRow(name: string, s: Stats, intervalSec: number): string {
  const sm = s.summary();
  const reqsThisInterval = s.takeIntervalCount();
  const rps = (reqsThisInterval / intervalSec).toFixed(0);
  if (!sm) return `  ${name.padEnd(12)} -`;
  return (
    `  ${name.padEnd(12)} total=${sm.count.toString().padStart(7)} ` +
    `err=${sm.errors.toString().padStart(5)} ` +
    `rps=${rps.padStart(5)} ` +
    `p50=${sm.p50.toString().padStart(4)}ms ` +
    `p95=${sm.p95.toString().padStart(5)}ms ` +
    `p99=${sm.p99.toString().padStart(6)}ms`
  );
}

async function main(): Promise<void> {
  const users = JSON.parse(await fs.readFile(TOKENS_FILE, 'utf8')) as TestUser[];
  console.log(`Loaded ${users.length.toString()} test users from ${TOKENS_FILE}`);
  console.log(`Target: ${BASE_URL}`);
  console.log('Starting load test...\n');

  const startTime = Date.now();
  let active = users.length;

  const reporter = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const intervalSec = REPORT_INTERVAL_MS / 1000;
    const lines = Object.entries(stats).map(([k, s]) => formatRow(k, s, intervalSec));
    console.log(
      `\n[t=${elapsed}s] active=${active.toString()}/${users.length.toString()}\n${lines.join('\n')}`
    );
  }, REPORT_INTERVAL_MS);
  reporter.unref();

  await Promise.all(
    users.map((u) =>
      runUser(u)
        .catch((e: unknown) => {
          console.error(`user ${u.address} error:`, e);
        })
        .finally(() => {
          active--;
        })
    )
  );

  clearInterval(reporter);
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== FINAL SUMMARY (${totalSec}s) ===`);
  for (const [k, s] of Object.entries(stats)) {
    console.log(`${k}:`, s.summary());
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

import postgres from 'postgres';
import config from '../config.ts';

/**
 * Shared connection pool — import `sql` wherever you need to run queries.
 * postgres.js is lazy: the pool connects on the first query, not at import time.
 */
export const sql = postgres(config.DATABASE_URL, {
  max: 10, // max pool size
  idle_timeout: 30, // close idle connections after 30 s
  connect_timeout: 10,
});

/**
 * Run `fn` inside a database transaction.
 *
 * Use this instead of `sql.begin()` to sidestep a known race condition in
 * postgres.js (https://github.com/porsager/postgres/issues/823) that surfaces
 * under high concurrency as `UNSAFE_TRANSACTION` errors plus PostgreSQL
 * warnings "there is already a transaction in progress" (code 25001):
 * `sql.begin()` marks the connection reserved via an `onexecute` callback that
 * is skipped under TCP backpressure or pipeline saturation, so the pool can
 * end up dispatching a second BEGIN onto a connection that still has a
 * transaction in flight.
 *
 * `sql.reserve()` flips the reservation flag synchronously *before* any query
 * is sent, so the pool's transaction bookkeeping cannot race with the BEGIN.
 */
export async function withTransaction<T>(
  fn: (tx: postgres.ReservedSql) => Promise<T>
): Promise<T> {
  const tx = await sql.reserve();
  try {
    await tx`BEGIN`;
    try {
      const result = await fn(tx);
      await tx`COMMIT`;
      return result;
    } catch (err) {
      try {
        await tx`ROLLBACK`;
      } catch {
        // best-effort rollback; the original error is what we care about
      }
      throw err;
    }
  } finally {
    tx.release();
  }
}

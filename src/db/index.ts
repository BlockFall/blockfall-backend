import postgres from 'postgres';
import config from '../config.ts';

/**
 * Shared connection pool — import `sql` wherever you need to run queries.
 * postgres.js is lazy: the pool connects on the first query, not at import time.
 */
export const sql = postgres(config.DATABASE_URL, {
  max: 10,           // max pool size
  idle_timeout: 30,  // close idle connections after 30 s
  connect_timeout: 10,
});

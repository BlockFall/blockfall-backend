import { sql } from './index.ts';

// ---------------------------------------------------------------------------
// Row types — mirror the schema exactly.
// postgres.js returns BIGINT columns as strings to preserve precision.
// ---------------------------------------------------------------------------

export interface UserRow {
  user_id: string;
  address: string; // lowercase 0x-prefixed, 40 hex chars
  name: string;
  created_at: Date;
  updated_at: Date | null;
}

export type UserWithNumbersRow = UserRow & {
  best_score: number;
  last_score: number;
  games_played: number;
  total_score: string; // BIGINT → string
  today_score: number;
  energy: number;
};

// ---------------------------------------------------------------------------
// ID generation
// Simple 63-bit ID: 42-bit ms timestamp | 21-bit random — no external dep.
// Collision-safe for the traffic volumes of a game backend.
// ---------------------------------------------------------------------------

function generateId(): bigint {
  const ts = BigInt(Date.now()) & 0x3ffffffffffn; // 42 bits
  const rand = BigInt(Math.floor(Math.random() * (1 << 21)));
  return (ts << 21n) | rand;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function findUserByAddress(address: string): Promise<UserRow | null> {
  const rows = await sql<UserRow[]>`
    SELECT user_id, address, name, created_at, updated_at
    FROM   users
    WHERE  address = ${address.toLowerCase()}
  `;
  return rows[0] ?? null;
}

export async function findUserByName(name: string): Promise<UserRow | null> {
  const rows = await sql<UserRow[]>`
    SELECT user_id, address, name, created_at, updated_at
    FROM   users
    WHERE  name = ${name}
  `;
  return rows[0] ?? null;
}

export async function getUserWithNumbers(address: string): Promise<UserWithNumbersRow | null> {
  const rows = await sql<UserWithNumbersRow[]>`
    SELECT
      u.user_id,
      u.address,
      u.name,
      u.created_at,
      u.updated_at,
      COALESCE(un.best_score,    0) AS best_score,
      COALESCE(un.last_score,    0) AS last_score,
      COALESCE(un.games_played,  0) AS games_played,
      COALESCE(un.total_score,   0) AS total_score,
      COALESCE(ts.today_score,   0) AS today_score,
      COALESCE(un.energy,        0) AS energy
    FROM   users        u
    LEFT JOIN user_numbers un ON un.user_id = u.user_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(gp.score), 0)::int AS today_score
      FROM   game_plays gp
      JOIN   daily_tournaments dt ON dt.daily_tournament_id = gp.daily_tournament_id
      WHERE  gp.user_id = u.user_id
        AND  dt.tournament_date = CURRENT_DATE
        AND  gp.score IS NOT NULL
    ) ts ON true
    WHERE  u.address = ${address.toLowerCase()}
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface UserItemRow {
  item_id: string;
  item_type: number;
  acquisition_type: string;
  buy_date: Date | null;
}

export async function getUserInventory(userId: string): Promise<UserItemRow[]> {
  return sql<UserItemRow[]>`
    SELECT item_id, item_type, acquisition_type, buy_date
    FROM   user_items
    WHERE  user_id = ${userId}
      AND  usage_date IS NULL
    ORDER BY buy_date DESC
  `;
}

const SIGNUP_ENERGY = 10;

/**
 * Creates a user + user_numbers (with initial energy) + energy_issuance record
 * in a single transaction. Throws postgres error '23505' on duplicate address/name.
 */
export async function createUser(address: string, name: string): Promise<UserRow> {
  const userId = generateId().toString();
  const issuanceId = generateId().toString();
  const lowerAddress = address.toLowerCase();

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO users (user_id, address, name)
      VALUES (${userId}, ${lowerAddress}, ${name})
    `;
    await tx`
      INSERT INTO user_numbers (user_id, energy)
      VALUES (${userId}, ${SIGNUP_ENERGY})
    `;
    await tx`
      INSERT INTO energy_issuance (energy_issuance_id, user_id, issuance_type, amount)
      VALUES (${issuanceId}, ${userId}, 'signup', ${SIGNUP_ENERGY})
    `;
  });

  // Safe to assert non-null: we just inserted it.
  return (await findUserByAddress(lowerAddress))!;
}

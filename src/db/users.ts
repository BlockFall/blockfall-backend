import { sql } from './index.ts';

// ---------------------------------------------------------------------------
// Row types — mirror the schema exactly.
// postgres.js returns BIGINT columns as strings to preserve precision.
// ---------------------------------------------------------------------------

export type UserRow = {
  user_id: string;
  address: string; // lowercase 0x-prefixed, 40 hex chars
  name: string;
  created_at: Date;
  updated_at: Date | null;
};

export type UserWithNumbersRow = UserRow & {
  best_score: number;
  last_score: number;
  total_score: string; // BIGINT → string
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
      COALESCE(un.best_score,  0)   AS best_score,
      COALESCE(un.last_score,  0)   AS last_score,
      COALESCE(un.total_score, 0)   AS total_score,
      COALESCE(un.energy,      0)   AS energy
    FROM   users        u
    LEFT JOIN user_numbers un ON un.user_id = u.user_id
    WHERE  u.address = ${address.toLowerCase()}
  `;
  return rows[0] ?? null;
}

/**
 * Creates a user + their user_numbers row atomically.
 * Throws a postgres error with code '23505' on duplicate address or name.
 */
export async function createUser(address: string, name: string): Promise<UserRow> {
  const userId = generateId();
  const lowerAddress = address.toLowerCase();

  const id = userId.toString();

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO users (user_id, address, name)
      VALUES (${id}, ${lowerAddress}, ${name})
    `;
    await tx`
      INSERT INTO user_numbers (user_id)
      VALUES (${id})
    `;
  });

  // Safe to assert non-null: we just inserted it.
  return (await findUserByAddress(lowerAddress))!;
}

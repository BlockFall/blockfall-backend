import { dateFromId } from '../utils/index.ts';
import { sql } from './index.ts';

// ---------------------------------------------------------------------------
// Row types — mirror the schema exactly.
// postgres.js returns BIGINT columns as strings to preserve precision.
// ---------------------------------------------------------------------------

export type UserSource = 'mobile-web' | 'web' | 'minipay';

export interface UserRow {
  user_id: string;
  address: string; // lowercase 0x-prefixed, 40 hex chars
  user_source: UserSource;
  wallet_info: string;
  name: string;
  is_banned: boolean;
  created_at: Date; // derived from user_id
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
// Queries
// ---------------------------------------------------------------------------

// Latest mutable data row per user — used by every read that needs name/is_banned.
const LATEST_MUTABLE_JOIN = sql`
  JOIN LATERAL (
    SELECT name, is_banned
    FROM   user_mutable_data
    WHERE  user_id = u.user_id
    ORDER BY user_change_id DESC
    LIMIT 1
  ) umd ON true
`;

function withCreatedAt<T extends { user_id: string }>(row: T): T & { created_at: Date } {
  return { ...row, created_at: dateFromId(row.user_id) };
}

export async function findUserByAddress(address: string): Promise<UserRow | null> {
  const rows = await sql<Omit<UserRow, 'created_at'>[]>`
    SELECT u.user_id, u.address, u.user_source, u.wallet_info, umd.name, umd.is_banned
    FROM   users u
    ${LATEST_MUTABLE_JOIN}
    WHERE  u.address = ${address.toLowerCase()}
  `;
  return rows[0] ? withCreatedAt(rows[0]) : null;
}

export async function findUserByName(name: string): Promise<UserRow | null> {
  const rows = await sql<Omit<UserRow, 'created_at'>[]>`
    SELECT u.user_id, u.address, u.user_source, u.wallet_info, umd.name, umd.is_banned
    FROM   users u
    ${LATEST_MUTABLE_JOIN}
    WHERE  umd.name = ${name}
  `;
  return rows[0] ? withCreatedAt(rows[0]) : null;
}

export async function getUserWithNumbers(address: string): Promise<UserWithNumbersRow | null> {
  const rows = await sql<Omit<UserWithNumbersRow, 'created_at'>[]>`
    SELECT
      u.user_id,
      u.address,
      u.user_source,
      u.wallet_info,
      umd.name,
      umd.is_banned,
      COALESCE(un.best_score,    0) AS best_score,
      COALESCE(un.last_score,    0) AS last_score,
      COALESCE(un.games_played,  0) AS games_played,
      COALESCE(un.total_score,   0) AS total_score,
      COALESCE(ts.today_score,   0) AS today_score,
      COALESCE(un.energy,        0) AS energy
    FROM   users        u
    ${LATEST_MUTABLE_JOIN}
    LEFT JOIN user_numbers un ON un.user_id = u.user_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(gpr.score), 0)::int AS today_score
      FROM   game_plays gp
      JOIN   game_play_results gpr ON gpr.game_play_id = gp.game_play_id
      JOIN   daily_tournaments dt ON dt.daily_tournament_id = gp.daily_tournament_id
      WHERE  gp.user_id = u.user_id
        AND  dt.tournament_date = (now() AT TIME ZONE 'UTC')::date
    ) ts ON true
    WHERE  u.address = ${address.toLowerCase()}
  `;
  return rows[0] ? withCreatedAt(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface UserItemRow {
  item_id: string;
  item_type: number;
  acquisition_type: string;
  acquisition_date: Date;
}

export async function getUserInventory(userId: string): Promise<UserItemRow[]> {
  const rows = await sql<Omit<UserItemRow, 'acquisition_date'>[]>`
    SELECT i.item_id, i.item_type, i.acquisition_type
    FROM   user_items i
    WHERE  i.user_id = ${userId}
      AND  NOT EXISTS (
        SELECT 1 FROM user_item_usages u WHERE u.item_id = i.item_id
      )
    ORDER BY i.item_id DESC
  `;
  return rows.map((r) => ({ ...r, acquisition_date: dateFromId(r.item_id) }));
}

const SIGNUP_ENERGY = 10;

export type CreateUserResult =
  | { success: true; user: UserRow }
  | { success: false; reason: 'name_taken' };

/**
 * Creates a user + initial user_mutable_data + user_numbers (with initial energy)
 * + energy_issuance record in a single transaction. Name uniqueness is checked
 * against the latest user_mutable_data row of every other user, serialized via
 * a transaction-scoped advisory lock keyed on the name. The unique constraint
 * on users.address still throws postgres error '23505' on duplicate address.
 */
export async function createUser(
  address: string,
  name: string,
  userSource: UserSource,
  walletInfo: string
): Promise<CreateUserResult> {
  const lowerAddress = address.toLowerCase();

  const taken = await sql.begin<boolean>(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${name}))`;

    const conflict = await tx`
      SELECT 1
      FROM   users u
      JOIN LATERAL (
        SELECT name
        FROM   user_mutable_data
        WHERE  user_id = u.user_id
        ORDER BY user_change_id DESC
        LIMIT 1
      ) latest ON true
      WHERE  latest.name = ${name}
      LIMIT 1
    `;
    if (conflict.length > 0) {
      return true;
    }

    const userRows = await tx<{ user_id: string }[]>`
      INSERT INTO users (address, user_source, wallet_info)
      VALUES (${lowerAddress}, ${userSource}, ${walletInfo})
      RETURNING user_id
    `;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const userId = userRows[0]!.user_id;

    await tx`
      INSERT INTO user_mutable_data (user_id, name)
      VALUES (${userId}, ${name})
    `;
    await tx`
      INSERT INTO user_numbers (user_id, energy)
      VALUES (${userId}, ${SIGNUP_ENERGY})
    `;
    await tx`
      INSERT INTO energy_issuance (user_id, issuance_type, amount)
      VALUES (${userId}, 'signup', ${SIGNUP_ENERGY})
    `;
    return false;
  });

  if (taken) {
    return { success: false, reason: 'name_taken' };
  }

  // Safe to assert non-null: we just inserted it.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return { success: true, user: (await findUserByAddress(lowerAddress))! };
}

export type RenameResult =
  | { success: true }
  | { success: false; reason: 'name_taken' | 'user_not_found' | 'no_change' };

/**
 * Inserts a new user_mutable_data row with the given name, preserving the
 * latest is_banned flag. Uniqueness is checked against the latest name of
 * every other user inside the same transaction; a transaction-scoped advisory
 * lock keyed on the name serializes concurrent renames to the same target.
 */
export async function renameUser(address: string, newName: string): Promise<RenameResult> {
  const lowerAddress = address.toLowerCase();

  return sql.begin<RenameResult>(async (tx) => {
    // Serialize concurrent renames targeting the same name.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${newName}))`;

    const currentRows = await tx<{ user_id: string; name: string }[]>`
      SELECT u.user_id, umd.name
      FROM   users u
      JOIN LATERAL (
        SELECT name
        FROM   user_mutable_data
        WHERE  user_id = u.user_id
        ORDER BY user_change_id DESC
        LIMIT 1
      ) umd ON true
      WHERE  u.address = ${lowerAddress}
    `;
    if (!currentRows[0]) {
      return { success: false, reason: 'user_not_found' };
    }
    const { user_id: userId, name: currentName } = currentRows[0];

    if (currentName === newName) {
      return { success: false, reason: 'no_change' };
    }

    const conflict = await tx`
      SELECT 1
      FROM   users u
      JOIN LATERAL (
        SELECT name
        FROM   user_mutable_data
        WHERE  user_id = u.user_id
        ORDER BY user_change_id DESC
        LIMIT 1
      ) latest ON true
      WHERE  latest.name = ${newName}
        AND  u.user_id <> ${userId}
      LIMIT 1
    `;
    if (conflict.length > 0) {
      return { success: false, reason: 'name_taken' };
    }

    const latest = await tx<{ is_banned: boolean }[]>`
      SELECT is_banned
      FROM   user_mutable_data
      WHERE  user_id = ${userId}
      ORDER BY user_change_id DESC
      LIMIT 1
    `;
    const isBanned = latest[0]?.is_banned ?? false;

    await tx`
      INSERT INTO user_mutable_data (user_id, name, is_banned)
      VALUES (${userId}, ${newName}, ${isBanned})
    `;

    return { success: true };
  });
}

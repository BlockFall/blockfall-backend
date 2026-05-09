import { createMiddleware } from 'hono/factory';
import { jwtVerify } from 'jose';
import config from '../../config.ts';
import { getCachedBannedUserIds } from '../../db/users.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JwtPayload {
  user_id: string;
  address: string;
  chainId: number;
}

// Augment Hono's Variables map so `c.get('user')` is fully typed downstream.
export interface AuthEnv {
  Variables: {
    user: JwtPayload;
  };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const jwtSecret = new TextEncoder().encode(config.JWT_SECRET);

/**
 * Requires a valid Bearer JWT issued by POST /auth/verify.
 * On success, sets c.var.user = { address, chainId }.
 * On failure, returns 401.
 *
 * Usage:
 *   const protectedRoutes = new Hono<AuthEnv>()
 *     .use(authMiddleware)
 *     .get('/me', (c) => c.json({ address: c.var.user.address }))
 */
export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or malformed Authorization header' }, 401);
  }

  const token = authHeader.slice(7);

  try {
    const { payload } = await jwtVerify<JwtPayload>(token, jwtSecret);
    if (!payload.user_id) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    const banned = await getCachedBannedUserIds();
    if (banned?.has(payload.user_id)) {
      return c.json({ error: 'User is banned' }, 403);
    }
    c.set('user', {
      user_id: payload.user_id,
      address: payload.address,
      chainId: payload.chainId,
    });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  return next();
});

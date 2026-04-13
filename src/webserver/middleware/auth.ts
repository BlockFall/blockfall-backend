import { jwtVerify } from 'jose';
import { createMiddleware } from 'hono/factory';
import config from '../../config.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JwtPayload {
  address: string;
  chainId: number;
}

// Augment Hono's Variables map so `c.get('user')` is fully typed downstream.
export type AuthEnv = {
  Variables: {
    user: JwtPayload;
  };
};

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
    c.set('user', { address: payload.address, chainId: payload.chainId });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  return next();
});

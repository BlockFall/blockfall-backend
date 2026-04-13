import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { SignJWT } from 'jose';
import { SiweMessage, generateNonce } from 'siwe';
import { z } from 'zod';
import config from '../../config.ts';
import { createUser, findUserByAddress, findUserByName } from '../../db/users.ts';

// ---------------------------------------------------------------------------
// Nonce store — one-time use, 5-minute TTL
// ---------------------------------------------------------------------------

const NONCE_TTL_MS = 5 * 60 * 1000;
const nonceStore = new Map<string, number>(); // nonce → expiry timestamp (ms)

setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiry] of nonceStore) {
    if (expiry < now) nonceStore.delete(nonce);
  }
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Shared validation schema for SIWE payloads
// ---------------------------------------------------------------------------

const siweBodySchema = z.object({
  message: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'signature must be 0x-prefixed hex'),
});

const nameSchema = z
  .string()
  .min(3, 'Name must be at least 3 characters')
  .max(50, 'Name must be at most 50 characters')
  .regex(/^[a-zA-Z0-9_]+$/, 'Name may only contain letters, numbers, and underscores');

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

const jwtSecret = new TextEncoder().encode(config.JWT_SECRET);

async function signJwt(address: string, chainId: number): Promise<string> {
  return new SignJWT({ address: address.toLowerCase(), chainId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(jwtSecret);
}

// ---------------------------------------------------------------------------
// Shared SIWE verification helper
// Returns the verified SiweMessage data or a Response to short-circuit with.
// ---------------------------------------------------------------------------

interface VerifySuccess {
  address: string;
  chainId: number;
  nonce: string;
}
interface VerifyError {
  error: string;
  status: 400 | 401;
}

async function verifySiwe(
  message: string,
  signature: string
): Promise<VerifySuccess | VerifyError> {
  let siweMessage: SiweMessage;
  try {
    siweMessage = new SiweMessage(message);
  } catch {
    return { error: 'Malformed SIWE message', status: 400 };
  }

  const nonceExpiry = nonceStore.get(siweMessage.nonce);
  if (nonceExpiry === undefined || nonceExpiry < Date.now()) {
    return { error: 'Invalid or expired nonce', status: 401 };
  }

  if (!config.siweDomains.includes(siweMessage.domain)) {
    return { error: 'Domain not allowed', status: 401 };
  }

  let result: Awaited<ReturnType<SiweMessage['verify']>>;
  try {
    result = await siweMessage.verify({ signature, nonce: siweMessage.nonce });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Verification error', status: 401 };
  }

  if (!result.success) {
    return { error: 'Signature verification failed', status: 401 };
  }

  // Return the nonce so the caller can consume it after their own checks pass
  return {
    address: result.data.address.toLowerCase(),
    chainId: result.data.chainId,
    nonce: siweMessage.nonce,
  };
}

/** Remove the nonce so it cannot be reused. */
function consumeNonce(nonce: string): void {
  nonceStore.delete(nonce);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Auth routes — mount at /auth
 *
 * GET  /auth/nonce        → { nonce: string }
 * POST /auth/verify       → { token: string, address: string }
 * POST /auth/signup       → { token: string, address: string }
 * GET  /auth/checkname    → { available: boolean }
 */
export const authRoutes = new Hono()
  // ------------------------------------------------------------------
  // GET /nonce — fresh one-time nonce for the client to embed in SIWE
  // ------------------------------------------------------------------
  .get('/nonce', (c) => {
    const nonce = generateNonce();
    nonceStore.set(nonce, Date.now() + NONCE_TTL_MS);
    return c.json({ nonce });
  })

  // ------------------------------------------------------------------
  // POST /verify — sign in as an existing registered user
  // ------------------------------------------------------------------
  .post(
    '/verify',
    validator('json', (value, c) => {
      const result = siweBodySchema.safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid request body', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { message, signature } = c.req.valid('json');

      const verified = await verifySiwe(message, signature);
      if ('error' in verified) {
        return c.json({ error: verified.error }, verified.status);
      }

      const user = await findUserByAddress(verified.address);
      if (!user) {
        return c.json({ error: 'Account not found. Please sign up first.' }, 404);
      }

      consumeNonce(verified.nonce);
      const token = await signJwt(verified.address, verified.chainId);
      return c.json({ token, address: verified.address });
    }
  )

  // ------------------------------------------------------------------
  // POST /signup — register a new user
  // ------------------------------------------------------------------
  .post(
    '/signup',
    validator('json', (value, c) => {
      const result = siweBodySchema.extend({ name: nameSchema }).safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid request body', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { message, signature, name } = c.req.valid('json');
      const verified = await verifySiwe(message, signature);
      if ('error' in verified) {
        return c.json({ error: verified.error }, verified.status);
      }

      // Guard: address already registered
      if (await findUserByAddress(verified.address)) {
        return c.json({ error: 'This wallet address is already registered.' }, 409);
      }

      // Guard: name already taken
      if (await findUserByName(name)) {
        return c.json({ error: 'This name is already taken.' }, 409);
      }

      consumeNonce(verified.nonce);
      const user = await createUser(verified.address, name);
      const token = await signJwt(verified.address, verified.chainId);

      return c.json({ token, address: user.address, name: user.name }, 201);
    }
  )

  // ------------------------------------------------------------------
  // GET /checkname?name — check if a name is available before signup
  // ------------------------------------------------------------------
  .get(
    '/checkname',
    validator('query', (value, c) => {
      const result = z.object({ name: nameSchema }).safeParse(value);
      if (!result.success) {
        return c.json({ error: 'Invalid name', details: result.error.issues }, 400);
      }
      return result.data;
    }),
    async (c) => {
      const { name } = c.req.valid('query');
      const existing = await findUserByName(name);
      return c.json({ available: existing === null });
    }
  );

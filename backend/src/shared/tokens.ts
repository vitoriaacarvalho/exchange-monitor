import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { env } from '../config/env.js';
import { unauthorized } from './http-error.js';

const JWT_ALG = 'HS256';

// `jose` wants bytes, and the secret never changes.
const secret = new TextEncoder().encode(env.JWT_SECRET);

const TTL_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * Also the `expiresIn` the login response carries, which is why it's derived
 * from the same string `signAccessToken` signs with instead of being written
 * out twice.
 */
export const ACCESS_TOKEN_TTL_SECONDS =
  Number(env.ACCESS_TOKEN_TTL.slice(0, -1)) * TTL_UNIT_SECONDS[env.ACCESS_TOKEN_TTL.slice(-1)]!;

export function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: JWT_ALG })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

/**
 * Throws `unauthorized` rather than letting `jose`'s own error escape: the
 * error handler renders anything it doesn't recognise as a 500, and a garbage
 * Bearer token is a 401.
 */
export async function verifyAccessToken(token: string): Promise<{ userId: string }> {
  try {
    // Pinning `algorithms` is what stops a token from choosing its own.
    const { payload } = await jwtVerify(token, secret, { algorithms: [JWT_ALG] });

    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new Error('token carries no subject');
    }

    return { userId: payload.sub };
  } catch {
    throw unauthorized('invalid or expired token');
  }
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type RefreshTokenParts = {
  token: string;
  tokenHash: string;
  expiresAt: Date;
};

/**
 * The token is 256 bits of entropy, so sha256 is enough to store it by — there
 * is nothing to brute-force, and argon2's cost would be paid on every refresh.
 *
 * `expiresAt` is a `Date`, but the `refreshToken.expiresAt` column's codec
 * (`pg/timestamptz-temporal@1`) encodes *only* a `Temporal.Instant` — verified
 * by probing. The service converts at the one place it writes the row, which
 * keeps this module usable without `--harmony-temporal`.
 */
export function generateRefreshToken(): RefreshTokenParts {
  const token = randomBytes(32).toString('base64url');

  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
  };
}

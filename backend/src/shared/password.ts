import argon2 from 'argon2';

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // A malformed hash means the row is corrupt, which is a failed login for
    // that one user — not a 500 for everyone.
    return false;
  }
}

/**
 * Verified against when the email is unknown, so that path costs the same
 * ~100ms as a wrong password. Without it, "does this email exist" is readable
 * off a stopwatch and the identical 401 bodies buy nothing.
 *
 * Hashed once at import rather than per request: the point is to spend argon2's
 * cost on the failing path, not to spend it twice.
 */
export const DUMMY_PASSWORD_HASH = await argon2.hash('unknown email, same cost as a wrong one');

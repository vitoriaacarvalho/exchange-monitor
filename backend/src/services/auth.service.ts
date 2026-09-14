import type { Prisma } from '../generated/prisma/client.ts';
import { toUserResponse, type UserResponse } from '../mappers/user.mapper.js';
import { prisma } from '../prisma/db.js';
import type { LoginInput, RegisterInput } from '../schemas/auth.schema.js';
import { unauthorized } from '../shared/http-error.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../shared/password.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from '../shared/tokens.js';

/**
 * `refreshToken` is a plain string here, and stays one. Only the controller
 * knows it becomes a cookie — which is what makes a future mobile client, which
 * wants it in the body, a controller change and nothing more.
 */
export type Session = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export type AuthResult = Session & { user: UserResponse };

/** Register, login and refresh all end here, so the three cannot drift apart. */
async function issueSession(
  userId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<Session> {
  const { token, tokenHash, expiresAt } = generateRefreshToken();

  await client.refreshToken.create({ data: { tokenHash, expiresAt, userId } });

  return {
    accessToken: await signAccessToken(userId),
    refreshToken: token,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  // A duplicate email surfaces as P2002 on `user_email_key`, which the error
  // handler already renders as a 409. Catching it here would duplicate that.
  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      ...(input.phoneNumber !== undefined && { phoneNumber: input.phoneNumber }),
    },
  });

  return { user: toUserResponse(user), ...(await issueSession(user.id)) };
}

export async function login({ email, password }: LoginInput): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email } });

  // Verified even when the email is unknown, so both failures cost the same
  // ~140ms. Identical 401 bodies are worth nothing if a stopwatch separates them.
  const passwordMatches = await verifyPassword(user?.passwordHash ?? DUMMY_PASSWORD_HASH, password);

  if (!user || !passwordMatches) {
    throw unauthorized('invalid credentials');
  }

  return { user: toUserResponse(user), ...(await issueSession(user.id)) };
}

export async function refresh(token: string): Promise<Session> {
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(token) },
  });

  if (!row) {
    throw unauthorized('invalid refresh token');
  }

  if (row.revokedAt) {
    // Replay of a rotated token means the old value leaked, and whoever holds
    // the current one may not be the legitimate user — so end every session,
    // not just this one.
    //
    // Revoked outside a transaction on purpose: this branch throws, and a
    // rollback would undo the revocation it exists to perform.
    await prisma.refreshToken.updateMany({
      where: { userId: row.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    throw unauthorized('invalid refresh token');
  }

  if (row.expiresAt <= new Date()) {
    throw unauthorized('invalid refresh token');
  }

  // Rotation is atomic: failing between revoking the old row and inserting the
  // new one would leave the caller holding neither.
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Lost a race with a concurrent refresh presenting the same token.
    if (count === 0) {
      throw unauthorized('invalid refresh token');
    }

    return issueSession(row.userId, tx);
  });
}

/** Idempotent by contract: an unknown or absent token still logs you out. */
export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;

  // `updateMany` rather than `update`: no row is the expected case, and `update`
  // would answer it with P2025 — a 404 on a logout.
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getMe(userId: string): Promise<UserResponse> {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  // The token's signature already proved this id, so a missing row means the
  // account was deleted while the token was still inside its 15 minutes.
  if (!user) {
    throw unauthorized('account no longer exists');
  }

  return toUserResponse(user);
}

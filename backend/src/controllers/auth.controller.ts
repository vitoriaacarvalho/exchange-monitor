import type { RequestHandler } from 'express';
import { requireUserId } from '../middlewares/require-auth.js';
import * as authService from '../services/auth.service.js';
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from '../shared/cookies.js';
import { unauthorized } from '../shared/http-error.js';

/**
 * The only file that knows the refresh token travels as a cookie. It never
 * appears in a response body — that is the whole point of the httpOnly
 * transport. `expiresIn` stays, because it describes the *access* token and the
 * SPA needs it to know when to refresh.
 */

function readRefreshCookie(req: Parameters<RequestHandler>[0]): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
}

export const register: RequestHandler = async (req, res) => {
  const { refreshToken, ...body } = await authService.register(req.body);

  setRefreshCookie(res, refreshToken);
  res.status(201).json(body);
};

export const login: RequestHandler = async (req, res) => {
  const { refreshToken, ...body } = await authService.login(req.body);

  setRefreshCookie(res, refreshToken);
  res.status(200).json(body);
};

export const refresh: RequestHandler = async (req, res) => {
  const presented = readRefreshCookie(req);

  // No Zod schema for this: there is nothing to validate beyond presence, and a
  // Zod failure would answer a missing credential with 422 where the honest
  // answer is 401.
  if (!presented) {
    throw unauthorized('missing refresh token');
  }

  const { refreshToken, accessToken, expiresIn } = await authService.refresh(presented);

  setRefreshCookie(res, refreshToken);
  res.status(200).json({ accessToken, expiresIn });
};

export const logout: RequestHandler = async (req, res) => {
  await authService.logout(readRefreshCookie(req));

  clearRefreshCookie(res);
  res.status(204).end();
};

export const me: RequestHandler = async (req, res) => {
  res.status(200).json({ user: await authService.getMe(requireUserId(req)) });
};

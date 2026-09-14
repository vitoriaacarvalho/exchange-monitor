import type { CookieOptions, Response } from 'express';
import { env } from '../config/env.js';

export const REFRESH_COOKIE = 'refreshToken';

/**
 * This module exists so these attributes are written once. `res.clearCookie`
 * only clears a cookie when `path`, `sameSite` and `secure` match what was set;
 * let them drift and logout returns 204 while the browser keeps a working
 * refresh cookie — a logout that lies.
 *
 * `path: '/auth'` keeps the cookie off every `/alerts` request. `sameSite:
 * 'strict'` is the entire CSRF story, and it holds only while the frontend is
 * same-site with the API; moving the SPA to a different registrable domain is a
 * security change, not a hosting change.
 */
const REFRESH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/auth',
};

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
}

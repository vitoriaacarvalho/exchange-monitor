import type { Request, RequestHandler } from 'express';
import { unauthorized } from '../shared/http-error.js';
import { verifyAccessToken } from '../shared/tokens.js';

const BEARER = /^Bearer (\S+)$/;

/**
 * Express 5 forwards a rejected promise to the error handler, so
 * `verifyAccessToken` throwing its own 401 is enough.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const match = BEARER.exec(req.get('authorization') ?? '');

  if (!match) {
    next(unauthorized('missing or malformed Authorization header'));
    return;
  }

  // No database lookup: the signature already proves the id, and an access
  // token lives 15 minutes, so a SELECT per request buys almost nothing.
  const { userId } = await verifyAccessToken(match[1]!);

  req.userId = userId;
  next();
};

/**
 * Throws rather than returning undefined, so mounting a controller without
 * `requireAuth` fails as a 401 instead of querying with `undefined`.
 */
export function requireUserId(req: Request): string {
  if (!req.userId) {
    throw unauthorized();
  }

  return req.userId;
}

import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { unauthorized } from '../shared/http-error.js';

/**
 * Identifies the caller from an `x-user-id` header.
 *
 * This is a stopgap, not authentication — anyone can send any id. It exists so
 * the alert endpoints can be built against a real `userId` before
 * `docs/auth-plan.md` lands, at which point only this file changes: everything
 * downstream reads `req.userId`.
 */
const USER_ID_HEADER = 'x-user-id';

const userIdSchema = z.uuid();

export const currentUser: RequestHandler = (req, _res, next) => {
  const header = req.get(USER_ID_HEADER)?.trim();

  if (!header) {
    next(unauthorized(`missing ${USER_ID_HEADER} header`));
    return;
  }

  // A non-uuid would otherwise reach Postgres as a cast error or an FK
  // violation. A bad credential is a 401, not a 422.
  if (!userIdSchema.safeParse(header).success) {
    next(unauthorized(`malformed ${USER_ID_HEADER} header`));
    return;
  }

  req.userId = header;
  next();
};

/**
 * Throws rather than returning undefined, so mounting a controller without
 * `currentUser` fails as a 401 instead of querying with `undefined`.
 */
export function requireUserId(req: Request): string {
  if (!req.userId) {
    throw unauthorized(`missing ${USER_ID_HEADER} header`);
  }

  return req.userId;
}

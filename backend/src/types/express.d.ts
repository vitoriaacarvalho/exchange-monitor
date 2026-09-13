import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Set by the `currentUser` middleware. Read it through `requireUserId(req)`. */
      userId?: string;
    }

    interface Locals {
      /** Written by `validate({ query })` because Express 5's `req.query` has no setter. */
      query?: unknown;
    }
  }
}

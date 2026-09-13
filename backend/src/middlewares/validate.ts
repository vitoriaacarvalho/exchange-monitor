import type { RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

export type ValidationSchemas = {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
};

/**
 * Parses the request against the given schemas and replaces the raw input with
 * the parsed result, so handlers see trimmed and coerced values. A failure
 * throws a `ZodError`, which the error handler renders as a 422.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, res, next) => {
    // Params first: a malformed id is the more useful complaint.
    if (schemas.params) {
      req.params = schemas.params.parse(req.params) as typeof req.params;
    }

    if (schemas.body) {
      req.body = schemas.body.parse(req.body);
    }

    if (schemas.query) {
      // Express 5 defines `req.query` as a getter with no setter, so assigning
      // to it throws under ESM's strict mode.
      res.locals.query = schemas.query.parse(req.query);
    }

    next();
  };
}

/** Sound only on a route that ran `validate({ query })`. Call it with the schema's inferred type. */
export function validatedQuery<T>(res: Response): T {
  return res.locals.query as T;
}

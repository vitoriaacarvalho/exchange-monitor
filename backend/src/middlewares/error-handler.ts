import type { ErrorRequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { env } from '../config/env.js';
import { conflict, HttpError, unprocessable } from '../shared/http-error.js';

/**
 * The terminal error middleware. Every response it writes has the shape
 * `{ error: { message, details? } }`.
 */

/**
 * Matched structurally rather than with `instanceof`: the driver's
 * `SqlQueryError` lives in `@prisma/orm-family-sql`, a transitive dependency,
 * so importing it would pin us to the package layout of a release candidate.
 * The runtime's own `SqlQueryError.is()` is this same `kind` check.
 */
type SqlQueryErrorLike = {
  kind: 'sql_query';
  sqlState?: string;
  constraint?: string;
  table?: string;
  column?: string;
  detail?: string;
};

function isSqlQueryError(error: unknown): error is SqlQueryErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { kind?: unknown }).kind === 'sql_query'
  );
}

/** The ORM's middleware wraps driver errors, so the one we want is rarely the one we're handed. */
function findSqlQueryError(error: unknown, depth = 0): SqlQueryErrorLike | undefined {
  if (depth > 5 || typeof error !== 'object' || error === null) return undefined;
  if (isSqlQueryError(error)) return error;
  return findSqlQueryError((error as { cause?: unknown }).cause, depth + 1);
}

/**
 * Constraint names as Postgres actually stores them, which is not what
 * `contract.prisma` calls them: the emitter appends an 8-hex suffix, and the
 * `notification_` prefix is a fossil of the rename to `Alert`. Verified
 * against the live database. Stripping the suffix survives a re-emit.
 */
const CONSTRAINT_HASH_SUFFIX = /_[0-9a-f]{8}$/;

const CONSTRAINT_RULES: Record<string, () => HttpError> = {
  notification_user_alert_active: () =>
    conflict('an active alert for this pair, direction and target rate already exists'),
  notification_rate_positive: () => unprocessable('targetRate must be greater than zero'),
  notification_pair_distinct: () =>
    unprocessable('baseCurrency and quoteCurrency must be different'),
};

const SQLSTATE_RULES: Record<string, () => HttpError> = {
  '23505': () => conflict('a record with these values already exists'),
  '23503': () => unprocessable('a referenced record does not exist'),
  '23514': () => unprocessable('a value in the request violates a database constraint'),
  '23502': () => unprocessable('a required value is missing'),
};

function translateSqlError(error: SqlQueryErrorLike): HttpError | undefined {
  const baseName = error.constraint?.replace(CONSTRAINT_HASH_SUFFIX, '');
  const rule = (baseName && CONSTRAINT_RULES[baseName]) ?? SQLSTATE_RULES[error.sqlState ?? ''];

  if (!rule) return undefined;

  // A check constraint reaching Postgres means a Zod schema failed to mirror it.
  if (error.sqlState === '23514') {
    console.warn('[error-handler] check constraint reached the database', {
      constraint: error.constraint,
      table: error.table,
    });
  }

  return rule();
}

/** `express.json()` rejects malformed or oversized payloads with `status` and `expose: true`. */
function translateExposedHttpError(error: unknown): HttpError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const { status, statusCode, expose, message } = error as {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
    message?: unknown;
  };

  const code = typeof status === 'number' ? status : statusCode;

  if (expose !== true || typeof code !== 'number' || code < 400 || code > 499) {
    return undefined;
  }

  return new HttpError(code, typeof message === 'string' ? message : 'bad request');
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  // Nothing left to change once the status line is flushed; Express's default
  // handler closes the connection.
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.statusCode).json({
      error: {
        message: error.message,
        ...(error.details !== undefined && { details: error.details }),
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    const { formErrors, fieldErrors } = z.flattenError(error);
    res.status(422).json({
      error: { message: 'validation failed', details: { formErrors, fieldErrors } },
    });
    return;
  }

  const sqlError = findSqlQueryError(error);
  if (sqlError) {
    const translated = translateSqlError(sqlError);

    if (translated) {
      // `detail` is logged but never forwarded: Postgres puts the offending key
      // — or the whole failing row, including other users' values — in it.
      console.warn('[error-handler] constraint violation', {
        sqlState: sqlError.sqlState,
        constraint: sqlError.constraint,
        table: sqlError.table,
        detail: sqlError.detail,
      });

      res.status(translated.statusCode).json({ error: { message: translated.message } });
      return;
    }
  }

  const exposed = translateExposedHttpError(error);
  if (exposed) {
    res.status(exposed.statusCode).json({ error: { message: exposed.message } });
    return;
  }

  console.error('[error-handler] unhandled error', error);

  res.status(500).json({
    error: {
      message: 'internal server error',
      ...(env.NODE_ENV === 'development' &&
        error instanceof Error && { details: { name: error.name, message: error.message } }),
    },
  });
};

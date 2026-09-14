import type { ErrorRequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { env } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.ts';
import { conflict, HttpError, notFound, unprocessable } from '../shared/http-error.js';

/**
 * The terminal error middleware. Every response it writes has the shape
 * `{ error: { message, details? } }`.
 */

/**
 * Prisma 7 puts the driver's own error under `meta.driverAdapterError`. Only
 * unique (`P2002`) and foreign-key (`P2003`) violations carry the constraint
 * name structurally — verified by probing; for a check constraint it is in the
 * message text alone.
 */
type PrismaDriverCause = {
  constraint?: { index?: string };
  originalMessage?: string;
  detail?: string;
};

function driverCause(error: Prisma.PrismaClientKnownRequestError): PrismaDriverCause {
  return (
    (error.meta as { driverAdapterError?: { cause?: PrismaDriverCause } } | undefined)
      ?.driverAdapterError?.cause ?? {}
  );
}

const UNIQUE_CONSTRAINT_RULES: Record<string, () => HttpError> = {
  alert_user_alert_active_5b2336d6: () =>
    conflict('an active alert for this pair, direction and target rate already exists'),
  user_email_key: () => conflict('an account with this email already exists'),
};

function translatePrismaError(error: Prisma.PrismaClientKnownRequestError): HttpError | undefined {
  const { constraint } = driverCause(error);

  switch (error.code) {
    case 'P2002': {
      const rule = constraint?.index && UNIQUE_CONSTRAINT_RULES[constraint.index];
      return rule ? rule() : conflict('a record with these values already exists');
    }
    case 'P2003':
      return unprocessable('a referenced record does not exist');

    // Deliberately generic: a check constraint reaching Postgres means a Zod
    // schema failed to mirror it, so the specific wording belongs at the edge,
    // not here. The constraint name is only in the message text (verified) and
    // is not worth a regex.
    case 'P2039':
      console.warn('[error-handler] check constraint reached the database');
      return unprocessable('a value in the request violates a database constraint');

    case 'P2025':
      return notFound();

    default:
      return undefined;
  }
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

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const translated = translatePrismaError(error);

    if (translated) {
      const cause = driverCause(error);

      // `detail` is logged but never forwarded: Postgres puts the offending key
      // — or the whole failing row, including other users' values — in it.
      console.warn('[error-handler] prisma constraint violation', {
        code: error.code,
        constraint: cause.constraint?.index,
        originalMessage: cause.originalMessage,
        detail: cause.detail,
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

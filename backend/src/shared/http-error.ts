/**
 * Errors services throw instead of touching `res`. Rendered in exactly one
 * place: `src/middlewares/error-handler.ts`.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;

    if (details !== undefined) {
      this.details = details;
    }

    Error.captureStackTrace?.(this, HttpError);
  }
}

export const badRequest = (message = 'bad request', details?: unknown): HttpError =>
  new HttpError(400, message, details);

export const unauthorized = (message = 'unauthorized', details?: unknown): HttpError =>
  new HttpError(401, message, details);

/** Also the right answer for a record owned by someone else — 403 would confirm the id is real. */
export const notFound = (message = 'not found', details?: unknown): HttpError =>
  new HttpError(404, message, details);

export const conflict = (message = 'conflict', details?: unknown): HttpError =>
  new HttpError(409, message, details);

export const unprocessable = (message = 'unprocessable entity', details?: unknown): HttpError =>
  new HttpError(422, message, details);

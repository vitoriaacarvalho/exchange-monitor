import rateLimit from 'express-rate-limit';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

const message = { error: { message: 'too many requests, try again later' } };

/**
 * Without this, argon2's cost is pointless: rather than crack a stolen hash
 * offline, an attacker just tries passwords against the endpoint.
 */
export const credentialsLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message,
});

/** Looser: a refresh is one sha256 and an indexed lookup, and a tight limit
 *  would log out anyone browsing with several tabs open. */
export const refreshLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message,
});

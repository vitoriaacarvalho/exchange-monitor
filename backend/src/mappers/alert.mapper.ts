import type { Direction } from '../generated/prisma/enums.ts';
import type { AlertModel } from '../generated/prisma/models.ts';

export type AlertResponse = {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  targetRate: string;
  direction: Direction;
  isActive: boolean;
  triggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * `userId` never appears here: the token already implies it. Built field by
 * field for the same reason `toUserResponse` is — a spread leaks every column
 * added to the model later.
 *
 * `targetRate` is a `Decimal` object, and `.toFixed()` is not interchangeable
 * with `.toString()`: a rate of `0.00000001` stringifies to `"1e-8"`, and an
 * exchange rate in exponential notation reaches the frontend intact.
 */
export function toAlertResponse(alert: AlertModel): AlertResponse {
  return {
    id: alert.id,
    baseCurrency: alert.baseCurrency,
    quoteCurrency: alert.quoteCurrency,
    targetRate: alert.targetRate.toFixed(),
    direction: alert.direction,
    isActive: alert.isActive,
    triggeredAt: alert.triggeredAt?.toISOString() ?? null,
    createdAt: alert.createdAt.toISOString(),
    updatedAt: alert.updatedAt.toISOString(),
  };
}

import type { AlertModel, AlertWhereInput } from '../generated/prisma/models.ts';
import { prisma } from '../prisma/db.js';
import type {
  CreateAlertInput,
  ListAlertsQuery,
  UpdateAlertInput,
} from '../schemas/alert.schema.js';
import { notFound } from '../shared/http-error.js';

/**
 * Every function takes `userId` first and puts it in the `where`, so a query
 * cannot accidentally reach another account's rows. `update` and `delete` accept
 * that non-unique filter alongside the unique `id`: they return the row and
 * throw `P2025` when the pair matches nothing, which the error handler renders
 * as a 404. Answering with 403 instead would confirm the id names a real alert.
 */

export type AlertPage = {
  data: AlertModel[];
  nextCursor: string | null;
};

function alertFilters(userId: string, query: ListAlertsQuery): AlertWhereInput {
  const { isActive, baseCurrency, quoteCurrency, direction, triggered } = query;

  return {
    userId,
    ...(isActive !== undefined && { isActive }),
    ...(baseCurrency !== undefined && { baseCurrency }),
    ...(quoteCurrency !== undefined && { quoteCurrency }),
    ...(direction !== undefined && { direction }),
    ...(triggered !== undefined && { triggeredAt: triggered ? { not: null } : null }),
  };
}

export async function createAlert(userId: string, input: CreateAlertInput): Promise<AlertModel> {
  // A duplicate active alert surfaces as P2002 on
  // `alert_user_alert_active_5b2336d6`, which the error handler already renders
  // as a 409 naming the pair, direction and rate.
  return prisma.alert.create({ data: { ...input, userId } });
}

export async function listAlerts(userId: string, query: ListAlertsQuery): Promise<AlertPage> {
  const { limit, cursor } = query;

  const rows = await prisma.alert.findMany({
    where: alertFilters(userId, query),
    // `id` breaks ties: two alerts created in the same millisecond would
    // otherwise have no stable order, and a cursor into an unstable order skips
    // or repeats rows between pages.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // One row past the page, purely to learn whether another page exists.
    take: limit + 1,
    // `skip: 1` steps over the cursor row itself, which the previous page
    // already returned.
    ...(cursor !== undefined && { cursor: { id: cursor }, skip: 1 }),
  });

  const data = rows.slice(0, limit);

  return {
    data,
    nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null,
  };
}

export async function getAlertById(userId: string, id: string): Promise<AlertModel> {
  const alert = await prisma.alert.findFirst({ where: { id, userId } });

  // The only read that has to throw for itself: `findFirst` answers a miss with
  // `null`, where `update` and `delete` throw `P2025`.
  if (!alert) {
    throw notFound('alert not found');
  }

  return alert;
}

export async function updateAlert(
  userId: string,
  id: string,
  input: UpdateAlertInput,
): Promise<AlertModel> {
  return prisma.alert.update({ where: { id, userId }, data: input });
}

export async function deleteAlert(userId: string, id: string): Promise<void> {
  await prisma.alert.delete({ where: { id, userId } });
}

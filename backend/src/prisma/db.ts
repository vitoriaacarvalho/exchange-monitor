import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';
import { env } from '../config/env.js';

/**
 * The `.ts` extension is what the generated client's own imports use; the build
 * rewrites it to `.js` (`rewriteRelativeImportExtensions` in tsconfig).
 *
 * Prisma 7 takes the connection through a driver adapter rather than a `url` in
 * the schema, which is no longer permitted there.
 */
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

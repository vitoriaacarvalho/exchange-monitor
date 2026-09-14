-- AlterEnum
-- Renamed in place rather than dropped and re-added: `ALTER TYPE ... RENAME
-- VALUE` rewrites the label without touching the rows that reference it, which
-- the add-new/backfill/drop-old sequence would require a separate transaction to
-- do (Postgres refuses to use a new enum value in the same transaction that
-- added it).
ALTER TYPE "Direction" RENAME VALUE 'BELLOW' TO 'BELOW';

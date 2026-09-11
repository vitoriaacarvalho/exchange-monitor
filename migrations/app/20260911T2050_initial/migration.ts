#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/17695e0486fc67932929ce2647eac75add6ddf4ee16f53c924ca0b3b7b5e6e8b/contract';
import endContract from '../../snapshots/17695e0486fc67932929ce2647eac75add6ddf4ee16f53c924ca0b3b7b5e6e8b/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'test',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

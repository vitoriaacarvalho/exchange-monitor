#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/0f21ee5e6ad83f27e4731f21e31958945f6698bb32df8092de2fae78ef8c14b0/contract';
import startContract from '../../snapshots/0f21ee5e6ad83f27e4731f21e31958945f6698bb32df8092de2fae78ef8c14b0/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/3ff272a1be553f2f1f888a8b58dfad087630d3ad09c6a0ceb5798173b345e91b/contract';
import endContract from '../../snapshots/3ff272a1be553f2f1f888a8b58dfad087630d3ad09c6a0ceb5798173b345e91b/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'refreshToken',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('expiresAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('revokedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('tokenHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'refreshToken',
        constraint: 'refreshToken_tokenHash_key',
        columns: ['tokenHash'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refreshToken',
        index: 'refreshToken_expiresAt_idx_6b6b8c10',
        columns: ['expiresAt'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'refreshToken',
        index: 'refreshToken_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'refreshToken',
        foreignKey: {
          name: 'refreshToken_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.renameIndex({
        schema: 'public',
        table: 'alert',
        from: 'notification_pair_active_331cc7d1',
        to: 'alert_pair_active_331cc7d1',
      }),
      this.renameIndex({
        schema: 'public',
        table: 'alert',
        from: 'notification_user_alert_active_5b2336d6',
        to: 'alert_user_alert_active_5b2336d6',
      }),
      this.renameCheckConstraint({
        schema: 'public',
        table: 'alert',
        from: 'notification_pair_distinct_e7f2bcc4',
        to: 'alert_pair_distinct_e7f2bcc4',
      }),
      this.renameCheckConstraint({
        schema: 'public',
        table: 'alert',
        from: 'notification_rate_positive_71f5f09d',
        to: 'alert_rate_positive_71f5f09d',
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/0f21ee5e6ad83f27e4731f21e31958945f6698bb32df8092de2fae78ef8c14b0/contract';
import endContract from '../../snapshots/0f21ee5e6ad83f27e4731f21e31958945f6698bb32df8092de2fae78ef8c14b0/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/472a0786478e2932424ff3b2a98e693de05bc440847282faf08419ead70f376f/contract';
import startContract from '../../snapshots/472a0786478e2932424ff3b2a98e693de05bc440847282faf08419ead70f376f/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropTable({ schema: 'public', table: 'notification' }),
      this.createTable({
        schema: 'public',
        table: 'alert',
        columns: [
          col('baseCurrency', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('direction', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('isActive', 'bool', {
            notNull: true,
            default: lit(true),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('quoteCurrency', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('targetRate', 'numeric', { notNull: true, codecRef: { codecId: 'pg/numeric@1' } }),
          col('triggeredAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('alert_direction_check_134ec2b3', "\"direction\" IN ('ABOVE', 'BELOW')"),
          checkExpression(
            'notification_pair_distinct_e7f2bcc4',
            '"baseCurrency" <> "quoteCurrency"',
          ),
          checkExpression('notification_rate_positive_71f5f09d', '"targetRate" > 0'),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'alert',
        index: 'alert_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'alert',
        index: 'notification_pair_active_331cc7d1',
        columns: ['baseCurrency', 'quoteCurrency'],
        extras: { where: '("isActive" = true)' },
      }),
      this.createIndex({
        schema: 'public',
        table: 'alert',
        index: 'notification_user_alert_active_5b2336d6',
        columns: ['userId', 'baseCurrency', 'quoteCurrency', 'direction', 'targetRate'],
        extras: { where: '("isActive" = true)', unique: true },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'alert',
        foreignKey: {
          name: 'alert_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);

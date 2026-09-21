/**
 * 開発プラン 9.6 のデータモデルと、スキーマの対応。
 *
 * **「概略に書いてあるのに、作り忘れた」を落とすためのテストである。**
 * 対応表（`mapping.ts`）は宣言で、ここはその突き合わせにすぎない。
 */

import { describe, expect, it } from 'vitest';
import { ADDED_TABLES, ALL_TABLES, MAPPING, columnNames, isLater, mappedColumns } from './mapping.js';

/** 開発プラン 9.6 の表が挙げているテーブル。**写し間違いはここで落ちる。** */
const TABLES_IN_PLAN: readonly string[] = [
  'venues',
  'zones',
  'tables',
  'tickets',
  'events',
  'notification_channels',
  'settings_versions',
  'floor_layouts',
  'users',
  'memberships',
  'sessions',
  'audit_log',
];

const mapped = Object.entries(MAPPING);
const present = mapped.filter(([, entry]) => !isLater(entry.schema));

describe('9.6 のデータモデルとスキーマ', () => {
  it('9.6 が挙げる表が、漏れなく対応表にある', () => {
    expect(Object.keys(MAPPING).toSorted()).toEqual(TABLES_IN_PLAN.toSorted());
  });

  it.each(present)('%s の列が、実在する列に対応している', (_name, entry) => {
    if (isLater(entry.schema)) throw new Error('絞り込めていない');
    const actual = columnNames(entry.schema);
    expect(mappedColumns(entry).filter((to) => !actual.includes(to))).toEqual([]);
  });

  it.each(present)('%s が実際に持つ列が、すべて説明されている', (_name, entry) => {
    if (isLater(entry.schema)) throw new Error('絞り込めていない');
    const accounted = [...mappedColumns(entry), ...Object.keys(entry.added ?? {})];
    const unexplained = columnNames(entry.schema).filter((name) => !accounted.includes(name));
    expect(unexplained).toEqual([]);
  });

  it('9.6 に無い表には、足した理由がある', () => {
    const fromPlan = present.map(([, entry]) => entry.schema);
    const unexplained = ALL_TABLES.filter(
      (table) => !fromPlan.includes(table) && !ADDED_TABLES.has(table),
    );
    expect(unexplained).toEqual([]);
  });

  it('足した理由が、名ばかりでない', () => {
    const reasons = [
      ...mapped.flatMap(([, entry]) => Object.values(entry.added ?? {})),
      ...ADDED_TABLES.values(),
    ];
    expect(reasons.filter((reason) => reason.trim().length < 10)).toEqual([]);
  });
});

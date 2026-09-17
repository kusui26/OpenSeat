import { describe, expect, it } from 'vitest';
import type { Timestamp } from '../time.js';
import {
  TABLE_STATUSES,
  TAKEN_TABLE_STATUSES,
  createTable,
  fitsCapacity,
  isTaken,
  satisfiesTags,
  type Table,
  type TableStatus,
} from './table.js';

const NOW: Timestamp = 1_700_000_000_000;

function tableWith(overrides: Partial<Table>): Table {
  return {
    ...createTable({ id: 'tb1', label: 'T-01', capacity: 4, now: NOW }),
    ...overrides,
  };
}

describe('テーブルの状態（全体プラン 7.4）', () => {
  it('状態は 7 種類', () => {
    expect(TABLE_STATUSES).toEqual([
      'DISABLED',
      'FREE',
      'HELD',
      'OCCUPIED',
      'OCCUPIED_UNKNOWN',
      'TURNOVER',
      'NEEDS_CHECK',
    ]);
  });

  it('使われている状態は 3 種類', () => {
    expect(TAKEN_TABLE_STATUSES).toEqual(['HELD', 'OCCUPIED', 'OCCUPIED_UNKNOWN']);
  });

  it.each(TAKEN_TABLE_STATUSES)('%s は使われている', (status) => {
    expect(isTaken(status)).toBe(true);
  });

  it('FREE は使われていない', () => {
    expect(isTaken('FREE')).toBe(false);
  });

  it('NEEDS_CHECK は使われていない扱い（たぶん空いている席なので）', () => {
    expect(isTaken('NEEDS_CHECK')).toBe(false);
  });

  it('TURNOVER は使われていない扱い（片付け中で、まもなく空く）', () => {
    expect(isTaken('TURNOVER')).toBe(false);
  });

  it('DISABLED は使われていない扱い（そもそも管理対象外）', () => {
    expect(isTaken('DISABLED')).toBe(false);
  });

  it.each(TABLE_STATUSES)('%s は isTaken が真偽どちらかに定まる', (status: TableStatus) => {
    expect(typeof isTaken(status)).toBe('boolean');
  });

  it('isTaken が真になる状態の集合は TAKEN_TABLE_STATUSES と一致する', () => {
    const taken = TABLE_STATUSES.filter((status) => isTaken(status));
    expect([...taken].sort()).toEqual([...TAKEN_TABLE_STATUSES].sort());
  });
});

describe('createTable', () => {
  it('運用が始まるまでは DISABLED', () => {
    expect(createTable({ id: 'tb1', label: 'T-01', capacity: 4, now: NOW }).status).toBe('DISABLED');
  });

  it('既定では対象席として作られる', () => {
    expect(createTable({ id: 'tb1', label: 'T-01', capacity: 4, now: NOW }).enabled).toBe(true);
  });

  it('対象外の席も作れる', () => {
    const table = createTable({ id: 'tb1', label: 'T-01', capacity: 4, now: NOW, enabled: false });
    expect(table.enabled).toBe(false);
  });

  it('退席の確認はまだ無い', () => {
    expect(createTable({ id: 'tb1', label: 'T-01', capacity: 4, now: NOW }).verifiedFreeAt).toBeNull();
  });

  it('タグと処理順は省略できる', () => {
    const table = createTable({ id: 'tb1', label: 'T-01', capacity: 4, now: NOW });
    expect(table.tags).toEqual([]);
    expect(table.adminRank).toBe(0);
  });
});

describe('fitsCapacity（人数が定員に収まるか）', () => {
  const table = tableWith({ capacity: 4 });

  it('定員ちょうどは収まる', () => {
    expect(fitsCapacity(table, 4)).toBe(true);
  });

  it('定員を 1 人でも超えたら収まらない', () => {
    expect(fitsCapacity(table, 5)).toBe(false);
  });

  it('1 名は収まる', () => {
    expect(fitsCapacity(table, 1)).toBe(true);
  });

  it('0 名は収まらない', () => {
    expect(fitsCapacity(table, 0)).toBe(false);
  });

  it('負の人数は収まらない', () => {
    expect(fitsCapacity(table, -1)).toBe(false);
  });

  it('定員 1 のカウンター席には 1 名だけ収まる', () => {
    const counter = tableWith({ capacity: 1 });
    expect(fitsCapacity(counter, 1)).toBe(true);
    expect(fitsCapacity(counter, 2)).toBe(false);
  });
});

describe('satisfiesTags（希望タグを満たすか）', () => {
  it('希望が空なら、どの席でも満たす', () => {
    expect(satisfiesTags(tableWith({ tags: [] }), [])).toBe(true);
    expect(satisfiesTags(tableWith({ tags: ['power'] }), [])).toBe(true);
  });

  it('席が希望をすべて持っていれば満たす', () => {
    const table = tableWith({ tags: ['wheelchair', 'power', 'window'] });
    expect(satisfiesTags(table, ['wheelchair', 'power'])).toBe(true);
  });

  it('席が希望を 1 つでも欠いていれば満たさない', () => {
    const table = tableWith({ tags: ['wheelchair'] });
    expect(satisfiesTags(table, ['wheelchair', 'power'])).toBe(false);
  });

  it('席が余分なタグを持っていても構わない', () => {
    const table = tableWith({ tags: ['wheelchair', 'power'] });
    expect(satisfiesTags(table, ['wheelchair'])).toBe(true);
  });

  it('タグを持たない席は、希望があれば満たさない', () => {
    expect(satisfiesTags(tableWith({ tags: [] }), ['wheelchair'])).toBe(false);
  });
});

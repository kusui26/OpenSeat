import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import { createTicket, type Ticket } from '../domain/ticket.js';
import { createVenueState, type VenueState } from '../domain/state.js';
import { minutes, type Timestamp } from '../time.js';
import { guidedTo, suggestNeedsCheck, uncertainTables, type Suggestion } from './needs-check.js';

/**
 * 確認要の席の案内（全体プラン 7.11 の 3 層目）。
 *
 * ここで確かめるのは **誰にどの席を見に行ってもらうか** だけである。行った先で
 * 何が起きるか（座る／使用中だった）は `machine/recovery.test.ts` が見る。
 */

const NOW: Timestamp = 1_700_000_000_000;

function tableAt(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), ...overrides };
}

/** 空いている可能性が高い席。 */
function uncertain(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return tableAt(id, capacity, { status: 'NEEDS_CHECK', ...overrides });
}

/** 確実な空席。 */
function free(id: string, capacity: number): Table {
  return tableAt(id, capacity, { status: 'FREE', verifiedFreeAt: NOW });
}

/** `waitedMin` 分だけ前に受付した、待っている組。 */
function waiting(id: string, partySize: number, waitedMin: number, overrides: Partial<Ticket> = {}): Ticket {
  return {
    ...createTicket({ id, code: id, partySize, now: NOW - minutes(waitedMin) }),
    ...overrides,
  };
}

function venue(
  tables: readonly Table[],
  tickets: readonly Ticket[],
  policy: Policy = DEFAULT_POLICY,
): VenueState {
  return { ...createVenueState({ venueId: 'v1', policy, tables }), tickets };
}

function pairs(suggestions: readonly Suggestion[]): string[] {
  return suggestions.map((suggestion) => `${suggestion.ticketId}→${suggestion.tableId}`);
}

// ---------------------------------------------------------------------------

describe('案内する場面かどうか', () => {
  it('確実な空席が 1 つでもあれば、確認要の席は案内しない', () => {
    // 確実なほうが先。確証の無い席へ歩かせる理由が無い。
    const state = venue([uncertain('u4', 4), free('f4', 4)], [waiting('A', 2, 10)]);
    expect(suggestNeedsCheck(state)).toEqual([]);
  });

  it('その空席に誰も収まらなくても、案内はしない', () => {
    // 「空席があるなら確認要には回さない」を、収まるかどうかで揺らがせない。
    const state = venue([uncertain('u4', 4), free('f2', 2)], [waiting('A', 4, 10)]);
    expect(suggestNeedsCheck(state)).toEqual([]);
  });

  it('assign_needs_check を切っている施設では案内しない', () => {
    const policy: Policy = { ...DEFAULT_POLICY, assignNeedsCheck: false };
    const state = venue([uncertain('u4', 4)], [waiting('A', 2, 10)], policy);
    expect(suggestNeedsCheck(state)).toEqual([]);
  });

  it('待っている人がいなければ案内しない', () => {
    expect(suggestNeedsCheck(venue([uncertain('u4', 4)], []))).toEqual([]);
  });

  it('確認要の席が無ければ案内しない', () => {
    const state = venue([tableAt('o4', 4, { status: 'OCCUPIED_UNKNOWN' })], [waiting('A', 2, 10)]);
    expect(suggestNeedsCheck(state)).toEqual([]);
  });

  it('管理対象から外れた席は案内しない', () => {
    const state = venue([uncertain('u4', 4, { enabled: false })], [waiting('A', 2, 10)]);
    expect(uncertainTables(state)).toEqual([]);
    expect(suggestNeedsCheck(state)).toEqual([]);
  });
});

describe('誰を案内するか（7.6 と同じ規則）', () => {
  it('収まる人だけが対象になる', () => {
    const state = venue([uncertain('u2', 2)], [waiting('A', 4, 20), waiting('B', 2, 5)]);
    expect(pairs(suggestNeedsCheck(state))).toEqual(['B→u2']);
  });

  it('希望タグを満たさない人は対象にならない', () => {
    const state = venue(
      [uncertain('u4', 4)],
      [waiting('A', 2, 20, { requiredTags: ['power'] }), waiting('B', 2, 5)],
    );
    expect(pairs(suggestNeedsCheck(state))).toEqual(['B→u4']);
  });

  it('待っているだけの人が対象で、呼び出し中や着席中の人は選ばれない', () => {
    const state = venue(
      [uncertain('u4', 4)],
      [waiting('A', 2, 20, { state: 'CALLED', tableId: 'other' }), waiting('B', 2, 5)],
    );
    expect(pairs(suggestNeedsCheck(state))).toEqual(['B→u4']);
  });

  it('ロスが小さい人が先（best fit）。通常の割当と同じ', () => {
    const state = venue([uncertain('u4', 4)], [waiting('A', 2, 10), waiting('B', 4, 3)]);
    expect(pairs(suggestNeedsCheck(state))).toEqual(['B→u4']);
  });

  it('長く待っている人が既定の 10 分以上先なら、その人を案内する（救済）', () => {
    const state = venue([uncertain('u4', 4)], [waiting('A', 2, 15), waiting('B', 4, 3)]);
    expect(pairs(suggestNeedsCheck(state))).toEqual(['A→u4']);
  });

  it('1 人に 2 つの席を案内しない', () => {
    const state = venue([uncertain('u4', 4), uncertain('u2', 2)], [waiting('A', 2, 10)]);
    // 席の既定の処理順は定員の小さい順。小さいほうに案内して終わる。
    expect(pairs(suggestNeedsCheck(state))).toEqual(['A→u2']);
  });

  it('1 つの席に 2 人を案内しない', () => {
    const state = venue([uncertain('u4', 4)], [waiting('A', 2, 10), waiting('B', 2, 5)]);
    expect(pairs(suggestNeedsCheck(state))).toEqual(['A→u4']);
  });

  it('席が複数あれば、それぞれ別の人に案内する', () => {
    const state = venue([uncertain('u2', 2), uncertain('u4', 4)], [waiting('A', 2, 10), waiting('B', 4, 5)]);
    expect(pairs(suggestNeedsCheck(state))).toEqual(['A→u2', 'B→u4']);
  });

  it('席の処理順は施設の設定に従う', () => {
    const policy: Policy = { ...DEFAULT_POLICY, tableOrder: ['admin_rank'] };
    const state = venue(
      [uncertain('u4', 4, { adminRank: 2 }), uncertain('u4b', 4, { adminRank: 1 })],
      [waiting('A', 2, 10)],
      policy,
    );
    expect(pairs(suggestNeedsCheck(state))).toEqual(['A→u4b']);
  });
});

describe('案内は問い合わせである', () => {
  it('状態を変えない', () => {
    const state = venue([uncertain('u4', 4)], [waiting('A', 2, 10)]);
    const before = JSON.stringify(state);
    suggestNeedsCheck(state);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('同じ状態からは同じ答えが返る', () => {
    const state = venue([uncertain('u2', 2), uncertain('u4', 4)], [waiting('A', 2, 10), waiting('B', 4, 5)]);
    expect(suggestNeedsCheck(state)).toEqual(suggestNeedsCheck(state));
  });
});

describe('案内されているかの判定（画面とガードが共有する）', () => {
  const state = venue([uncertain('u4', 4)], [waiting('A', 2, 10), waiting('B', 2, 5)]);

  it('案内された人と席の組み合わせなら真', () => {
    expect(guidedTo(state, 'A', 'u4')).toBe(true);
  });

  it('案内されていない人なら偽', () => {
    expect(guidedTo(state, 'B', 'u4')).toBe(false);
  });

  it('案内された人でも、別の席なら偽', () => {
    expect(guidedTo(state, 'A', 'u9')).toBe(false);
  });
});

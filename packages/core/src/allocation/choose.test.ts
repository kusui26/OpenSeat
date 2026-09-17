import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import { createTicket, type Ticket } from '../domain/ticket.js';
import { createVenueState, type VenueState } from '../domain/state.js';
import { minutes, type Timestamp } from '../time.js';
import {
  assignableTables,
  candidatesFor,
  chooseAssignments,
  orderTables,
  pickCandidate,
  waste,
  type Assignment,
} from './choose.js';

const NOW: Timestamp = 1_700_000_000_000;

/** 空いている席。既定では退席が確認済み。 */
function freeTable(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return {
    ...createTable({ id, label: id, capacity, now: NOW }),
    status: 'FREE',
    verifiedFreeAt: NOW,
    ...overrides,
  };
}

/** `waitedMin` 分だけ前に受付した、待っている組。 */
function waiting(id: string, partySize: number, waitedMin: number, overrides: Partial<Ticket> = {}): Ticket {
  const priorityAt = NOW - minutes(waitedMin);
  return {
    ...createTicket({ id, code: id, partySize, now: priorityAt }),
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

/** テストで並べ替えることがあるので、可変の配列を返す。 */
function ticketIds(assignments: readonly Assignment[]): string[] {
  return assignments.map((assignment) => assignment.ticketId);
}

// ---------------------------------------------------------------------------

describe('7.6 の数値例', () => {
  /** 4 人席が 1 卓空いた。待ちは A（2 名）と B（4 名）。 */
  function twoCandidates(waitedA: number, waitedB: number): VenueState {
    return venue([freeTable('t4', 4)], [waiting('A', 2, waitedA), waiting('B', 4, waitedB)]);
  }

  it('A が 2 名 10 分待ち、B が 4 名 3 分待ちなら、差が 10 分未満なので B に案内する', () => {
    // ロスは A が 2、B が 0。best fit は B。
    // A は B より 7 分長く待っているが、既定の 10 分に届かない。
    const assignments = chooseAssignments(twoCandidates(10, 3));
    expect(assignments).toEqual([{ ticketId: 'B', tableId: 't4', reason: 'best_fit' }]);
  });

  it('A が 15 分待ちなら、差が 12 分で 10 分以上になるので A に案内する', () => {
    // ロス 2 を受け入れて、長く待っている人を先に案内する。
    const assignments = chooseAssignments(twoCandidates(15, 3));
    expect(assignments).toEqual([{ ticketId: 'A', tableId: 't4', reason: 'fairness_override' }]);
  });

  it('差がちょうど 10 分なら、長く待っている人を優先する（境界を含む）', () => {
    const assignments = chooseAssignments(twoCandidates(13, 3));
    expect(ticketIds(assignments)).toEqual(['A']);
  });

  it('差が 10 分に 1 秒足りなければ、best fit のままにする', () => {
    const almost = venue(
      [freeTable('t4', 4)],
      [
        { ...waiting('A', 2, 13), priorityAt: NOW - minutes(13) + 1_000 },
        waiting('B', 4, 3),
      ],
    );
    expect(ticketIds(chooseAssignments(almost))).toEqual(['B']);
  });
});

// ---------------------------------------------------------------------------

describe('7.6 のエッジケース表', () => {
  it('最大定員を超える人数は、どの席にも案内されない', () => {
    // 受付の段階で拒否するのが本筋（7.5、PR 5）。ここでは候補にならないことを確かめる。
    const state = venue([freeTable('t2', 2), freeTable('t4', 4)], [waiting('big', 9, 30)]);
    expect(chooseAssignments(state)).toEqual([]);
  });

  it('待ちが空で空席があっても、何も起きない', () => {
    const state = venue([freeTable('t2', 2), freeTable('t4', 4)], []);
    expect(chooseAssignments(state)).toEqual([]);
  });

  it('待ちの先頭が保留中なら飛ばして、次の対象者に案内する', () => {
    const state = venue(
      [freeTable('t4', 4)],
      [
        waiting('paused', 2, 30, { state: 'PAUSED', pauseDeadline: NOW + minutes(10) }),
        waiting('next', 2, 5),
      ],
    );
    expect(ticketIds(chooseAssignments(state))).toEqual(['next']);
  });

  it('空席が複数で待ちが 1 組なら、ロス最小の席に案内する', () => {
    const state = venue(
      [freeTable('t6', 6), freeTable('t2', 2), freeTable('t4', 4)],
      [waiting('pair', 2, 5)],
    );
    expect(chooseAssignments(state)).toEqual([
      { ticketId: 'pair', tableId: 't2', reason: 'only_candidate' },
    ]);
  });

  it('ロスが同じ席が複数あるなら、退席の確認が新しい席を先に埋める', () => {
    const state = venue(
      [
        freeTable('old', 2, { verifiedFreeAt: NOW - minutes(60) }),
        freeTable('new', 2, { verifiedFreeAt: NOW - minutes(1) }),
      ],
      [waiting('pair', 2, 5)],
    );
    expect(chooseAssignments(state)[0]?.tableId).toBe('new');
  });

  it('退席の確認も同じなら、管理者が決めた処理順に従う', () => {
    const state = venue(
      [
        freeTable('far', 2, { adminRank: 9 }),
        freeTable('near', 2, { adminRank: 1 }),
      ],
      [waiting('pair', 2, 5)],
    );
    expect(chooseAssignments(state)[0]?.tableId).toBe('near');
  });

  it('人数を変えて受付時刻が更新されていれば、その順番で扱う', () => {
    // 人数を増やすと priorityAt が現在時刻に更新される（7.6、実装は PR 5）。
    // ここでは更新後の順番で正しく並ぶことを確かめる。
    const state = venue(
      [freeTable('t4', 4)],
      [waiting('bumped', 4, 0), waiting('kept', 4, 20)],
    );
    expect(ticketIds(chooseAssignments(state))).toEqual(['kept']);
  });

  it('対象外にされた席は、空いていても案内しない', () => {
    const state = venue([freeTable('off', 4, { enabled: false })], [waiting('pair', 2, 5)]);
    expect(chooseAssignments(state)).toEqual([]);
  });

  it('希望タグを満たさない席は、空いていても案内しない', () => {
    const state = venue(
      [freeTable('plain', 4)],
      [waiting('needs', 2, 5, { requiredTags: ['wheelchair'] })],
    );
    expect(chooseAssignments(state)).toEqual([]);
  });

  it('希望タグは候補を絞るだけで、順番は変えない', () => {
    const state = venue(
      [freeTable('acc', 4, { tags: ['wheelchair'] })],
      [
        waiting('early', 2, 20),
        waiting('needs', 2, 5, { requiredTags: ['wheelchair'] }),
      ],
    );
    // 両方が候補になる席なので、待ちの長い early が選ばれる。
    expect(ticketIds(chooseAssignments(state))).toEqual(['early']);
  });

  it('すでに呼び出されている人は、より良い席が空いても再割当しない', () => {
    const state = venue(
      [freeTable('t2', 2)],
      [
        waiting('called', 2, 30, {
          state: 'CALLED',
          tableId: 'held',
          calledAt: NOW,
          holdDeadline: NOW + minutes(7),
        }),
      ],
    );
    expect(chooseAssignments(state)).toEqual([]);
  });

  it('待ちの上限に達していても、割当そのものは通常どおり動く', () => {
    // 上限は受付を止めるためのもの（7.5、PR 5）。すでに並んでいる人の案内は妨げない。
    const capped: Policy = { ...DEFAULT_POLICY, maxQueueLength: 1 };
    const state = venue([freeTable('t4', 4)], [waiting('a', 2, 10), waiting('b', 2, 5)], capped);
    expect(chooseAssignments(state)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('fairnessOverrideMin を振ると両端になる（7.6 の主張）', () => {
  /** 4 人席が 1 卓。2 名の長待ちと、4 名の短待ち。 */
  const contested = (policy: Policy): VenueState =>
    venue([freeTable('t4', 4)], [waiting('pair-long', 2, 30), waiting('quad-short', 4, 1)], policy);

  it('0 にすると厳密な先着順になる', () => {
    const fifo: Policy = { ...DEFAULT_POLICY, fairnessOverrideMin: 0 };
    expect(ticketIds(chooseAssignments(contested(fifo)))).toEqual(['pair-long']);
  });

  it('Infinity にすると純粋な best fit になる', () => {
    const bestFit: Policy = { ...DEFAULT_POLICY, fairnessOverrideMin: Number.POSITIVE_INFINITY };
    expect(ticketIds(chooseAssignments(contested(bestFit)))).toEqual(['quad-short']);
  });

  it('待ちの差がどれだけ開いても、Infinity なら best fit を崩さない', () => {
    const bestFit: Policy = { ...DEFAULT_POLICY, fairnessOverrideMin: Number.POSITIVE_INFINITY };
    const wide = venue(
      [freeTable('t4', 4)],
      [waiting('pair-ancient', 2, 600), waiting('quad-new', 4, 0)],
      bestFit,
    );
    expect(ticketIds(chooseAssignments(wide))).toEqual(['quad-new']);
  });

  it('0 のとき、ロスが大きくても先着を崩さない', () => {
    const fifo: Policy = { ...DEFAULT_POLICY, fairnessOverrideMin: 0 };
    const wide = venue(
      [freeTable('t6', 6)],
      [waiting('single', 1, 10), waiting('six', 6, 9)],
      fifo,
    );
    expect(ticketIds(chooseAssignments(wide))).toEqual(['single']);
  });

  it.each([1, 5, 10, 15, 30])('%s 分に設定すると、その差を境に選ばれる人が変わる', (threshold) => {
    const policy: Policy = { ...DEFAULT_POLICY, fairnessOverrideMin: threshold };
    const under = venue(
      [freeTable('t4', 4)],
      [waiting('pair', 2, threshold - 0.5), waiting('quad', 4, 0)],
      policy,
    );
    const over = venue(
      [freeTable('t4', 4)],
      [waiting('pair', 2, threshold + 0.5), waiting('quad', 4, 0)],
      policy,
    );
    expect(ticketIds(chooseAssignments(under))).toEqual(['quad']);
    expect(ticketIds(chooseAssignments(over))).toEqual(['pair']);
  });
});

// ---------------------------------------------------------------------------

describe('席の処理順', () => {
  it('定員の小さい順に埋める（大きい席を大人数のために残す）', () => {
    const tables = [freeTable('t6', 6), freeTable('t2', 2), freeTable('t4', 4)];
    expect(orderTables(tables, DEFAULT_POLICY).map((table) => table.id)).toEqual(['t2', 't4', 't6']);
  });

  it('同じ定員なら、退席の確認が新しい席を先にする', () => {
    const tables = [
      freeTable('a', 4, { verifiedFreeAt: NOW - minutes(30) }),
      freeTable('b', 4, { verifiedFreeAt: NOW }),
    ];
    expect(orderTables(tables, DEFAULT_POLICY).map((table) => table.id)).toEqual(['b', 'a']);
  });

  it('一度も退席が確認されていない席は最も後ろにする', () => {
    const tables = [
      freeTable('never', 4, { verifiedFreeAt: null }),
      freeTable('old', 4, { verifiedFreeAt: NOW - minutes(600) }),
    ];
    expect(orderTables(tables, DEFAULT_POLICY).map((table) => table.id)).toEqual(['old', 'never']);
  });

  it('どちらも未確認なら、次の鍵で決着する', () => {
    const tables = [
      freeTable('z', 4, { verifiedFreeAt: null, adminRank: 2 }),
      freeTable('a', 4, { verifiedFreeAt: null, adminRank: 1 }),
    ];
    expect(orderTables(tables, DEFAULT_POLICY).map((table) => table.id)).toEqual(['a', 'z']);
  });

  it('すべての鍵で決着しなければ、席の ID で決着する（入力順に依存しない）', () => {
    const tables = [freeTable('b', 4), freeTable('a', 4)];
    expect(orderTables(tables, DEFAULT_POLICY).map((table) => table.id)).toEqual(['a', 'b']);
    expect(orderTables([...tables].reverse(), DEFAULT_POLICY).map((table) => table.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('処理順は設定で変えられる（8.2 の比較項目 5 のため）', () => {
    const capacityOnly: Policy = { ...DEFAULT_POLICY, tableOrder: ['capacity_asc'] };
    const tables = [
      freeTable('b', 4, { verifiedFreeAt: NOW }),
      freeTable('a', 4, { verifiedFreeAt: NOW - minutes(60) }),
    ];
    // 退席の新しさを見ないので、ID で決着して a が先になる。
    expect(orderTables(tables, capacityOnly).map((table) => table.id)).toEqual(['a', 'b']);
    expect(orderTables(tables, DEFAULT_POLICY).map((table) => table.id)).toEqual(['b', 'a']);
  });

  it('元の配列を書き換えない', () => {
    const tables = [freeTable('b', 4), freeTable('a', 2)];
    orderTables(tables, DEFAULT_POLICY);
    expect(tables.map((table) => table.id)).toEqual(['b', 'a']);
  });
});

describe('席の処理順が結果を左右する（7.6 の「定員の小さい順」の理由）', () => {
  /**
   * 4 人席と 2 人席が 1 卓ずつ。待ちは 4 名（1 分待ち）と 2 名（30 分待ち）。
   *
   * 大きい席を先に処理すると、公平性の繰り上げで 2 名組がそこに入り、
   * 4 名組は 2 人席に収まらないので座れなくなる。
   */
  const tables = [freeTable('big', 4, { label: 'A-big' }), freeTable('small', 2, { label: 'B-small' })];
  const tickets = [waiting('quad', 4, 1), waiting('pair', 2, 30)];

  it('定員の小さい順に処理すると、2 組とも案内できる', () => {
    const byCapacity: Policy = { ...DEFAULT_POLICY, tableOrder: ['capacity_asc'] };
    const assignments = chooseAssignments(venue(tables, tickets, byCapacity));
    expect(assignments).toHaveLength(2);
    expect(ticketIds(assignments).sort()).toEqual(['pair', 'quad']);
  });

  it('大きい席から処理すると、1 組しか案内できない', () => {
    // 2 名組が 4 人席に入り、4 名組は 2 人席に収まらない。
    const byLabel: Policy = { ...DEFAULT_POLICY, tableOrder: ['label'] };
    const assignments = chooseAssignments(venue(tables, tickets, byLabel));
    expect(assignments).toEqual([{ ticketId: 'pair', tableId: 'big', reason: 'fairness_override' }]);
  });
});

// ---------------------------------------------------------------------------

describe('候補の絞り込み', () => {
  const table = freeTable('t4', 4);

  it('待っている人だけを候補にする', () => {
    const tickets = [
      waiting('w', 2, 5),
      waiting('p', 2, 5, { state: 'PAUSED', pauseDeadline: NOW }),
      waiting('d', 2, 5, { state: 'DONE', endedAt: NOW, endReason: 'checked_out' }),
    ];
    expect(candidatesFor(table, tickets).map((ticket) => ticket.id)).toEqual(['w']);
  });

  it('定員ちょうどは候補になる', () => {
    expect(candidatesFor(table, [waiting('exact', 4, 5)])).toHaveLength(1);
  });

  it('定員を 1 人でも超えたら候補にならない', () => {
    expect(candidatesFor(table, [waiting('over', 5, 5)])).toEqual([]);
  });
});

describe('assignableTables', () => {
  it('空いていて管理対象の席だけを返す', () => {
    const state = venue(
      [
        freeTable('ok', 4),
        freeTable('off', 4, { enabled: false }),
        freeTable('held', 4, { status: 'HELD' }),
        freeTable('check', 4, { status: 'NEEDS_CHECK' }),
      ],
      [],
    );
    expect(assignableTables(state).map((table) => table.id)).toEqual(['ok']);
  });

  it('確認要の席は確実な空席ではないので含めない（7.11 の案内は PR 10）', () => {
    const state = venue([freeTable('check', 4, { status: 'NEEDS_CHECK' })], []);
    expect(assignableTables(state)).toEqual([]);
  });
});

describe('waste', () => {
  it('定員と人数の差を返す', () => {
    expect(waste(freeTable('t', 4), waiting('a', 2, 0))).toBe(2);
  });

  it('定員ちょうどなら 0', () => {
    expect(waste(freeTable('t', 4), waiting('a', 4, 0))).toBe(0);
  });
});

describe('pickCandidate', () => {
  it('候補が無ければ null', () => {
    expect(pickCandidate([], freeTable('t', 4), DEFAULT_POLICY)).toBeNull();
  });

  it('候補が 1 人なら only_candidate', () => {
    const picked = pickCandidate([waiting('a', 2, 5)], freeTable('t', 4), DEFAULT_POLICY);
    expect(picked?.reason).toBe('only_candidate');
  });

  it('ロス最小の人が最も長く待っていれば best_fit', () => {
    const picked = pickCandidate(
      [waiting('quad', 4, 20), waiting('pair', 2, 5)],
      freeTable('t', 4),
      DEFAULT_POLICY,
    );
    expect(picked).toMatchObject({ reason: 'best_fit' });
    expect(picked?.ticket.id).toBe('quad');
  });

  it('席が塞がっていた人は、同じ受付時刻の中で先に選ばれる（7.8）', () => {
    const at = NOW - minutes(10);
    const picked = pickCandidate(
      [
        { ...waiting('normal', 2, 10), priorityAt: at },
        { ...waiting('conflicted', 2, 10), priorityAt: at, conflictPriority: true },
      ],
      freeTable('t', 2),
      DEFAULT_POLICY,
    );
    expect(picked?.ticket.id).toBe('conflicted');
  });
});

// ---------------------------------------------------------------------------

describe('複数の席と複数の待ち', () => {
  it('1 人が 2 つの席に案内されることはない', () => {
    const state = venue([freeTable('t2', 2), freeTable('t4', 4)], [waiting('only', 2, 10)]);
    expect(chooseAssignments(state)).toHaveLength(1);
  });

  it('1 つの席に 2 人が案内されることはない', () => {
    const state = venue([freeTable('t4', 4)], [waiting('a', 2, 10), waiting('b', 2, 5)]);
    expect(chooseAssignments(state)).toHaveLength(1);
  });

  it('席が足りていれば、全員に案内できる', () => {
    const state = venue(
      [freeTable('t2a', 2), freeTable('t2b', 2), freeTable('t2c', 2)],
      [waiting('a', 2, 30), waiting('b', 2, 20), waiting('c', 2, 10)],
    );
    expect(ticketIds(chooseAssignments(state)).sort()).toEqual(['a', 'b', 'c']);
  });

  it('小さい席から埋めるので、大人数は大きい席に残る', () => {
    const state = venue(
      [freeTable('t2', 2), freeTable('t4', 4)],
      [waiting('pair', 2, 5), waiting('quad', 4, 3)],
    );
    expect(chooseAssignments(state)).toEqual([
      { ticketId: 'pair', tableId: 't2', reason: 'only_candidate' },
      { ticketId: 'quad', tableId: 't4', reason: 'only_candidate' },
    ]);
  });

  it('待ちが席より多ければ、席の数だけ案内する', () => {
    const state = venue(
      [freeTable('t2', 2)],
      [waiting('a', 2, 30), waiting('b', 2, 20), waiting('c', 2, 10)],
    );
    expect(ticketIds(chooseAssignments(state))).toEqual(['a']);
  });
});

describe('決定性', () => {
  const state = venue(
    [freeTable('t2', 2), freeTable('t4', 4), freeTable('t6', 6)],
    [waiting('a', 2, 30), waiting('b', 4, 20), waiting('c', 6, 10), waiting('d', 2, 5)],
  );

  it('同じ状態からは常に同じ結果が出る', () => {
    expect(chooseAssignments(state)).toEqual(chooseAssignments(state));
  });

  it('席の並び順を変えても結果が変わらない', () => {
    const shuffled = venue([...state.tables].reverse(), state.tickets);
    expect(chooseAssignments(shuffled)).toEqual(chooseAssignments(state));
  });

  it('待ちの並び順を変えても結果が変わらない', () => {
    const shuffled = venue(state.tables, [...state.tickets].reverse());
    expect(chooseAssignments(shuffled)).toEqual(chooseAssignments(state));
  });

  it('状態を書き換えない', () => {
    const before = JSON.stringify(state);
    chooseAssignments(state);
    expect(JSON.stringify(state)).toBe(before);
  });
});

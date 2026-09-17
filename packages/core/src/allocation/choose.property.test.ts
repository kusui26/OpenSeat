import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy, type TableOrderKey } from '../domain/policy.js';
import { createTable, fitsCapacity, satisfiesTags, type Table, type TableStatus } from '../domain/table.js';
import { comparePriority, createTicket, type Ticket, type TicketState } from '../domain/ticket.js';
import { createVenueState, findTable, findTicket, type VenueState } from '../domain/state.js';
import { minutes, type Timestamp } from '../time.js';
import { assignableTables, chooseAssignments, waste, type Assignment } from './choose.js';

const NOW: Timestamp = 1_700_000_000_000;
const TAG_POOL = ['power', 'window', 'wheelchair'];

/**
 * ランダムな状態を作って、割当が必ず満たすべき性質を確かめる。
 *
 * 生成される状態は不変条件を満たすとは限らない（席を持たない `CALLED` など）。
 * `chooseAssignments` は `WAITING` のチケットと `FREE` の席しか読まないので、
 * それ以外は雑音として無視されることまで含めて確かめている。
 */

interface TableSpec {
  readonly capacity: number;
  readonly enabled: boolean;
  readonly status: TableStatus;
  readonly verifiedOffsetMin: number | null;
  readonly adminRank: number;
  readonly tags: readonly string[];
}

interface TicketSpec {
  readonly partySize: number;
  readonly state: TicketState;
  readonly waitedMin: number;
  readonly requiredTags: readonly string[];
  readonly conflictPriority: boolean;
}

const tableSpec: fc.Arbitrary<TableSpec> = fc.record({
  capacity: fc.integer({ min: 1, max: 6 }),
  enabled: fc.boolean(),
  status: fc.constantFrom<TableStatus>('FREE', 'HELD', 'OCCUPIED', 'NEEDS_CHECK', 'DISABLED'),
  verifiedOffsetMin: fc.option(fc.integer({ min: 0, max: 180 }), { nil: null }),
  adminRank: fc.integer({ min: 0, max: 5 }),
  tags: fc.subarray(TAG_POOL),
});

const ticketSpec: fc.Arbitrary<TicketSpec> = fc.record({
  partySize: fc.integer({ min: 1, max: 8 }),
  state: fc.constantFrom<TicketState>('WAITING', 'PAUSED', 'CALLED', 'SEATED', 'DONE'),
  waitedMin: fc.integer({ min: 0, max: 120 }),
  requiredTags: fc.subarray(TAG_POOL),
  conflictPriority: fc.boolean(),
});

const TABLE_ORDERS: readonly (readonly TableOrderKey[])[] = [
  ['capacity_asc', 'verified_free_desc', 'admin_rank', 'label'],
  ['capacity_asc'],
  ['admin_rank', 'capacity_asc'],
  ['label'],
];

const policyArb: fc.Arbitrary<Policy> = fc
  .record({
    fairnessOverrideMin: fc.constantFrom(0, 5, 10, 15, Number.POSITIVE_INFINITY),
    tableOrder: fc.constantFrom(...TABLE_ORDERS),
  })
  .map((chosen) => ({ ...DEFAULT_POLICY, ...chosen }));

function toTable(spec: TableSpec, index: number): Table {
  return {
    ...createTable({
      id: `T${index}`,
      label: `T-${String(index).padStart(2, '0')}`,
      capacity: spec.capacity,
      now: NOW,
      tags: spec.tags,
      adminRank: spec.adminRank,
      enabled: spec.enabled,
    }),
    status: spec.status,
    verifiedFreeAt: spec.verifiedOffsetMin === null ? null : NOW - minutes(spec.verifiedOffsetMin),
  };
}

function toTicket(spec: TicketSpec, index: number): Ticket {
  const priorityAt = NOW - minutes(spec.waitedMin);
  return {
    ...createTicket({
      id: `K${index}`,
      code: `A-${String(index).padStart(2, '0')}`,
      partySize: spec.partySize,
      now: priorityAt,
      requiredTags: spec.requiredTags,
    }),
    state: spec.state,
    conflictPriority: spec.conflictPriority,
  };
}

const stateArb: fc.Arbitrary<VenueState> = fc
  .record({
    tables: fc.array(tableSpec, { minLength: 0, maxLength: 8 }),
    tickets: fc.array(ticketSpec, { minLength: 0, maxLength: 12 }),
    policy: policyArb,
  })
  .map(({ tables, tickets, policy }) => ({
    ...createVenueState({ venueId: 'v1', policy, tables: tables.map(toTable) }),
    tickets: tickets.map(toTicket),
  }));

const RUNS = { numRuns: 500 };

/** 決まった設定で状態を作る生成器。 */
function withPolicy(policy: Policy): fc.Arbitrary<VenueState> {
  return fc
    .record({
      tables: fc.array(tableSpec, { maxLength: 6 }),
      tickets: fc.array(ticketSpec, { maxLength: 10 }),
    })
    .map(({ tables, tickets }) => ({
      ...createVenueState({ venueId: 'v1', policy, tables: tables.map(toTable) }),
      tickets: tickets.map(toTicket),
    }));
}

/**
 * 割当を宣言された順にたどり直し、各席で選ばれた人を検証する。
 *
 * `chooseAssignments` は席を処理順に並べて 1 つずつ埋めるので、出力の順序が
 * そのまま処理順になる。同じ手順で候補を作り直して突き合わせる。
 */
function replay(
  state: VenueState,
  assignments: readonly Assignment[],
  verify: (candidates: readonly Ticket[], table: Table, chosen: Ticket) => boolean,
): boolean {
  const taken = new Set<string>();
  for (const assignment of assignments) {
    const table = findTable(state, assignment.tableId);
    const chosen = findTicket(state, assignment.ticketId);
    if (table === undefined || chosen === undefined) return false;
    const candidates = state.tickets.filter(
      (ticket) =>
        ticket.state === 'WAITING' &&
        !taken.has(ticket.id) &&
        fitsCapacity(table, ticket.partySize) &&
        satisfiesTags(table, ticket.requiredTags),
    );
    if (!verify(candidates, table, chosen)) return false;
    taken.add(assignment.ticketId);
  }
  return true;
}

/** 先着順のとき、常に候補の中で最も早い人が選ばれているか。 */
function earliestCandidateAlwaysChosen(
  state: VenueState,
  assignments: readonly Assignment[],
): boolean {
  return replay(state, assignments, (candidates, _table, chosen) => {
    const earliest = [...candidates].sort(comparePriority)[0];
    return earliest !== undefined && earliest.id === chosen.id;
  });
}

/** 純 best fit のとき、常にロス最小の候補が選ばれているか。 */
function minimumWasteAlwaysChosen(
  state: VenueState,
  assignments: readonly Assignment[],
): boolean {
  return replay(state, assignments, (candidates, table, chosen) => {
    const minWaste = Math.min(...candidates.map((candidate) => waste(table, candidate)));
    return waste(table, chosen) === minWaste;
  });
}

describe('割当が必ず満たす性質', () => {
  it('同じ席に 2 回案内しない', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const tableIds = chooseAssignments(state).map((a) => a.tableId);
        return new Set(tableIds).size === tableIds.length;
      }),
      RUNS,
    );
  });

  it('同じ人を 2 回案内しない', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const ticketIds = chooseAssignments(state).map((a) => a.ticketId);
        return new Set(ticketIds).size === ticketIds.length;
      }),
      RUNS,
    );
  });

  it('案内した人の人数は、必ずその席の定員に収まる', () => {
    fc.assert(
      fc.property(stateArb, (state) =>
        chooseAssignments(state).every((assignment) => {
          const table = findTable(state, assignment.tableId);
          const ticket = findTicket(state, assignment.ticketId);
          return table !== undefined && ticket !== undefined && fitsCapacity(table, ticket.partySize);
        }),
      ),
      RUNS,
    );
  });

  it('案内した席は、必ずその人の希望タグを満たす', () => {
    fc.assert(
      fc.property(stateArb, (state) =>
        chooseAssignments(state).every((assignment) => {
          const table = findTable(state, assignment.tableId);
          const ticket = findTicket(state, assignment.ticketId);
          return table !== undefined && ticket !== undefined && satisfiesTags(table, ticket.requiredTags);
        }),
      ),
      RUNS,
    );
  });

  it('案内するのは待っている人だけ', () => {
    fc.assert(
      fc.property(stateArb, (state) =>
        chooseAssignments(state).every(
          (assignment) => findTicket(state, assignment.ticketId)?.state === 'WAITING',
        ),
      ),
      RUNS,
    );
  });

  it('案内する席は、管理対象で確実に空いている席だけ', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const usable = new Set(assignableTables(state).map((table) => table.id));
        return chooseAssignments(state).every((assignment) => usable.has(assignment.tableId));
      }),
      RUNS,
    );
  });

  /**
   * **この性質がいちばん重要。** 全体プラン 9.12 の 3 に対応する。
   *
   * 割当が終わったあとに「案内できたはずの組み合わせ」が残っていたら、
   * 誰かが理由もなく待たされていることになる。
   */
  it('案内できる組み合わせを取り残さない（no_starvation）', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const assignments = chooseAssignments(state);
        const usedTables = new Set(assignments.map((a) => a.tableId));
        const usedTickets = new Set(assignments.map((a) => a.ticketId));

        const leftoverTables = assignableTables(state).filter((table) => !usedTables.has(table.id));
        const leftoverWaiting = state.tickets.filter(
          (ticket) => ticket.state === 'WAITING' && !usedTickets.has(ticket.id),
        );

        return !leftoverWaiting.some((ticket) =>
          leftoverTables.some(
            (table) => fitsCapacity(table, ticket.partySize) && satisfiesTags(table, ticket.requiredTags),
          ),
        );
      }),
      RUNS,
    );
  });

  it('案内の数は、使える席の数も待っている人の数も超えない', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const count = chooseAssignments(state).length;
        const waiting = state.tickets.filter((ticket) => ticket.state === 'WAITING').length;
        return count <= assignableTables(state).length && count <= waiting;
      }),
      RUNS,
    );
  });
});

describe('決定性', () => {
  it('同じ状態からは常に同じ結果が出る', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        expect(chooseAssignments(state)).toEqual(chooseAssignments(state));
      }),
      RUNS,
    );
  });

  it('席と待ちの並び順を変えても、結果が完全に一致する', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const reversed: VenueState = {
          ...state,
          tables: [...state.tables].reverse(),
          tickets: [...state.tickets].reverse(),
        };
        expect(chooseAssignments(reversed)).toEqual(chooseAssignments(state));
      }),
      RUNS,
    );
  });

  it('状態を書き換えない', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const before = JSON.stringify(state);
        chooseAssignments(state);
        return JSON.stringify(state) === before;
      }),
      RUNS,
    );
  });
});

describe('設定を振ったときの性質', () => {
  it('先着順（0）では、案内される人が常に「その席の候補の中で最も早い人」になる', () => {
    const fifo = withPolicy({ ...DEFAULT_POLICY, fairnessOverrideMin: 0 });
    fc.assert(
      fc.property(fifo, (state) => earliestCandidateAlwaysChosen(state, chooseAssignments(state))),
      RUNS,
    );
  });

  it('純 best fit（Infinity）では、公平性による繰り上げが起こらない', () => {
    const bestFit = withPolicy({ ...DEFAULT_POLICY, fairnessOverrideMin: Number.POSITIVE_INFINITY });
    fc.assert(
      fc.property(bestFit, (state) =>
        chooseAssignments(state).every((assignment) => assignment.reason !== 'fairness_override'),
      ),
      RUNS,
    );
  });

  it('純 best fit（Infinity）では、案内される人が常にロス最小の候補になる', () => {
    const bestFit = withPolicy({ ...DEFAULT_POLICY, fairnessOverrideMin: Number.POSITIVE_INFINITY });
    fc.assert(
      fc.property(bestFit, (state) => minimumWasteAlwaysChosen(state, chooseAssignments(state))),
      RUNS,
    );
  });

  /**
   * **処理順を変えると案内できる人数は変わりうる。** 大きい席を先に処理すると、
   * 小さい組にそこを使われて大人数が座れなくなることがある。これが 7.6 の
   * 「定員の小さい順に処理する」という判断の理由で、具体例は
   * `choose.test.ts` の「席の処理順が結果を左右する」に置いてある。
   *
   * 順番によらず成り立つのは「案内の中身が妥当であること」のほうである。
   */
  it('どの処理順でも、案内の中身は妥当なまま（定員・タグ・重複なし）', () => {
    fc.assert(
      fc.property(stateArb, (state) =>
        TABLE_ORDERS.every((tableOrder) => {
          const assignments = chooseAssignments({
            ...state,
            policy: { ...state.policy, tableOrder },
          });
          const tableIds = assignments.map((a) => a.tableId);
          const ticketIds = assignments.map((a) => a.ticketId);
          if (new Set(tableIds).size !== tableIds.length) return false;
          if (new Set(ticketIds).size !== ticketIds.length) return false;
          return assignments.every((assignment) => {
            const table = findTable(state, assignment.tableId);
            const ticket = findTicket(state, assignment.ticketId);
            return (
              table !== undefined &&
              ticket !== undefined &&
              fitsCapacity(table, ticket.partySize) &&
              satisfiesTags(table, ticket.requiredTags)
            );
          });
        }),
      ),
      RUNS,
    );
  });
});

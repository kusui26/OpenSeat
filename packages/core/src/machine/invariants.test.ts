import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import { createTicket, type Ticket } from '../domain/ticket.js';
import { createVenueState, type VenueState } from '../domain/state.js';
import { checkInvariants, checkTransition, type Invariant } from '../invariant.js';
import { minutes, type Timestamp } from '../time.js';
import {
  ALL_INVARIANT_NAMES,
  POST_ALLOCATION_INVARIANTS,
  STATE_INVARIANTS,
  TRANSITION_INVARIANTS,
  noStarvation,
  priorityPreservedAcrossPause,
  tickIdempotent,
} from './invariants.js';

const NOW: Timestamp = 1_700_000_000_000;

function tbl(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), ...overrides };
}

function tkt(id: string, partySize: number, overrides: Partial<Ticket> = {}): Ticket {
  return { ...createTicket({ id, code: id, partySize, now: NOW }), ...overrides };
}

function venue(tables: readonly Table[], tickets: readonly Ticket[]): VenueState {
  return { ...createVenueState({ venueId: 'v1', policy: DEFAULT_POLICY, tables }), tickets };
}

/**
 * すべての不変条件を満たす状態。
 *
 * 各テストはここから 1 か所だけ崩し、狙った不変条件だけが落ちることを確かめる。
 *
 * - `tb-free` は 2 名席で空いている
 * - 待っている `tk-waiting` は 6 名なので `tb-free` に収まらない（no_starvation を満たす）
 */
function healthy(): VenueState {
  return venue(
    [
      tbl('tb-free', 2, { status: 'FREE', verifiedFreeAt: NOW }),
      tbl('tb-held', 4, { status: 'HELD', occupantTicketId: 'tk-called' }),
      tbl('tb-occupied', 4, { status: 'OCCUPIED', occupantTicketId: 'tk-seated' }),
    ],
    [
      tkt('tk-waiting', 6),
      tkt('tk-paused', 2, { state: 'PAUSED', pauseDeadline: NOW + minutes(10) }),
      tkt('tk-called', 3, {
        state: 'CALLED',
        tableId: 'tb-held',
        calledAt: NOW,
        holdDeadline: NOW + minutes(7),
      }),
      tkt('tk-seated', 4, { state: 'SEATED', tableId: 'tb-occupied', seatedAt: NOW }),
      tkt('tk-done', 2, { state: 'DONE', endedAt: NOW, endReason: 'checked_out' }),
    ],
  );
}

const EVERY_STATE_INVARIANT: readonly Invariant<VenueState>[] = [
  ...STATE_INVARIANTS,
  ...POST_ALLOCATION_INVARIANTS,
];

/** 1 か所を崩した状態で、狙った不変条件だけが落ちることを確かめる。 */
function expectOnlyViolated(state: VenueState, name: string): void {
  const violated = checkInvariants(EVERY_STATE_INVARIANT, state).map((item) => item.name);
  expect(violated).toEqual([name]);
}

function expectHealthy(state: VenueState): void {
  expect(checkInvariants(EVERY_STATE_INVARIANT, state)).toEqual([]);
}

/**
 * このファイルで「成立する例」と「破れる例」の両方を書いた不変条件。
 *
 * `ALL_INVARIANT_NAMES` と一致することを検査する。不変条件を足したのに
 * テストを書き忘れる、という抜けを落とすため。
 */
const COVERED_BY_TESTS: readonly string[] = [
  'unique_ids',
  'unique_active_codes',
  'assigned_has_table',
  'terminal_holds_no_table',
  'table_link_is_mutual',
  'assignment_status_matches',
  'one_ticket_per_table',
  'assigned_party_fits_capacity',
  'held_table_has_deadline',
  'state_timestamps_are_set',
  'end_reason_matches_state',
  'no_starvation',
  'priority_preserved_across_pause',
  'tick_idempotent',
];

describe('宣言の全体', () => {
  it('14 個の不変条件が宣言されている', () => {
    expect(ALL_INVARIANT_NAMES).toHaveLength(14);
  });

  it('宣言されたすべての不変条件に、成立例と違反例のテストがある', () => {
    expect([...COVERED_BY_TESTS].sort()).toEqual([...ALL_INVARIANT_NAMES].sort());
  });

  it('名前が重複していない', () => {
    expect(new Set(ALL_INVARIANT_NAMES).size).toBe(ALL_INVARIANT_NAMES.length);
  });

  it('3 つの群に分かれている', () => {
    expect(STATE_INVARIANTS).toHaveLength(11);
    expect(POST_ALLOCATION_INVARIANTS).toHaveLength(1);
    expect(TRANSITION_INVARIANTS).toHaveLength(2);
  });

  it('すべての不変条件に説明がある', () => {
    for (const item of [...STATE_INVARIANTS, ...POST_ALLOCATION_INVARIANTS, ...TRANSITION_INVARIANTS]) {
      expect(item.describe.length, `${item.name} の説明`).toBeGreaterThan(0);
    }
  });

  it('健全な状態は、すべての不変条件を満たす（互いに矛盾していない）', () => {
    expectHealthy(healthy());
  });

  it('空の状態も、すべての不変条件を満たす', () => {
    expectHealthy(venue([], []));
  });
});

describe('unique_ids', () => {
  it('健全な状態では成立する', () => {
    expectHealthy(healthy());
  });

  it('チケット ID が重複していたら落ちる', () => {
    const base = healthy();
    const duped = venue(base.tables, [...base.tickets, tkt('tk-waiting', 6)]);
    expect(checkInvariants(EVERY_STATE_INVARIANT, duped).map((item) => item.name)).toContain(
      'unique_ids',
    );
  });

  it('テーブル ID が重複していたら落ちる', () => {
    const base = healthy();
    const duped = venue([...base.tables, tbl('tb-free', 2, { status: 'FREE' })], base.tickets);
    expect(checkInvariants(EVERY_STATE_INVARIANT, duped).map((item) => item.name)).toContain(
      'unique_ids',
    );
  });
});

describe('unique_active_codes', () => {
  it('生きているチケットの表示コードが重複していたら落ちる', () => {
    const base = healthy();
    const clashing = base.tickets.map((ticket) =>
      ticket.id === 'tk-paused' ? { ...ticket, code: 'tk-waiting' } : ticket,
    );
    expectOnlyViolated(venue(base.tables, clashing), 'unique_active_codes');
  });

  it('終端に達したチケットの表示コードは重複してよい（使い回すため）', () => {
    const base = healthy();
    const reused = base.tickets.map((ticket) =>
      ticket.id === 'tk-done' ? { ...ticket, code: 'tk-waiting' } : ticket,
    );
    expectHealthy(venue(base.tables, reused));
  });
});

describe('assigned_has_table', () => {
  it('CALLED なのに席を持っていなかったら落ちる', () => {
    const base = healthy();
    const broken = base.tickets.map((ticket) =>
      ticket.id === 'tk-called' ? { ...ticket, tableId: null } : ticket,
    );
    const violated = checkInvariants(EVERY_STATE_INVARIANT, venue(base.tables, broken)).map(
      (item) => item.name,
    );
    expect(violated).toContain('assigned_has_table');
  });

  it('SEATED が実在しない席を指していたら落ちる', () => {
    const base = healthy();
    const broken = base.tickets.map((ticket) =>
      ticket.id === 'tk-seated' ? { ...ticket, tableId: 'nope' } : ticket,
    );
    const violated = checkInvariants(EVERY_STATE_INVARIANT, venue(base.tables, broken)).map(
      (item) => item.name,
    );
    expect(violated).toContain('assigned_has_table');
  });
});

describe('terminal_holds_no_table', () => {
  it('終端に達したチケットが席を持っていたら落ちる', () => {
    const base = healthy();
    const broken = base.tickets.map((ticket) =>
      ticket.id === 'tk-done' ? { ...ticket, tableId: 'tb-free' } : ticket,
    );
    expectOnlyViolated(venue(base.tables, broken), 'terminal_holds_no_table');
  });
});

describe('table_link_is_mutual', () => {
  it('席が誰かを指しているのに、その人が別の席を指していたら落ちる', () => {
    const base = healthy();
    const broken = base.tables.map((table) =>
      table.id === 'tb-free' ? { ...table, occupantTicketId: 'tk-waiting' } : table,
    );
    expectOnlyViolated(venue(broken, base.tickets), 'table_link_is_mutual');
  });

  it('席が実在しないチケットを指していたら落ちる', () => {
    const base = healthy();
    const broken = base.tables.map((table) =>
      table.id === 'tb-free' ? { ...table, occupantTicketId: 'nope' } : table,
    );
    expectOnlyViolated(venue(broken, base.tickets), 'table_link_is_mutual');
  });
});

describe('assignment_status_matches', () => {
  it('SEATED の席が OCCUPIED でなかったら落ちる', () => {
    const base = healthy();
    const broken = base.tables.map((table) =>
      table.id === 'tb-occupied' ? { ...table, status: 'HELD' as const } : table,
    );
    expectOnlyViolated(venue(broken, base.tickets), 'assignment_status_matches');
  });

  it('CALLED の席が HELD でなかったら落ちる', () => {
    const base = healthy();
    const broken = base.tables.map((table) =>
      table.id === 'tb-held' ? { ...table, status: 'OCCUPIED' as const } : table,
    );
    expectOnlyViolated(venue(broken, base.tickets), 'assignment_status_matches');
  });
});

describe('one_ticket_per_table', () => {
  it('1 つの席に 2 枚のチケットが割り当てられていたら落ちる', () => {
    // 製品が成立しなくなる、最も重い違反。
    const base = healthy();
    const broken = base.tickets.map((ticket) =>
      ticket.id === 'tk-seated'
        ? { ...ticket, tableId: 'tb-held', state: 'CALLED' as const, calledAt: NOW, holdDeadline: NOW }
        : ticket,
    );
    const violated = checkInvariants(EVERY_STATE_INVARIANT, venue(base.tables, broken)).map(
      (item) => item.name,
    );
    expect(violated).toContain('one_ticket_per_table');
  });

  it('席を持たないチケットが複数あっても落ちない', () => {
    const base = healthy();
    const many = [...base.tickets, tkt('tk-extra', 6), tkt('tk-extra2', 6)];
    expectHealthy(venue(base.tables, many));
  });
});

describe('assigned_party_fits_capacity', () => {
  it('定員を超える組が着席していたら落ちる', () => {
    const base = healthy();
    const broken = base.tickets.map((ticket) =>
      ticket.id === 'tk-seated' ? { ...ticket, partySize: 9 } : ticket,
    );
    expectOnlyViolated(venue(base.tables, broken), 'assigned_party_fits_capacity');
  });

  it('席の定員が下げられて収まらなくなったら落ちる', () => {
    const base = healthy();
    const broken = base.tables.map((table) =>
      table.id === 'tb-occupied' ? { ...table, capacity: 2 } : table,
    );
    expectOnlyViolated(venue(broken, base.tickets), 'assigned_party_fits_capacity');
  });

  it('定員ちょうどは収まる', () => {
    expectHealthy(healthy());
  });
});

describe('held_table_has_deadline', () => {
  it('CALLED なのにホールドの期限が無かったら落ちる', () => {
    const base = healthy();
    const broken = base.tickets.map((ticket) =>
      ticket.id === 'tk-called' ? { ...ticket, holdDeadline: null } : ticket,
    );
    const violated = checkInvariants(EVERY_STATE_INVARIANT, venue(base.tables, broken)).map(
      (item) => item.name,
    );
    expect(violated).toContain('held_table_has_deadline');
  });
});

describe('state_timestamps_are_set', () => {
  it.each([
    ['CALLED', 'tk-called', { calledAt: null }],
    ['SEATED', 'tk-seated', { seatedAt: null }],
    ['PAUSED', 'tk-paused', { pauseDeadline: null }],
    ['終端', 'tk-done', { endedAt: null }],
  ])('%s で必要な時刻が欠けていたら落ちる', (_label, id, patch) => {
    const base = healthy();
    const broken = base.tickets.map((ticket) => (ticket.id === id ? { ...ticket, ...patch } : ticket));
    const violated = checkInvariants(EVERY_STATE_INVARIANT, venue(base.tables, broken)).map(
      (item) => item.name,
    );
    expect(violated).toContain('state_timestamps_are_set');
  });

  it('WAITING には時刻の要求が無い', () => {
    expectHealthy(healthy());
  });
});

describe('end_reason_matches_state', () => {
  it('終わり方と終端状態が食い違っていたら落ちる', () => {
    const base = healthy();
    const broken = base.tickets.map((ticket) =>
      ticket.id === 'tk-done' ? { ...ticket, endReason: 'no_show' as const } : ticket,
    );
    expectOnlyViolated(venue(base.tables, broken), 'end_reason_matches_state');
  });

  it('対応表どおりなら成立する', () => {
    const base = healthy();
    const ok = base.tickets.map((ticket) =>
      ticket.id === 'tk-done'
        ? { ...ticket, state: 'NO_SHOW' as const, endReason: 'no_show' as const }
        : ticket,
    );
    expectHealthy(venue(base.tables, ok));
  });
});

describe('no_starvation（割当の直後にだけ成立）', () => {
  it('収まる空席があるのに待っている人が残っていたら落ちる', () => {
    const base = healthy();
    // tb-free は 2 名席。2 名の待ちを足すと、割当されるべきなのに残っている状態になる。
    const starving = venue(base.tables, [...base.tickets, tkt('tk-small', 2)]);
    expect(checkInvariants([noStarvation], starving).map((item) => item.name)).toEqual([
      'no_starvation',
    ]);
  });

  it('待っている人が空席に収まらないなら成立する', () => {
    expect(checkInvariants([noStarvation], healthy())).toEqual([]);
  });

  it('希望タグを満たさない席は、空いていても割当先にならない', () => {
    const base = healthy();
    const picky = venue(base.tables, [...base.tickets, tkt('tk-picky', 2, { requiredTags: ['power'] })]);
    expect(checkInvariants([noStarvation], picky)).toEqual([]);
  });

  it('対象外の席は空席として数えない', () => {
    const disabled = venue(
      [tbl('tb-off', 4, { status: 'FREE', enabled: false })],
      [tkt('tk-waiting', 2)],
    );
    expect(checkInvariants([noStarvation], disabled)).toEqual([]);
  });

  it('確認要の席は確実な空席ではないので数えない', () => {
    const uncertain = venue([tbl('tb-check', 4, { status: 'NEEDS_CHECK' })], [tkt('tk-waiting', 2)]);
    expect(checkInvariants([noStarvation], uncertain)).toEqual([]);
  });

  it('常時検査の群には含まれていない（呼び出しの途中で一時的に破れるため）', () => {
    expect(STATE_INVARIANTS.map((item) => item.name)).not.toContain('no_starvation');
    expect(POST_ALLOCATION_INVARIANTS.map((item) => item.name)).toEqual(['no_starvation']);
  });
});

describe('priority_preserved_across_pause', () => {
  const before = healthy();

  function withPaused(priorityAt: Timestamp): VenueState {
    return venue(
      before.tables,
      before.tickets.map((ticket) =>
        ticket.id === 'tk-waiting'
          ? { ...ticket, state: 'PAUSED' as const, pauseDeadline: NOW + minutes(10), priorityAt }
          : ticket,
      ),
    );
  }

  it('保留に入っても順番が変わらなければ成立する', () => {
    expect(checkTransition([priorityPreservedAcrossPause], before, withPaused(NOW))).toEqual([]);
  });

  it('保留に入って順番が変わったら落ちる', () => {
    const violations = checkTransition(
      [priorityPreservedAcrossPause],
      before,
      withPaused(NOW + minutes(30)),
    );
    expect(violations.map((item) => item.name)).toEqual(['priority_preserved_across_pause']);
  });

  it('保留から出るときも順番が変わってはいけない', () => {
    const paused = withPaused(NOW);
    const resumed = venue(
      paused.tables,
      paused.tickets.map((ticket) =>
        ticket.id === 'tk-waiting'
          ? { ...ticket, state: 'WAITING' as const, priorityAt: NOW + minutes(30) }
          : ticket,
      ),
    );
    expect(checkTransition([priorityPreservedAcrossPause], paused, resumed)).toHaveLength(1);
  });

  it('保留を経由しない順番の変更は、この条件に触れない（人数の増加など）', () => {
    // WAITING のまま priorityAt を更新するのは、7.6 が認めている正当な操作。
    const bumped = venue(
      before.tables,
      before.tickets.map((ticket) =>
        ticket.id === 'tk-waiting' ? { ...ticket, priorityAt: NOW + minutes(30) } : ticket,
      ),
    );
    expect(checkTransition([priorityPreservedAcrossPause], before, bumped)).toEqual([]);
  });

  it('遷移の前後で消えたチケットは対象外', () => {
    const shrunk = venue(before.tables, before.tickets.filter((ticket) => ticket.id !== 'tk-waiting'));
    expect(checkTransition([priorityPreservedAcrossPause], before, shrunk)).toEqual([]);
  });
});

describe('tick_idempotent', () => {
  it('同じ状態同士なら成立する', () => {
    const state = healthy();
    expect(checkTransition([tickIdempotent], state, state)).toEqual([]);
  });

  it('内容が同じで別のオブジェクトでも成立する（参照ではなく内容で比べる）', () => {
    expect(checkTransition([tickIdempotent], healthy(), healthy())).toEqual([]);
  });

  it('2 回目の tick で状態が変わったら落ちる', () => {
    const before = healthy();
    const after = venue(
      before.tables,
      before.tickets.map((ticket) =>
        ticket.id === 'tk-called' ? { ...ticket, extensions: 1 } : ticket,
      ),
    );
    expect(checkTransition([tickIdempotent], before, after).map((item) => item.name)).toEqual([
      'tick_idempotent',
    ]);
  });

  it('席の状態が変わっても落ちる', () => {
    const before = healthy();
    const after = venue(
      before.tables.map((table) =>
        table.id === 'tb-free' ? { ...table, status: 'NEEDS_CHECK' as const } : table,
      ),
      before.tickets,
    );
    expect(checkTransition([tickIdempotent], before, after)).toHaveLength(1);
  });

  it('チケットが増えても落ちる', () => {
    const before = healthy();
    const after = venue(before.tables, [...before.tickets, tkt('tk-new', 2)]);
    expect(checkTransition([tickIdempotent], before, after)).toHaveLength(1);
  });

  it('採番カウンタが進んでも落ちる', () => {
    const before = healthy();
    expect(checkTransition([tickIdempotent], before, { ...before, nextCodeSeq: 1 })).toHaveLength(1);
  });
});

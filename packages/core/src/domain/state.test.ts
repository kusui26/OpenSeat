import { describe, expect, it } from 'vitest';
import type { Timestamp } from '../time.js';
import { DEFAULT_POLICY } from './policy.js';
import { createTable, type Table } from './table.js';
import { createTicket, type Ticket } from './ticket.js';
import {
  CODE_SPACE_SIZE,
  activeTickets,
  createVenueState,
  effectiveMaxPartySize,
  findTable,
  findTicket,
  managedTables,
  nextTicketCode,
  ticketCodeFor,
  waitingTickets,
  withTable,
  withTicket,
  type VenueState,
} from './state.js';

const NOW: Timestamp = 1_700_000_000_000;

function table(id: string, capacity: number, enabled = true): Table {
  return createTable({ id, label: id.toUpperCase(), capacity, now: NOW, enabled });
}

function ticket(id: string, state: Ticket['state'] = 'WAITING'): Ticket {
  return { ...createTicket({ id, code: 'A-01', partySize: 2, now: NOW }), state };
}

function stateWith(tables: readonly Table[], tickets: readonly Ticket[] = []): VenueState {
  return { ...createVenueState({ venueId: 'v1', policy: DEFAULT_POLICY, tables }), tickets };
}

describe('createVenueState', () => {
  it('運用前は operating も joinOpen も偽', () => {
    const state = createVenueState({ venueId: 'v1', policy: DEFAULT_POLICY });
    expect(state.operating).toBe(false);
    expect(state.joinOpen).toBe(false);
  });

  it('席もチケットも空で始まる', () => {
    const state = createVenueState({ venueId: 'v1', policy: DEFAULT_POLICY });
    expect(state.tables).toEqual([]);
    expect(state.tickets).toEqual([]);
  });

  it('表示コードの採番は 0 から始まる', () => {
    expect(createVenueState({ venueId: 'v1', policy: DEFAULT_POLICY }).nextCodeSeq).toBe(0);
  });
});

describe('引き当て', () => {
  const state = stateWith(
    [table('tb1', 2), table('tb2', 4)],
    [ticket('t1', 'WAITING'), ticket('t2', 'SEATED'), ticket('t3', 'DONE')],
  );

  it('ID でテーブルを引ける', () => {
    expect(findTable(state, 'tb2')?.capacity).toBe(4);
  });

  it('存在しないテーブルは undefined', () => {
    expect(findTable(state, 'nope')).toBeUndefined();
  });

  it('ID でチケットを引ける', () => {
    expect(findTicket(state, 't2')?.state).toBe('SEATED');
  });

  it('終端に達したチケットは activeTickets に含まれない', () => {
    expect(activeTickets(state).map((entry) => entry.id)).toEqual(['t1', 't2']);
  });

  it('waitingTickets は WAITING だけを返す', () => {
    expect(waitingTickets(state).map((entry) => entry.id)).toEqual(['t1']);
  });

  it('managedTables は対象席だけを返す', () => {
    const mixed = stateWith([table('tb1', 2), table('tb2', 4, false)]);
    expect(managedTables(mixed).map((entry) => entry.id)).toEqual(['tb1']);
  });
});

describe('表示コードの採番', () => {
  it('0 番は A-01', () => {
    expect(ticketCodeFor(0)).toBe('A-01');
  });

  it('1 番は A-02', () => {
    expect(ticketCodeFor(1)).toBe('A-02');
  });

  it('98 番で A-99 まで使い切る', () => {
    expect(ticketCodeFor(98)).toBe('A-99');
  });

  it('99 番で B-01 に繰り上がる', () => {
    expect(ticketCodeFor(99)).toBe('B-01');
  });

  it('最後は Z-99', () => {
    expect(ticketCodeFor(CODE_SPACE_SIZE - 1)).toBe('Z-99');
  });

  it('使い切ったら A-01 に戻る', () => {
    expect(ticketCodeFor(CODE_SPACE_SIZE)).toBe('A-01');
  });

  it('1 日の運用で足りる通り数がある（2,574 通り）', () => {
    expect(CODE_SPACE_SIZE).toBe(2574);
  });

  it('1 周するまで重複しない', () => {
    const codes = new Set<string>();
    for (let seq = 0; seq < CODE_SPACE_SIZE; seq += 1) {
      codes.add(ticketCodeFor(seq));
    }
    expect(codes.size).toBe(CODE_SPACE_SIZE);
  });

  it('同じ採番からは常に同じコードが出る（決定的）', () => {
    expect(ticketCodeFor(1234)).toBe(ticketCodeFor(1234));
  });

  it('状態の採番カウンタから次のコードが決まる', () => {
    const state = { ...stateWith([]), nextCodeSeq: 99 };
    expect(nextTicketCode(state)).toBe('B-01');
  });
});

describe('effectiveMaxPartySize', () => {
  it('設定があればそれを使う', () => {
    const state = stateWith([table('tb1', 6)]);
    const overridden: VenueState = {
      ...state,
      policy: { ...DEFAULT_POLICY, maxPartySize: 4 },
    };
    expect(effectiveMaxPartySize(overridden)).toBe(4);
  });

  it('設定が無ければ対象席の最大定員を使う', () => {
    expect(effectiveMaxPartySize(stateWith([table('tb1', 2), table('tb2', 6)]))).toBe(6);
  });

  it('対象外の席は最大定員に数えない', () => {
    const state = stateWith([table('tb1', 2), table('tb2', 6, false)]);
    expect(effectiveMaxPartySize(state)).toBe(2);
  });

  it('対象席が 1 つも無ければ 0（受付できない）', () => {
    expect(effectiveMaxPartySize(stateWith([]))).toBe(0);
  });
});

describe('更新のヘルパー', () => {
  it('withTable は対象の席だけを差し替える', () => {
    const state = stateWith([table('tb1', 2), table('tb2', 4)]);
    const updated = withTable(state, { ...table('tb1', 2), capacity: 3 });
    expect(findTable(updated, 'tb1')?.capacity).toBe(3);
    expect(findTable(updated, 'tb2')?.capacity).toBe(4);
  });

  it('withTable は元の状態を壊さない', () => {
    const state = stateWith([table('tb1', 2)]);
    withTable(state, { ...table('tb1', 2), capacity: 9 });
    expect(findTable(state, 'tb1')?.capacity).toBe(2);
  });

  it('withTicket は対象のチケットだけを差し替える', () => {
    const state = stateWith([], [ticket('t1'), ticket('t2')]);
    const updated = withTicket(state, { ...ticket('t1'), state: 'CALLED' });
    expect(findTicket(updated, 't1')?.state).toBe('CALLED');
    expect(findTicket(updated, 't2')?.state).toBe('WAITING');
  });

  it('withTicket は元の状態を壊さない', () => {
    const state = stateWith([], [ticket('t1')]);
    withTicket(state, { ...ticket('t1'), state: 'DONE' });
    expect(findTicket(state, 't1')?.state).toBe('WAITING');
  });

  it('存在しない ID を渡しても何も起きない（新規追加はしない）', () => {
    const state = stateWith([], [ticket('t1')]);
    const updated = withTicket(state, ticket('nope'));
    expect(updated.tickets).toHaveLength(1);
  });
});

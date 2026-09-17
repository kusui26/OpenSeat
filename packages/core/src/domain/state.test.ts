import { describe, expect, it } from 'vitest';
import type { Timestamp } from '../time.js';
import { DEFAULT_POLICY } from './policy.js';
import { createTable, type Table } from './table.js';
import { createTicket, type Ticket } from './ticket.js';
import {
  CODE_SPACE_SIZE,
  activeTickets,
  allocateTicketCode,
  queuedTickets,
  sameTable,
  sameTicket,
  sameVenueState,
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

describe('状態の比較', () => {
  const base = stateWith([table('tb1', 2), table('tb2', 4)], [ticket('t1'), ticket('t2')]);

  describe('sameTable', () => {
    it('同じ内容なら真', () => {
      expect(sameTable(table('tb1', 2), table('tb1', 2))).toBe(true);
    });

    it('定員が違えば偽', () => {
      expect(sameTable(table('tb1', 2), table('tb1', 4))).toBe(false);
    });

    it('状態が違えば偽', () => {
      const free = { ...table('tb1', 2), status: 'FREE' as const };
      expect(sameTable(free, table('tb1', 2))).toBe(false);
    });

    it('タグの中身が違えば偽', () => {
      const tagged = { ...table('tb1', 2), tags: ['power'] };
      expect(sameTable(tagged, table('tb1', 2))).toBe(false);
    });

    it('タグの順序が違えば偽（並びも内容のうちとして扱う）', () => {
      const a = { ...table('tb1', 2), tags: ['power', 'window'] };
      const b = { ...table('tb1', 2), tags: ['window', 'power'] };
      expect(sameTable(a, b)).toBe(false);
    });
  });

  describe('sameTicket', () => {
    it('同じ内容なら真', () => {
      expect(sameTicket(ticket('t1'), ticket('t1'))).toBe(true);
    });

    it('状態が違えば偽', () => {
      expect(sameTicket(ticket('t1', 'WAITING'), ticket('t1', 'PAUSED'))).toBe(false);
    });

    it('回数が違えば偽', () => {
      expect(sameTicket({ ...ticket('t1'), extensions: 1 }, ticket('t1'))).toBe(false);
    });

    it('時刻が違えば偽', () => {
      expect(sameTicket({ ...ticket('t1'), seatedAt: 1 }, ticket('t1'))).toBe(false);
    });
  });

  describe('sameVenueState', () => {
    it('同じ内容なら真（別のオブジェクトでも）', () => {
      const other = stateWith([table('tb1', 2), table('tb2', 4)], [ticket('t1'), ticket('t2')]);
      expect(sameVenueState(base, other)).toBe(true);
    });

    it('席が 1 つでも違えば偽', () => {
      const changed = stateWith([table('tb1', 3), table('tb2', 4)], [ticket('t1'), ticket('t2')]);
      expect(sameVenueState(base, changed)).toBe(false);
    });

    it('チケットが増えれば偽', () => {
      const more = stateWith(base.tables, [...base.tickets, ticket('t3')]);
      expect(sameVenueState(base, more)).toBe(false);
    });

    it('並び順が違えば偽（tick は並びを変えない前提）', () => {
      const reordered = stateWith(base.tables, [ticket('t2'), ticket('t1')]);
      expect(sameVenueState(base, reordered)).toBe(false);
    });

    it('採番カウンタが違えば偽', () => {
      expect(sameVenueState(base, { ...base, nextCodeSeq: 1 })).toBe(false);
    });

    it('運用の状態が違えば偽', () => {
      expect(sameVenueState(base, { ...base, operating: true })).toBe(false);
    });

    it('設定が別のオブジェクトなら偽（apply と tick は設定を作り直さない）', () => {
      const recreated = { ...base, policy: { ...DEFAULT_POLICY } };
      expect(sameVenueState(base, recreated)).toBe(false);
    });

    it('設定が同じ参照なら真', () => {
      expect(sameVenueState(base, { ...base })).toBe(true);
    });

    it('呼び出しの知らせの記録が違えば偽（同じ知らせを繰り返さないため）', () => {
      const reminded: Ticket = { ...ticket('k1'), holdRemindedAt: NOW };
      expect(sameTicket(ticket('k1'), reminded)).toBe(false);
    });

    it('保留の起点が違えば偽（保留の合計時間の計算に効くため）', () => {
      const paused: Ticket = { ...ticket('k1'), pausedSince: NOW };
      expect(sameTicket(ticket('k1'), paused)).toBe(false);
    });
  });
});

describe('queuedTickets（待ち行列の長さ・7.16 の max_queue_length）', () => {
  it('待っている人・保留の人・呼び出し中の人を数える', () => {
    const state = stateWith(
      [],
      [ticket('k1', 'WAITING'), ticket('k2', 'PAUSED'), ticket('k3', 'CALLED')],
    );
    expect(queuedTickets(state).map((item) => item.id)).toEqual(['k1', 'k2', 'k3']);
  });

  it('着席した人は行列から出ているので数えない', () => {
    const state = stateWith([], [ticket('k1', 'SEATED')]);
    expect(queuedTickets(state)).toEqual([]);
  });

  it.each(['DONE', 'CANCELLED', 'NO_SHOW', 'EXPIRED'] as const)('終わった %s は数えない', (ended) => {
    expect(queuedTickets(stateWith([], [ticket('k1', ended)]))).toEqual([]);
  });

  it('保留の人を数えるので、保留に逃げても行列の上限は緩まない', () => {
    const paused = Array.from({ length: 3 }, (_unused, index) => ticket(`k${index}`, 'PAUSED'));
    expect(queuedTickets(stateWith([], paused))).toHaveLength(3);
  });
});

describe('allocateTicketCode（表示コードの採番）', () => {
  it('誰も居なければカウンタどおりのコードを返す', () => {
    expect(allocateTicketCode(stateWith([]))).toEqual({ code: 'A-01', nextSeq: 1 });
  });

  it('使用中のコードは飛ばす', () => {
    const inUse: Ticket = { ...ticket('k1', 'WAITING'), code: 'A-01' };
    expect(allocateTicketCode(stateWith([], [inUse]))).toEqual({ code: 'A-02', nextSeq: 2 });
  });

  it('終わったチケットのコードは再利用する（生きている分だけが一意であればよい）', () => {
    const ended: Ticket = { ...ticket('k1', 'DONE'), code: 'A-01' };
    expect(allocateTicketCode(stateWith([], [ended]))).toEqual({ code: 'A-01', nextSeq: 1 });
  });

  it('連続する使用中のコードをまとめて飛ばす', () => {
    const inUse = ['A-01', 'A-02', 'A-03'].map((code, index) => ({
      ...ticket(`k${index}`, 'WAITING'),
      code,
    }));
    expect(allocateTicketCode(stateWith([], inUse))?.code).toBe('A-04');
  });

  it('生きているチケットが全コードを使っていれば null を返す', () => {
    const everyCode = Array.from({ length: CODE_SPACE_SIZE }, (_unused, seq) => ({
      ...ticket(`k${seq}`, 'WAITING'),
      code: ticketCodeFor(seq),
    }));
    expect(allocateTicketCode(stateWith([], everyCode))).toBeNull();
  });

  it('一巡したあとも、空いているコードを見つける', () => {
    const base = stateWith([], [{ ...ticket('k1', 'WAITING'), code: 'A-01' }]);
    const wrapped: VenueState = { ...base, nextCodeSeq: CODE_SPACE_SIZE - 1 };
    expect(allocateTicketCode(wrapped)).toEqual({ code: 'Z-99', nextSeq: CODE_SPACE_SIZE });
  });
});

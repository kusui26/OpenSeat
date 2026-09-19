import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type NoShowPolicy, type Policy } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import { createTicket, type Ticket } from '../domain/ticket.js';
import { createVenueState, type VenueState } from '../domain/state.js';
import { minutes, type Timestamp } from '../time.js';
import {
  evaluateTableGuard,
  evaluateTicketGuard,
  ticketGuardIsImplemented,
  unimplementedTableGuards,
  unimplementedTicketGuards,
  type TableGuardContext,
  type TicketGuardContext,
} from './guards.js';
import { TICKET_GUARDS, TICKET_TRANSITIONS, type TicketGuard } from './ticket-machine.js';
import { matching } from './transit.js';

const NOW: Timestamp = 1_700_000_000_000;

function venue(policy: Policy = DEFAULT_POLICY): VenueState {
  return {
    ...createVenueState({ venueId: 'v1', policy, tables: [] }),
    operating: true,
    joinOpen: true,
  };
}

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return { ...createTicket({ id: 'k1', code: 'A-01', partySize: 2, now: NOW }), ...overrides };
}

function table(capacity: number, tags: readonly string[] = []): Table {
  return { ...createTable({ id: 'tb', label: 'tb', capacity, now: NOW, tags }), status: 'FREE' };
}

function context(overrides: Partial<TicketGuardContext> = {}): TicketGuardContext {
  return { state: venue(), ticket: ticket(), now: NOW, table: null, ...overrides };
}

function holds(guard: TicketGuard, overrides: Partial<TicketGuardContext> = {}): boolean {
  return evaluateTicketGuard(context(overrides), guard);
}

describe('実装の進み具合', () => {
  /**
   * 残っているガードの数を明示して、増えないようにする。
   * PR 12 でここが空になる（`ticket-machine.ts` の冒頭の約束）。
   */
  /**
   * **宣言されたガードがすべて実装された。**
   *
   * `ticket-machine.ts` の冒頭が「PR 12 で閉じる」と約束していたもので、
   * 着席時間の上限（`hardLimitMode`）と確認要の自動解放（`autoFreeEnabled`）が
   * 入ったこの版で 0 になった。**ここが空でなくなったら、遷移が黙って
   * 通らなくなっている**ので、ガードを足したら必ず実装すること。
   */
  it('チケットのガードは 10 個すべてが実装済み', () => {
    expect(unimplementedTicketGuards()).toEqual([]);
  });

  it('席のガードは 3 個すべてが実装済み', () => {
    expect(unimplementedTableGuards()).toEqual([]);
  });

  it('実装済みかどうかの判定は、宣言されたすべてのガードについて答えられる', () => {
    for (const guard of TICKET_GUARDS) {
      expect(typeof ticketGuardIsImplemented(guard)).toBe('boolean');
    }
  });

  /**
   * いまは未実装のガードが無いので、この検査は空振りする。**仕掛けは残す。**
   * 遷移を足してガードを書き忘れたときに、黙って通らないための備えである。
   */
  it('実装されていないガードは成立しない（書き忘れた遷移を黙って通さない）', () => {
    for (const guard of unimplementedTicketGuards()) {
      expect(holds(guard)).toBe(false);
    }
  });

  it('hardLimitMode は hard モードのときだけ成立する（7.10）', () => {
    for (const mode of ['off', 'soft', 'hard'] as const) {
      const state = venue({ ...DEFAULT_POLICY, timeLimitMode: mode });
      expect(holds('hardLimitMode', { state })).toBe(mode === 'hard');
    }
  });

  it('autoFreeEnabled は自動解放が設定されているときだけ成立する（7.11 の 5 層目）', () => {
    const on = { state: venue(DEFAULT_POLICY), table: table(4), now: NOW };
    const off = {
      state: venue({ ...DEFAULT_POLICY, needsCheckAutoFreeMin: null }),
      table: table(4),
      now: NOW,
    };
    expect(evaluateTableGuard(on, 'autoFreeEnabled')).toBe(true);
    expect(evaluateTableGuard(off, 'autoFreeEnabled')).toBe(false);
  });
});

describe('fitsCapacity（7.6）', () => {
  it('人数が定員に収まれば成立する', () => {
    expect(holds('fitsCapacity', { table: table(2) })).toBe(true);
  });

  it('定員を超えれば成立しない', () => {
    expect(holds('fitsCapacity', { ticket: ticket({ partySize: 3 }), table: table(2) })).toBe(false);
  });

  it('希望タグを満たさなければ成立しない', () => {
    const wheelchair = ticket({ requiredTags: ['wheelchair'] });
    expect(holds('fitsCapacity', { ticket: wheelchair, table: table(4) })).toBe(false);
    expect(holds('fitsCapacity', { ticket: wheelchair, table: table(4, ['wheelchair']) })).toBe(true);
  });

  it('対象の席が渡されていなければ成立しない', () => {
    expect(holds('fitsCapacity', { table: null })).toBe(false);
  });
});

describe('underExtensionLimit（7.7 の 4）', () => {
  it('まだ上限に達していなければ成立する', () => {
    expect(holds('underExtensionLimit', { ticket: ticket({ extensions: 0 }) })).toBe(true);
  });

  it('上限ちょうどでは成立しない（既定は 1 回）', () => {
    expect(holds('underExtensionLimit', { ticket: ticket({ extensions: 1 }) })).toBe(false);
  });

  it('設定を上げればその分だけ成立する', () => {
    const state = venue({ ...DEFAULT_POLICY, maxExtensions: 3 });
    expect(holds('underExtensionLimit', { state, ticket: ticket({ extensions: 2 }) })).toBe(true);
    expect(holds('underExtensionLimit', { state, ticket: ticket({ extensions: 3 }) })).toBe(false);
  });
});

describe('ノーショーの 3 方針（7.7 の 6）', () => {
  const noShowGuards: readonly TicketGuard[] = [
    'requeueOnNoShow',
    'requeueToBackOnNoShow',
    'finalNoShow',
  ];

  /**
   * **どの組み合わせでも、成立するガードはちょうど 1 つ。**
   *
   * 2 つ以上成立すると、遷移表の行の並び順で行き先が変わってしまう。
   * 0 個なら期限が切れても誰も進めず、席が確保されたままになる。
   */
  it.each([
    ['cancel', 0],
    ['cancel', 1],
    ['requeue_once', 0],
    ['requeue_once', 1],
    ['requeue_once', 5],
    ['requeue_back', 0],
    ['requeue_back', 2],
  ] as const)('%s・%i 回目では、成立するガードがちょうど 1 つ', (noShowPolicy, noShows) => {
    const state = venue({ ...DEFAULT_POLICY, noShowPolicy });
    const target = ticket({ noShows });
    const satisfied = noShowGuards.filter((guard) => holds(guard, { state, ticket: target }));
    expect(satisfied).toHaveLength(1);
  });

  it.each([
    ['cancel', 0, 'finalNoShow'],
    ['requeue_once', 0, 'requeueOnNoShow'],
    ['requeue_once', 1, 'finalNoShow'],
    ['requeue_back', 3, 'requeueToBackOnNoShow'],
  ] as const)('%s・%i 回目では %s が成立する', (noShowPolicy: NoShowPolicy, noShows, expected) => {
    const state = venue({ ...DEFAULT_POLICY, noShowPolicy });
    expect(holds(expected, { state, ticket: ticket({ noShows }) })).toBe(true);
  });

  it('遷移表のホールド期限切れの行は、この 3 つのガードだけを使う', () => {
    const rows = matching(TICKET_TRANSITIONS, 'CALLED', 'HOLD_EXPIRE');
    expect(rows.map((row) => row.guard).sort()).toEqual([...noShowGuards].sort());
  });
});

describe('noNotificationChannel（7.9）', () => {
  it('通知手段を持たない人には成立する', () => {
    expect(holds('noNotificationChannel', { ticket: ticket({ hasNotificationChannel: false }) })).toBe(true);
  });

  it('通知手段を持つ人には成立しない', () => {
    expect(holds('noNotificationChannel', { ticket: ticket({ hasNotificationChannel: true }) })).toBe(false);
  });

  /**
   * **ガードは時間を見ない。** 「接続が切れてから何分たったか」は期限
   * （`abandonedAt`）が表す。ガードが時刻も見ると、期限をその期限の時刻で
   * 処理したときに境界で食い違う。
   */
  it('接続が切れてからの時間には依らない', () => {
    const fresh = ticket({ lastSeenAt: NOW, hasNotificationChannel: false });
    expect(holds('noNotificationChannel', { ticket: fresh, now: NOW })).toBe(true);
    expect(holds('noNotificationChannel', { ticket: fresh, now: NOW + minutes(120) })).toBe(true);
  });
});

describe('isAssignedTable（7.8 の 1 行目）', () => {
  it('自分に割り当てられた席なら成立する', () => {
    const called = ticket({ state: 'CALLED', tableId: 'tb' });
    expect(holds('isAssignedTable', { ticket: called, table: table(4) })).toBe(true);
  });

  it('別の席なら成立しない（案内は PR 9 の座席 QR の分岐）', () => {
    const called = ticket({ state: 'CALLED', tableId: 'other' });
    expect(holds('isAssignedTable', { ticket: called, table: table(4) })).toBe(false);
  });

  it('席を持たない人には成立しない', () => {
    expect(holds('isAssignedTable', { table: table(4) })).toBe(false);
  });

  it('読み取った席が渡されていなければ成立しない', () => {
    const called = ticket({ state: 'CALLED', tableId: 'tb' });
    expect(holds('isAssignedTable', { ticket: called, table: null })).toBe(false);
  });
});

describe('席のガード（7.6 のエッジケース）', () => {
  function tableContext(disableAfterCurrent: boolean): TableGuardContext {
    return { state: venue(), table: { ...table(4), disableAfterCurrent }, now: NOW };
  }

  it('対象外の予約があれば disableAfterCurrent が成立する', () => {
    expect(evaluateTableGuard(tableContext(true), 'disableAfterCurrent')).toBe(true);
    expect(evaluateTableGuard(tableContext(true), 'stillManaged')).toBe(false);
  });

  it('予約が無ければ stillManaged が成立する', () => {
    expect(evaluateTableGuard(tableContext(false), 'stillManaged')).toBe(true);
    expect(evaluateTableGuard(tableContext(false), 'disableAfterCurrent')).toBe(false);
  });

  it('2 つはつねに排他（片付けの猶予の行き先が 1 つに決まる）', () => {
    for (const reserved of [true, false]) {
      const context = tableContext(reserved);
      const satisfied = (['stillManaged', 'disableAfterCurrent'] as const).filter((guard) =>
        evaluateTableGuard(context, guard),
      );
      expect(satisfied).toHaveLength(1);
    }
  });
});

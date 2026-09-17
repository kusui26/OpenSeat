import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import type { Ticket } from '../domain/ticket.js';
import { createVenueState, findTable, findTicket, type VenueState } from '../domain/state.js';
import type { Decision } from '../decision.js';
import type { Result } from '../result.js';
import { minutes, type Timestamp } from '../time.js';
import { apply } from './apply.js';
import type { Command } from './command.js';
import type { DomainEvent, DomainEventType } from './events.js';
import type { Rejection, RejectionCode } from './rejection.js';
import { tick } from './tick.js';

/**
 * 着席と退席（全体プラン 7.8 の 1 行目、7.11 の 1 層目）。
 *
 * **この PR で基本の循環が閉じる。** 受付 → 割当 → 呼び出し → 着席 → 退席 →
 * 再割当。座席 QR の残りの分岐（別の席を読んだ、席が塞がっていた、飛び込み）は
 * PR 9 で扱う。
 */

const NOW: Timestamp = 1_700_000_000_000;

function at(elapsedMin: number): Timestamp {
  return NOW + minutes(elapsedMin);
}

function table(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE', ...overrides };
}

/** 運用中で受付を開いている施設。 */
function venue(policy: Policy = DEFAULT_POLICY, tables: readonly Table[] = [table('tb-4', 4)]): VenueState {
  return { ...createVenueState({ venueId: 'v1', policy, tables }), operating: true, joinOpen: true };
}

type Outcome = Result<Decision<VenueState, DomainEvent>, Rejection>;

function expectOk(result: Outcome): Decision<VenueState, DomainEvent> {
  if (!result.ok) throw new Error(`拒否された: ${result.error.code} ${result.error.describe}`);
  return result.value;
}

function expectRejected(result: Outcome, code: RejectionCode): Rejection {
  if (result.ok) throw new Error(`拒否されるはずが通った: ${JSON.stringify(result.value.events)}`);
  expect(result.error.code).toBe(code);
  return result.error;
}

function join(state: VenueState, id: string, partySize: number, now: Timestamp = NOW): VenueState {
  return expectOk(
    apply(
      state,
      { type: 'JOIN', ticketId: id, partySize, requiredTags: [], hasNotificationChannel: true },
      now,
    ),
  ).state;
}

function run(state: VenueState, command: Command, now: Timestamp): VenueState {
  return expectOk(apply(state, command, now)).state;
}

function advance(state: VenueState, now: Timestamp): VenueState {
  return expectOk(tick(state, now)).state;
}

function ticketOf(state: VenueState, id: string): Ticket {
  const found = findTicket(state, id);
  if (found === undefined) throw new Error(`チケットが無い: ${id}`);
  return found;
}

function tableOf(state: VenueState, id: string): Table {
  const found = findTable(state, id);
  if (found === undefined) throw new Error(`席が無い: ${id}`);
  return found;
}

function eventTypes(decided: Decision<VenueState, DomainEvent>): readonly DomainEventType[] {
  return decided.events.map((event) => event.type);
}

// ---------------------------------------------------------------------------

describe('一周を通す（1 卓・1 人）', () => {
  it('受付 → 呼び出し → 着席 → 退席 → 空席、まで通る', () => {
    // 受付。空席があるのでその場で呼び出される。
    let state = join(venue(), 'k1', 4);
    expect(ticketOf(state, 'k1').state).toBe('CALLED');
    expect(tableOf(state, 'tb-4').status).toBe('HELD');

    // 席の QR を読んで着席。
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(3));
    expect(ticketOf(state, 'k1').state).toBe('SEATED');
    expect(tableOf(state, 'tb-4').status).toBe('OCCUPIED');

    // 退席。片付けの猶予は既定 0 分なので、その場で空席に戻る。
    state = run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(40));
    expect(ticketOf(state, 'k1').state).toBe('DONE');
    expect(ticketOf(state, 'k1').endReason).toBe('checked_out');
    expect(tableOf(state, 'tb-4').status).toBe('FREE');
  });

  it('一周のイベントが順に出る', () => {
    const called = join(venue(), 'k1', 4);
    const seated = expectOk(apply(called, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(3)));
    const left = expectOk(apply(seated.state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(40)));

    expect(eventTypes(seated)).toEqual(['TicketSeated', 'TableOccupied']);
    expect(eventTypes(left)).toEqual(['TicketEnded', 'TableVacated', 'TableFreed']);
  });

  it('着席の時刻が記録され、ホールドの期限は外れる', () => {
    const called = join(venue(), 'k1', 4);
    const seated = run(called, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(3));
    const ticket = ticketOf(seated, 'k1');
    expect(ticket.seatedAt).toBe(at(3));
    expect(ticket.holdDeadline).toBeNull();
    expect(ticket.holdRemindedAt).toBeNull();
    expect(ticket.tableId).toBe('tb-4');
  });

  it('着席してもホールドの期限切れは起きない', () => {
    const called = join(venue(), 'k1', 4);
    const seated = run(called, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(3));
    expect(ticketOf(advance(seated, at(60)), 'k1').state).toBe('SEATED');
  });

  it('退席すると席との結びつきが外れる', () => {
    let state = join(venue(), 'k1', 4);
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(3));
    state = run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(40));
    expect(ticketOf(state, 'k1').tableId).toBeNull();
    expect(tableOf(state, 'tb-4').occupantTicketId).toBeNull();
  });
});

describe('着席の確認（7.8 の 1 行目）', () => {
  const called = join(venue(), 'k1', 4);

  it('別の席を読み取ったら拒否される', () => {
    const twoTables = join(venue(DEFAULT_POLICY, [table('tb-4', 4), table('tb-2', 2)]), 'k1', 4);
    // 4 名なので tb-4 に案内されている。tb-2 を読んでも着席できない。
    expect(ticketOf(twoTables, 'k1').tableId).toBe('tb-4');
    const failure = expectRejected(
      apply(twoTables, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-2' }, at(1)),
      'BLOCKED_BY_GUARD',
    );
    expect(failure.describe).toContain('isAssignedTable');
  });

  it('存在しない席を読み取ったら拒否される', () => {
    expectRejected(
      apply(called, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'missing' }, at(1)),
      'TABLE_NOT_FOUND',
    );
  });

  it('呼び出されていない人は着席できない', () => {
    const crowded = venue(DEFAULT_POLICY, [table('tb-4', 4, { status: 'OCCUPIED_UNKNOWN' })]);
    const queued = join(crowded, 'k1', 4);
    expect(ticketOf(queued, 'k1').state).toBe('WAITING');
    expectRejected(
      apply(queued, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(1)),
      'NOT_ALLOWED_IN_STATE',
    );
  });

  it('二度着席することはできない', () => {
    const seated = run(called, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(3));
    expectRejected(
      apply(seated, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(4)),
      'NOT_ALLOWED_IN_STATE',
    );
  });

  it('存在しないチケットでは着席できない', () => {
    expectRejected(
      apply(called, { type: 'CHECK_IN', ticketId: 'missing', tableId: 'tb-4' }, at(1)),
      'TICKET_NOT_FOUND',
    );
  });
});

describe('退席の申告（7.8、7.11 の 1 層目）', () => {
  function seated(policy: Policy = DEFAULT_POLICY): VenueState {
    const called = join(venue(policy), 'k1', 4);
    return run(called, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(3));
  }

  it('席の読み取りを求めない（画面のボタンだけで済む）', () => {
    const left = run(seated(), { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(40));
    expect(ticketOf(left, 'k1').state).toBe('DONE');
  });

  it('スタッフの申告は staff_checkout として記録される', () => {
    const left = run(seated(), { type: 'CHECK_OUT', ticketId: 'k1', by: 'staff' }, at(40));
    expect(ticketOf(left, 'k1').endReason).toBe('staff_checkout');
  });

  it('スタッフの申告に理由は要らない（取り消しと違い、不利益にならない）', () => {
    expect(apply(seated(), { type: 'CHECK_OUT', ticketId: 'k1', by: 'staff' }, at(40)).ok).toBe(true);
  });

  it('着席していない人は退席できない', () => {
    const called = join(venue(), 'k1', 4);
    expectRejected(
      apply(called, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(1)),
      'NOT_ALLOWED_IN_STATE',
    );
  });

  it('二度退席することはできない', () => {
    const left = run(seated(), { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(40));
    expectRejected(
      apply(left, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(41)),
      'NOT_ALLOWED_IN_STATE',
    );
  });

  it('退席した時点で「空席であることを確かめた時刻」が更新される', () => {
    const before = seated();
    expect(tableOf(before, 'tb-4').verifiedFreeAt).toBeNull();

    const left = run(before, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(40));
    expect(tableOf(left, 'tb-4').verifiedFreeAt).toBe(at(40));
  });
});

describe('片付けの猶予（7.6 の turnover_min）', () => {
  function afterCheckOut(turnoverMin: number): VenueState {
    const policy: Policy = { ...DEFAULT_POLICY, turnoverMin };
    const called = join(venue(policy), 'k1', 4);
    const seated = run(called, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(3));
    return run(seated, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(40));
  }

  /**
   * 猶予 0 分は **本当に 0 分**。`tick` を待たずにその場で空席へ戻る。
   * 席の期限は「設備の都合の待ち」なので、ちょうどで終わらせている（`time.ts`）。
   */
  it('猶予が 0 分なら、退席したその場で空席に戻る', () => {
    expect(tableOf(afterCheckOut(0), 'tb-4').status).toBe('FREE');
  });

  it('猶予が 1 分なら、1 分間は片付け中のまま', () => {
    const cleaning = afterCheckOut(1);
    expect(tableOf(cleaning, 'tb-4').status).toBe('TURNOVER');
    expect(tableOf(advance(cleaning, at(40.5)), 'tb-4').status).toBe('TURNOVER');
  });

  it('猶予が明ければ空席に戻る', () => {
    const cleaning = afterCheckOut(1);
    expect(tableOf(advance(cleaning, at(41)), 'tb-4').status).toBe('FREE');
  });

  it('片付け中の席は次の人に割り当てられない', () => {
    let state = afterCheckOut(1);
    state = join(state, 'k2', 4, at(41 - 1));
    expect(ticketOf(state, 'k2').state).toBe('WAITING');

    state = advance(state, at(41));
    expect(ticketOf(state, 'k2').state).toBe('CALLED');
  });

  it('猶予が明けたことをイベントで知らせる', () => {
    const cleaning = afterCheckOut(1);
    const decided = expectOk(tick(cleaning, at(41)));
    expect(eventTypes(decided)).toEqual(['TableFreed']);
    expect(decided.events[0]).toMatchObject({ tableId: 'tb-4', releasedTicketId: null });
  });

  it('猶予のあいだに待っている人が居ても、順番は保たれる', () => {
    let state = afterCheckOut(1);
    state = join(state, 'k2', 2, at(40.2));
    state = join(state, 'k3', 4, at(40.4));
    state = advance(state, at(41));
    // 4 名席なので、ロス最小の 4 名組が案内される（7.6）。
    expect(ticketOf(state, 'k3').state).toBe('CALLED');
    expect(ticketOf(state, 'k2').state).toBe('WAITING');
  });
});

describe('退席した席が次の人へ渡る', () => {
  it('退席と同時に、待っていた人が呼ばれる', () => {
    let state = join(venue(), 'k1', 4);
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(3));
    state = join(state, 'k2', 3, at(5));
    expect(ticketOf(state, 'k2').state).toBe('WAITING');

    const decided = expectOk(apply(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(40)));
    expect(ticketOf(decided.state, 'k2').state).toBe('CALLED');
    expect(tableOf(decided.state, 'tb-4').status).toBe('HELD');
    expect(eventTypes(decided)).toEqual([
      'TicketEnded',
      'TableVacated',
      'TableFreed',
      'TicketCalled',
      'TableHeld',
    ]);
  });

  it('席が循環する（2 人が順に使う）', () => {
    let state = join(venue(), 'k1', 4);
    state = join(state, 'k2', 2, at(1));
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(3));
    state = run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(40));
    state = run(state, { type: 'CHECK_IN', ticketId: 'k2', tableId: 'tb-4' }, at(42));
    state = run(state, { type: 'CHECK_OUT', ticketId: 'k2', by: 'user' }, at(75));

    expect(ticketOf(state, 'k1').state).toBe('DONE');
    expect(ticketOf(state, 'k2').state).toBe('DONE');
    expect(tableOf(state, 'tb-4').status).toBe('FREE');
    expect(tableOf(state, 'tb-4').verifiedFreeAt).toBe(at(75));
  });
});

describe('退席の確認が席の並び順に効く（7.6）', () => {
  /**
   * 同じ定員の席が 2 つあるとき、**退席が新しく確認された席を先に埋める**。
   * 長く「空席」のままの席は、ピーク時ほど無断利用されている可能性が高いため。
   */
  it('退席したばかりの席が、ずっと空いていた席より先に案内される', () => {
    const tables = [table('tb-a', 4), table('tb-b', 4)];
    let state = venue(DEFAULT_POLICY, tables);

    // k1 を tb-a へ案内して着席させ、退席させる。tb-a の退席確認が新しくなる。
    state = join(state, 'k1', 4);
    const assigned = ticketOf(state, 'k1').tableId;
    expect(assigned).not.toBeNull();
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: assigned ?? '' }, at(1));
    state = run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(30));

    // 次の人は、退席が確認されたばかりの席へ案内される。
    state = join(state, 'k2', 4, at(31));
    expect(ticketOf(state, 'k2').tableId).toBe(assigned);
  });

  it('一度も確認されていない席は、もっとも古いものとして扱われる', () => {
    const tables = [table('tb-old', 4), table('tb-new', 4, { verifiedFreeAt: NOW })];
    const state = join(venue(DEFAULT_POLICY, tables), 'k1', 4);
    expect(ticketOf(state, 'k1').tableId).toBe('tb-new');
  });
});

describe('対象外にする操作の保留（7.6 のエッジケース）', () => {
  function vacatingWithPendingDisable(): VenueState {
    const policy: Policy = { ...DEFAULT_POLICY, turnoverMin: 1 };
    let state = join(venue(policy), 'k1', 4);
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(3));
    // 利用中に「対象外にする」を予約する（操作そのものは Phase 2 の管理画面）。
    state = {
      ...state,
      tables: state.tables.map((item) => ({ ...item, disableAfterCurrent: true })),
    };
    return run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(40));
  }

  it('利用が終わるまでは対象のまま（呼び出し中の人に影響させない）', () => {
    const cleaning = vacatingWithPendingDisable();
    expect(tableOf(cleaning, 'tb-4').status).toBe('TURNOVER');
    expect(tableOf(cleaning, 'tb-4').enabled).toBe(true);
  });

  it('片付けの猶予が明けると、空席ではなく対象外になる', () => {
    const disabled = advance(vacatingWithPendingDisable(), at(41));
    const item = tableOf(disabled, 'tb-4');
    expect(item.status).toBe('DISABLED');
    expect(item.enabled).toBe(false);
    expect(item.disableAfterCurrent).toBe(false);
  });

  it('対象外になったことをイベントで知らせる', () => {
    const decided = expectOk(tick(vacatingWithPendingDisable(), at(41)));
    expect(eventTypes(decided)).toEqual(['TableDisabled']);
  });

  it('対象外になった席は、待っている人に割り当てられない', () => {
    let state = vacatingWithPendingDisable();
    state = join(state, 'k2', 4, at(40.5));
    state = advance(state, at(41));
    expect(ticketOf(state, 'k2').state).toBe('WAITING');
  });
});

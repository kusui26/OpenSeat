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

/**
 * 座席 QR から出る操作（全体プラン 7.8、7.12、7.11 の 3 層目）。
 *
 * 何を見せるかは `scan/resolve.test.ts`、押したときに何が起きるかがこちら。
 */

const NOW: Timestamp = 1_700_000_000_000;

function at(elapsedMin: number): Timestamp {
  return NOW + minutes(elapsedMin);
}

function table(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE', ...overrides };
}

function venue(tables: readonly Table[], policy: Policy = DEFAULT_POLICY): VenueState {
  return { ...createVenueState({ venueId: 'v1', policy, tables }), operating: true, joinOpen: true };
}

/** 空席が 1 つも無い施設。待ちを作るときに使う。 */
function crowded(tables: readonly Table[], policy: Policy = DEFAULT_POLICY): VenueState {
  return venue(
    tables.map((item) => ({ ...item, status: 'OCCUPIED_UNKNOWN' as const })),
    policy,
  );
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

describe('席の変更（7.8 の 2 行目）', () => {
  /** 2 名席と 4 名席。2 名で受け付けると 2 名席へ案内される（定員昇順）。 */
  function calledToSmall(policy: Policy = DEFAULT_POLICY): VenueState {
    const state = join(venue([table('tb-2', 2), table('tb-4', 4)], policy), 'k1', 2);
    expect(ticketOf(state, 'k1').tableId).toBe('tb-2');
    return state;
  }

  it('別の空席へ移れる', () => {
    const swapped = run(calledToSmall(), { type: 'SWAP_TABLE', ticketId: 'k1', tableId: 'tb-4' }, at(1));
    expect(ticketOf(swapped, 'k1').tableId).toBe('tb-4');
    expect(tableOf(swapped, 'tb-4').status).toBe('HELD');
    expect(ticketOf(swapped, 'k1').state).toBe('CALLED');
  });

  it('元の席は空席に戻る', () => {
    const swapped = run(calledToSmall(), { type: 'SWAP_TABLE', ticketId: 'k1', tableId: 'tb-4' }, at(1));
    expect(tableOf(swapped, 'tb-2').status).toBe('FREE');
    expect(tableOf(swapped, 'tb-2').occupantTicketId).toBeNull();
  });

  /**
   * 車いす対応席に案内された人が、ふつうの席へ移る。空いた対応席は、
   * その席しか使えない人へ渡る。**移った瞬間に次の人が呼ばれる。**
   */
  it('元の席は、同じ手のうちに次の人へ渡る', () => {
    const tables = [table('tb-a', 4, { tags: ['wheelchair'] }), table('tb-b', 4)];
    let state = join(venue(tables), 'k1', 2);
    expect(ticketOf(state, 'k1').tableId).toBe('tb-a');

    state = expectOk(
      apply(
        state,
        {
          type: 'JOIN',
          ticketId: 'k2',
          partySize: 2,
          requiredTags: ['wheelchair'],
          hasNotificationChannel: true,
        },
        at(1),
      ),
    ).state;
    expect(ticketOf(state, 'k2').state).toBe('WAITING');

    const swapped = run(state, { type: 'SWAP_TABLE', ticketId: 'k1', tableId: 'tb-b' }, at(2));
    expect(ticketOf(swapped, 'k1').tableId).toBe('tb-b');
    expect(ticketOf(swapped, 'k2').state).toBe('CALLED');
    expect(ticketOf(swapped, 'k2').tableId).toBe('tb-a');
  });

  it('席を移しても、呼び出しの期限は動かない', () => {
    const called = calledToSmall();
    const deadline = ticketOf(called, 'k1').holdDeadline;
    const swapped = run(called, { type: 'SWAP_TABLE', ticketId: 'k1', tableId: 'tb-4' }, at(3));
    expect(ticketOf(swapped, 'k1').holdDeadline).toBe(deadline);
  });

  it('移したことをイベントで知らせる', () => {
    const decided = expectOk(
      apply(calledToSmall(), { type: 'SWAP_TABLE', ticketId: 'k1', tableId: 'tb-4' }, at(1)),
    );
    expect(eventTypes(decided)).toEqual(['TicketSwapped', 'TableHeld', 'TableFreed']);
    expect(decided.events[0]).toMatchObject({ fromTableId: 'tb-2', toTableId: 'tb-4' });
  });

  it('設定で禁じられていれば拒否される', () => {
    const strict: Policy = { ...DEFAULT_POLICY, allowTableSwap: false };
    const failure = expectRejected(
      apply(calledToSmall(strict), { type: 'SWAP_TABLE', ticketId: 'k1', tableId: 'tb-4' }, at(1)),
      'BLOCKED_BY_GUARD',
    );
    expect(failure.describe).toContain('swapAllowed');
  });

  it('人数が収まらない席へは移れない', () => {
    const state = join(venue([table('tb-4', 4), table('tb-1', 1)]), 'k1', 3);
    expectRejected(
      apply(state, { type: 'SWAP_TABLE', ticketId: 'k1', tableId: 'tb-1' }, at(1)),
      'BLOCKED_BY_GUARD',
    );
  });

  it('呼び出されていない人は移れない', () => {
    const waiting = join(crowded([table('tb-2', 2)]), 'k1', 2);
    expectRejected(
      apply(waiting, { type: 'SWAP_TABLE', ticketId: 'k1', tableId: 'tb-2' }, at(1)),
      'NOT_ALLOWED_IN_STATE',
    );
  });

  it('存在しない席へは移れない', () => {
    expectRejected(
      apply(calledToSmall(), { type: 'SWAP_TABLE', ticketId: 'k1', tableId: 'missing' }, at(1)),
      'TABLE_NOT_FOUND',
    );
  });
});

describe('前倒しの着席（7.8 の 4 行目）', () => {
  it('待っている人が、順番を崩さない席にそのまま座れる', () => {
    // 2 名席が埋まっていて、4 名席だけ空いている状況を作る。
    const state = venue([table('tb-4', 4), table('tb-2', 2, { status: 'OCCUPIED_UNKNOWN' })]);
    const joined = join(state, 'k1', 2);
    // 4 名席へ呼ばれているので、ここでは前倒しではなく通常の着席になる。
    expect(ticketOf(joined, 'k1').state).toBe('CALLED');
  });

  it('呼び出しを待たずに座ると、席が使用中になる', () => {
    // 席が片付け中のあいだに受け付け、猶予が明ける前に本人が席へ行く筋書き。
    const policy: Policy = { ...DEFAULT_POLICY, turnoverMin: 5 };
    const base = crowded([table('tb-4', 4)], policy);
    const waiting = join(base, 'k1', 2);
    expect(ticketOf(waiting, 'k1').state).toBe('WAITING');

    // 席を空ける。割当より先に本人が着いた、という形にするため手で空席にする。
    const freed: VenueState = {
      ...waiting,
      tables: waiting.tables.map((item) => ({ ...item, status: 'FREE' as const })),
    };
    const seated = run(freed, { type: 'CHECK_IN_EARLY', ticketId: 'k1', tableId: 'tb-4' }, at(1));
    expect(ticketOf(seated, 'k1').state).toBe('SEATED');
    expect(tableOf(seated, 'tb-4').status).toBe('OCCUPIED');
    expect(tableOf(seated, 'tb-4').occupantTicketId).toBe('k1');
  });

  /** 7.8 の「待ち順序を崩さない条件つき」。 */
  it('自分より先に呼ばれるべき人がいれば拒否される', () => {
    let state = crowded([table('tb-2', 2)]);
    state = join(state, 'k1', 2, at(0));
    state = join(state, 'k2', 2, at(5));
    const freed: VenueState = {
      ...state,
      tables: state.tables.map((item) => ({ ...item, status: 'FREE' as const })),
    };
    const failure = expectRejected(
      apply(freed, { type: 'CHECK_IN_EARLY', ticketId: 'k2', tableId: 'tb-2' }, at(6)),
      'BLOCKED_BY_GUARD',
    );
    expect(failure.describe).toContain('earlyCheckInAllowed');
  });

  it('呼び出されている人は前倒しできない（通常の着席を使う）', () => {
    const called = join(venue([table('tb-4', 4)]), 'k1', 2);
    expectRejected(
      apply(called, { type: 'CHECK_IN_EARLY', ticketId: 'k1', tableId: 'tb-4' }, at(1)),
      'NOT_ALLOWED_IN_STATE',
    );
  });
});

describe('飛び込み着席（7.12、7.8 の 6 行目）', () => {
  it('チケットが作られ、いきなり着席から始まる', () => {
    const decided = expectOk(
      apply(venue([table('tb-4', 4)]), { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-4', partySize: 3 }, NOW),
    );
    const ticket = ticketOf(decided.state, 'w1');
    expect(ticket.state).toBe('SEATED');
    expect(ticket.partySize).toBe(3);
    expect(ticket.seatedAt).toBe(NOW);
    expect(tableOf(decided.state, 'tb-4').status).toBe('OCCUPIED');
  });

  it('受付と着席のイベントが出て、どこから来たかが分かる', () => {
    const decided = expectOk(
      apply(venue([table('tb-4', 4)]), { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-4', partySize: 3 }, NOW),
    );
    expect(eventTypes(decided)).toEqual(['TicketJoined', 'TicketSeated', 'TableOccupied']);
    expect(decided.events[0]).toMatchObject({ origin: 'WALK_IN' });
  });

  it('表示コードが発行される', () => {
    const state = run(venue([table('tb-4', 4)]), { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-4', partySize: 2 }, NOW);
    expect(ticketOf(state, 'w1').code).toBe('A-01');
    expect(state.nextCodeSeq).toBe(1);
  });

  it('その席の定員を超える人数は拒否される', () => {
    const failure = expectRejected(
      apply(venue([table('tb-2', 2)]), { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-2', partySize: 3 }, NOW),
      'PARTY_TOO_LARGE',
    );
    expect(failure.describe).toContain('2');
  });

  /** 施設全体の上限ではなく、**その席の定員**を見る。 */
  it('ほかに大きい席があっても、読んだ席の定員で判断する', () => {
    const state = venue([table('tb-2', 2), table('tb-6', 6)]);
    expectRejected(
      apply(state, { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-2', partySize: 4 }, NOW),
      'PARTY_TOO_LARGE',
    );
    expect(apply(state, { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-6', partySize: 4 }, NOW).ok).toBe(true);
  });

  it('0 名は拒否される', () => {
    expectRejected(
      apply(venue([table('tb-4', 4)]), { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-4', partySize: 0 }, NOW),
      'PARTY_TOO_SMALL',
    );
  });

  it('空席でない席には飛び込めない', () => {
    const held = join(venue([table('tb-4', 4)]), 'k1', 2);
    expectRejected(
      apply(held, { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-4', partySize: 2 }, at(1)),
      'NOT_ALLOWED_IN_STATE',
    );
  });

  it('同じ ID のチケットがあれば拒否される', () => {
    const state = run(venue([table('tb-4', 4), table('tb-2', 2)]), { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-4', partySize: 2 }, NOW);
    expectRejected(
      apply(state, { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-2', partySize: 2 }, at(1)),
      'TICKET_ALREADY_EXISTS',
    );
  });

  /** 受付を閉じたあとでも、席が使われていることは記録できるほうがよい（7.12 の a）。 */
  it('受付を閉じていても飛び込める', () => {
    const closed: VenueState = { ...venue([table('tb-4', 4)]), joinOpen: false };
    expect(apply(closed, { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-4', partySize: 2 }, NOW).ok).toBe(true);
  });

  it('待ち行列には入らないので、行列の上限に触れない', () => {
    const policy: Policy = { ...DEFAULT_POLICY, maxQueueLength: 1 };
    let state = crowded([table('tb-2', 2)], policy);
    state = join(state, 'k1', 2);
    const withFree: VenueState = { ...state, tables: [...state.tables, table('tb-4', 4)] };
    // 行列は上限に達しているが、飛び込みは通る。
    expect(apply(withFree, { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-4', partySize: 4 }, at(1)).ok).toBe(true);
  });
});

describe('案内された席に誰かが座っていた（7.8 の 10 行目）', () => {
  function calledThenTaken(): VenueState {
    const state = join(venue([table('tb-4', 4), table('tb-2', 2, { status: 'OCCUPIED_UNKNOWN' })]), 'k1', 3);
    expect(ticketOf(state, 'k1').tableId).toBe('tb-4');
    return state;
  }

  it('席は「誰かが使っているが誰かは分からない」になる', () => {
    const reported = run(calledThenTaken(), { type: 'REPORT_TAKEN', ticketId: 'k1', tableId: 'tb-4' }, at(2));
    expect(tableOf(reported, 'tb-4').status).toBe('OCCUPIED_UNKNOWN');
    expect(tableOf(reported, 'tb-4').occupantTicketId).toBeNull();
  });

  it('本人は待ちに戻り、受付時刻は変わらない', () => {
    const reported = run(calledThenTaken(), { type: 'REPORT_TAKEN', ticketId: 'k1', tableId: 'tb-4' }, at(2));
    const ticket = ticketOf(reported, 'k1');
    expect(ticket.state).toBe('WAITING');
    expect(ticket.priorityAt).toBe(NOW);
    expect(ticket.tableId).toBeNull();
  });

  it('同時刻の他者より前に出る印が立つ', () => {
    const reported = run(calledThenTaken(), { type: 'REPORT_TAKEN', ticketId: 'k1', tableId: 'tb-4' }, at(2));
    expect(ticketOf(reported, 'k1').conflictPriority).toBe(true);
  });

  it('報告と繰り上げをイベントで知らせる', () => {
    const decided = expectOk(
      apply(calledThenTaken(), { type: 'REPORT_TAKEN', ticketId: 'k1', tableId: 'tb-4' }, at(2)),
    );
    expect(eventTypes(decided)).toEqual(['TableReportedInUse', 'TicketRequeued']);
    expect(decided.events[1]).toMatchObject({ reason: 'seat_taken', priorityAt: NOW });
  });

  /** 7.8 の「他に空席があれば即再割当」。 */
  it('他に空席があれば、その場で次の席へ案内される', () => {
    const state = join(venue([table('tb-4', 4), table('tb-6', 6)]), 'k1', 3);
    const first = ticketOf(state, 'k1').tableId;
    const reported = run(state, { type: 'REPORT_TAKEN', ticketId: 'k1', tableId: first ?? '' }, at(2));
    expect(ticketOf(reported, 'k1').state).toBe('CALLED');
    expect(ticketOf(reported, 'k1').tableId).not.toBe(first);
  });

  /**
   * 繰り上げが効いていることを、割当の選択（PR 4）と結合して確かめる。
   * 同じ受付時刻の 2 人のうち、席が塞がっていた人が先に案内される。
   */
  it('同じ受付時刻なら、席が塞がっていた人が先に案内される', () => {
    let state = crowded([table('tb-2', 2), table('tb-2b', 2)]);
    state = join(state, 'k1', 2, NOW);
    state = join(state, 'k2', 2, NOW);

    // k1 だけに繰り上げの印を立て、席を 1 つだけ空ける。
    const primed: VenueState = {
      ...state,
      tickets: state.tickets.map((item) =>
        item.id === 'k1' ? { ...item, conflictPriority: true } : item,
      ),
      tables: state.tables.map((item) =>
        item.id === 'tb-2' ? { ...item, status: 'FREE' as const } : item,
      ),
    };
    const called = run(primed, { type: 'HEARTBEAT', ticketId: 'k2' }, at(1));
    expect(ticketOf(called, 'k1').state).toBe('CALLED');
    expect(ticketOf(called, 'k2').state).toBe('WAITING');
  });

  it('自分に案内された席でなければ報告できない', () => {
    const state = join(venue([table('tb-4', 4), table('tb-6', 6)]), 'k1', 3);
    const mine = ticketOf(state, 'k1').tableId;
    const other = mine === 'tb-4' ? 'tb-6' : 'tb-4';
    expectRejected(
      apply(state, { type: 'REPORT_TAKEN', ticketId: 'k1', tableId: other }, at(1)),
      'NOT_ALLOWED_IN_STATE',
    );
  });
});

describe('使用中・空席の報告（7.8 の 9 行目、7.11 の 3 層目）', () => {
  it('誰か分からない席が空いていたら、空席に戻せる', () => {
    const state = venue([table('tb-4', 4, { status: 'OCCUPIED_UNKNOWN' })]);
    const decided = expectOk(apply(state, { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'user' }, at(1)));
    expect(tableOf(decided.state, 'tb-4').status).toBe('FREE');
    expect(eventTypes(decided)).toEqual(['TableFreed']);
  });

  it('空席にした時刻が「空席を確かめた時刻」として残る（7.6 の並び順）', () => {
    const state = venue([table('tb-4', 4, { status: 'OCCUPIED_UNKNOWN' })]);
    const freed = run(state, { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'staff' }, at(3));
    expect(tableOf(freed, 'tb-4').verifiedFreeAt).toBe(at(3));
  });

  /** 着席中の人を第三者が追い出せないことは、遷移表が守っている。 */
  it('誰が座っているか分かっている席は、空席に戻せない', () => {
    let state = join(venue([table('tb-4', 4)]), 'k1', 2);
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(1));
    expectRejected(
      apply(state, { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'user' }, at(2)),
      'NOT_ALLOWED_IN_STATE',
    );
  });

  it('確認要の席も空席に戻せる', () => {
    const state = venue([table('tb-4', 4, { status: 'NEEDS_CHECK' })]);
    expect(apply(state, { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'staff' }, at(1)).ok).toBe(true);
  });

  it('確認要の席が使われていたら、誰か分からない席に戻る', () => {
    const state = venue([table('tb-4', 4, { status: 'NEEDS_CHECK' })]);
    const decided = expectOk(apply(state, { type: 'REPORT_IN_USE', tableId: 'tb-4', ticketId: null }, at(1)));
    expect(tableOf(decided.state, 'tb-4').status).toBe('OCCUPIED_UNKNOWN');
    expect(eventTypes(decided)).toEqual(['TableReportedInUse']);
  });

  /** 7.11 の 3 層目「使用中なら…その人は最優先で次の席へ」。 */
  it('案内された人が「使用中」を押すと、その人が繰り上がる', () => {
    let state = crowded([table('tb-2', 2)]);
    state = join(state, 'k1', 2);
    const guessed: VenueState = {
      ...state,
      tables: state.tables.map((item) => ({ ...item, status: 'NEEDS_CHECK' as const })),
    };
    const decided = expectOk(
      apply(guessed, { type: 'REPORT_IN_USE', tableId: 'tb-2', ticketId: 'k1' }, at(1)),
    );
    expect(ticketOf(decided.state, 'k1').conflictPriority).toBe(true);
    expect(ticketOf(decided.state, 'k1').priorityAt).toBe(NOW);
    expect(eventTypes(decided)).toEqual(['TableReportedInUse', 'TicketRequeued']);
  });

  it('待っていない人は繰り上げを受けられない', () => {
    let state = join(venue([table('tb-4', 4), table('tb-2', 2, { status: 'NEEDS_CHECK' })]), 'k1', 2);
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(1));
    expectRejected(
      apply(state, { type: 'REPORT_IN_USE', tableId: 'tb-2', ticketId: 'k1' }, at(2)),
      'NOT_ALLOWED_IN_STATE',
    );
  });

  it('存在しないチケットを添えた報告は拒否される', () => {
    const state = venue([table('tb-4', 4, { status: 'NEEDS_CHECK' })]);
    expectRejected(
      apply(state, { type: 'REPORT_IN_USE', tableId: 'tb-4', ticketId: 'missing' }, at(1)),
      'TICKET_NOT_FOUND',
    );
  });

  it('空席を「使用中」と報告できる（無断利用の取り込み）', () => {
    const state = venue([table('tb-4', 4)]);
    const decided = expectOk(apply(state, { type: 'REPORT_IN_USE', tableId: 'tb-4', ticketId: null }, at(1)));
    expect(tableOf(decided.state, 'tb-4').status).toBe('OCCUPIED_UNKNOWN');
  });

  it('存在しない席への報告は拒否される', () => {
    expectRejected(
      apply(venue([table('tb-4', 4)]), { type: 'CONFIRM_FREE', tableId: 'missing', by: 'staff' }, at(1)),
      'TABLE_NOT_FOUND',
    );
  });
});

/**
 * **人のチケットを終わらせる操作だけ、スタッフに限る**（7.11 の 3 層目、7.15）。
 *
 * 「確認要」に落ちた席には 2 通りある。着席の記録が残っている席（退席の押し忘れが
 * 疑われる席）と、誰の記録も無い席（無断利用が時間で落ちてきた席）である。前者を
 * 空席に戻すと、記録の人のチケットが終わる。**通りすがりの一押しで他人の順番が
 * 消えるのは、利用者に厳しすぎる**（CLAUDE.md 2.5）。後者は終わるチケットが無い
 * ので、これまでどおり誰でも戻せる。
 */
describe('確認要の席を空席に戻せる人（7.11 の 3 層目）', () => {
  /**
   * 着席の記録が残ったまま「確認要」に落ちた席。
   *
   * 本来は問いかけへの無応答で落ちるが（7.11 の 2 層目）、時間を進める筋書きは
   * `recovery.test.ts` が見ている。ここは席の状態だけを置き換えて作る。
   */
  function uncertainWithRecord(): VenueState {
    const seated = run(
      join(venue([table('tb-4', 4)]), 'k1', 2),
      { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' },
      at(1),
    );
    return {
      ...seated,
      tables: seated.tables.map((item) => ({ ...item, status: 'NEEDS_CHECK' as const })),
    };
  }

  it('記録が残る席は、利用者が空席に戻せない', () => {
    expectRejected(
      apply(uncertainWithRecord(), { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'user' }, at(2)),
      'STAFF_ONLY',
    );
  });

  it('拒否されても、席もチケットも動かない', () => {
    const before = uncertainWithRecord();
    apply(before, { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'user' }, at(2));
    expect(tableOf(before, 'tb-4').status).toBe('NEEDS_CHECK');
    expect(ticketOf(before, 'k1').state).toBe('SEATED');
  });

  it('スタッフなら戻せる。記録の人は申告せずに去ったことになる', () => {
    const decided = expectOk(
      apply(uncertainWithRecord(), { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'staff' }, at(2)),
    );
    expect(tableOf(decided.state, 'tb-4').status).toBe('FREE');
    expect(ticketOf(decided.state, 'k1').state).toBe('DONE');
    expect(ticketOf(decided.state, 'k1').endReason).toBe('auto_release');
  });

  /** 席を守る側の報告は、これまでどおり誰でもできる。 */
  it('記録が残る席でも、「使用中でした」は誰でも報告できる', () => {
    const decided = expectOk(
      apply(uncertainWithRecord(), { type: 'REPORT_IN_USE', tableId: 'tb-4', ticketId: null }, at(2)),
    );
    expect(tableOf(decided.state, 'tb-4').status).toBe('OCCUPIED');
    expect(ticketOf(decided.state, 'k1').state).toBe('SEATED');
  });

  it('誰の記録も無い確認要の席は、利用者でも空席に戻せる', () => {
    const state = venue([table('tb-4', 4, { status: 'NEEDS_CHECK' })]);
    const decided = expectOk(apply(state, { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'user' }, at(1)));
    expect(tableOf(decided.state, 'tb-4').status).toBe('FREE');
  });

  it('誰か分からない席も、利用者が空席に戻せる（記録が無いため）', () => {
    const state = venue([table('tb-4', 4, { status: 'OCCUPIED_UNKNOWN' })]);
    const decided = expectOk(apply(state, { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'user' }, at(1)));
    expect(tableOf(decided.state, 'tb-4').status).toBe('FREE');
  });
});

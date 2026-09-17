import { describe, expect, it } from 'vitest';
import type { Apply, Decision } from '../decision.js';
import { DEFAULT_POLICY, type Policy } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import { createTicket, type Ticket, type TicketState } from '../domain/ticket.js';
import { createVenueState, findTable, findTicket, type VenueState } from '../domain/state.js';
import type { Result } from '../result.js';
import { minutes, type Timestamp } from '../time.js';
import {
  apply,
  pauseDeadlineFor,
  remainingPauseBudget,
  tableTransition,
  ticketTransition,
} from './apply.js';
import type { Command } from './command.js';
import type { DomainEvent } from './events.js';
import type { Rejection, RejectionCode } from './rejection.js';

const NOW: Timestamp = 1_700_000_000_000;

/** NOW から何分後か。時刻を直書きせず、経過が読めるようにする。 */
function at(elapsedMin: number): Timestamp {
  return NOW + minutes(elapsedMin);
}

function table(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE', ...overrides };
}

/** 運用中で受付を開いている施設。席は 2 名・4 名の 2 卓。 */
function venue(overrides: Partial<VenueState> = {}, policy: Policy = DEFAULT_POLICY): VenueState {
  const base = createVenueState({
    venueId: 'v1',
    policy,
    tables: [table('tb-2', 2), table('tb-4', 4)],
  });
  return { ...base, operating: true, joinOpen: true, ...overrides };
}

function expectOk(result: Result<Decision<VenueState, DomainEvent>, Rejection>): Decision<VenueState, DomainEvent> {
  if (!result.ok) throw new Error(`拒否された: ${result.error.code} ${result.error.describe}`);
  return result.value;
}

function expectRejected(
  result: Result<Decision<VenueState, DomainEvent>, Rejection>,
  code: RejectionCode,
): Rejection {
  if (result.ok) throw new Error(`拒否されるはずが通った: ${JSON.stringify(result.value.events)}`);
  expect(result.error.code).toBe(code);
  return result.error;
}

/** 受付を 1 件通す。以降のテストの土台。 */
function join(
  state: VenueState,
  id: string,
  partySize: number,
  now: Timestamp = NOW,
  extra: Partial<Omit<Command & { type: 'JOIN' }, 'type' | 'ticketId' | 'partySize'>> = {},
): VenueState {
  return expectOk(
    apply(
      state,
      {
        type: 'JOIN',
        ticketId: id,
        partySize,
        requiredTags: [],
        hasNotificationChannel: false,
        ...extra,
      },
      now,
    ),
  ).state;
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

/** 呼び出し済みの状態を手で作る。呼び出しの実装は PR 6 なので、ここでは前提として置く。 */
function called(state: VenueState, ticketId: string, tableId: string, now: Timestamp = NOW): VenueState {
  const ticket = ticketOf(state, ticketId);
  return {
    ...state,
    tickets: state.tickets.map((item) =>
      item.id === ticketId
        ? { ...item, state: 'CALLED' as const, tableId, calledAt: now, holdDeadline: now + minutes(7) }
        : item,
    ),
    tables: state.tables.map((item) =>
      item.id === tableId
        ? { ...item, status: 'HELD' as const, statusSince: now, occupantTicketId: ticket.id }
        : item,
    ),
  };
}

// ---------------------------------------------------------------------------

describe('apply の骨格', () => {
  it('Apply の形（拒否されうるコマンドの適用）をしている', () => {
    const shape: Apply<VenueState, Command, DomainEvent, Rejection> = apply;
    expect(typeof shape).toBe('function');
  });

  it('拒否されたとき、渡した状態は一切変わらない', () => {
    const state = join(venue(), 'k1', 2);
    const snapshot = structuredClone(state);
    expectRejected(apply(state, { type: 'PAUSE', ticketId: 'missing' }, NOW), 'TICKET_NOT_FOUND');
    expect(state).toEqual(snapshot);
  });

  it('成功したとき、渡した状態は一切変わらない（新しい状態を返す）', () => {
    const state = join(venue(), 'k1', 2);
    const snapshot = structuredClone(state);
    const next = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, NOW)).state;
    expect(state).toEqual(snapshot);
    expect(next).not.toBe(state);
  });

  it('設定は作り直さない（同じ参照のまま渡る）', () => {
    const state = venue();
    const next = join(state, 'k1', 2);
    expect(next.policy).toBe(state.policy);
  });

  it('出口の不変条件の検査は飛ばせない。壊れた状態にはどのコマンドも通らない', () => {
    // 同じ ID のチケットが 2 枚ある状態。unique_ids が破れている。
    const base = join(venue(), 'k1', 2);
    const broken: VenueState = { ...base, tickets: [...base.tickets, ...base.tickets] };
    const failure = expectRejected(
      apply(broken, { type: 'HEARTBEAT', ticketId: 'k1' }, at(1)),
      'INVARIANT_VIOLATED',
    );
    expect(failure.describe).toContain('unique_ids');
  });

  it('壊れた状態を渡しても、壊れた状態が書き戻されることはない', () => {
    const base = join(venue(), 'k1', 2);
    const broken: VenueState = { ...base, tickets: [...base.tickets, ...base.tickets] };
    const result = apply(broken, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: null }, at(1));
    expect(result.ok).toBe(false);
  });
});

describe('遷移の段（手順 2・3）', () => {
  const state = join(venue(), 'k1', 2);
  const waiting = ticketOf(state, 'k1');

  it('表にある無条件の遷移は通る', () => {
    const moved = ticketTransition(state, waiting, 'PAUSE', NOW);
    expect(moved.ok && moved.value).toBe('PAUSED');
  });

  it('表に無い組み合わせは NOT_ALLOWED_IN_STATE で拒否される', () => {
    const moved = ticketTransition(state, waiting, 'CHECK_OUT', NOW);
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error.code).toBe('NOT_ALLOWED_IN_STATE');
  });

  it('判定がまだ書かれていないガードは、通らずに GUARD_NOT_IMPLEMENTED になる', () => {
    const held = ticketOf(called(state, 'k1', 'tb-2'), 'k1');
    const moved = ticketTransition(state, held, 'EXTEND', NOW);
    expect(moved.ok).toBe(false);
    if (!moved.ok) {
      expect(moved.error.code).toBe('GUARD_NOT_IMPLEMENTED');
      expect(moved.error.describe).toContain('underExtensionLimit');
    }
  });

  it('席の遷移も同じ手順を通る', () => {
    const held = called(state, 'k1', 'tb-2');
    const moved = tableTransition(held, tableOf(held, 'tb-2'), 'RELEASE', NOW);
    expect(moved.ok && moved.value).toBe('FREE');
  });

  it('席の表に無い組み合わせも拒否される', () => {
    const moved = tableTransition(state, tableOf(state, 'tb-2'), 'CHECK_OUT', NOW);
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error.code).toBe('NOT_ALLOWED_IN_STATE');
  });
});

// ---------------------------------------------------------------------------

describe('受付（7.5）', () => {
  it('受け付けると WAITING のチケットが 1 枚できる', () => {
    const decided = expectOk(
      apply(
        venue(),
        { type: 'JOIN', ticketId: 'k1', partySize: 3, requiredTags: [], hasNotificationChannel: false },
        NOW,
      ),
    );
    const ticket = ticketOf(decided.state, 'k1');
    expect(ticket.state).toBe('WAITING');
    expect(ticket.partySize).toBe(3);
    expect(ticket.priorityAt).toBe(NOW);
    expect(ticket.createdAt).toBe(NOW);
  });

  it('表示コードが採番され、カウンタが 1 つ進む', () => {
    const next = join(venue(), 'k1', 2);
    expect(ticketOf(next, 'k1').code).toBe('A-01');
    expect(next.nextCodeSeq).toBe(1);
  });

  it('続けて受け付けると別のコードになる', () => {
    const next = join(join(venue(), 'k1', 2), 'k2', 2, at(1));
    expect(ticketOf(next, 'k2').code).toBe('A-02');
  });

  it('受付のイベントを出す', () => {
    const decided = expectOk(
      apply(
        venue(),
        { type: 'JOIN', ticketId: 'k1', partySize: 2, requiredTags: [], hasNotificationChannel: false },
        NOW,
      ),
    );
    expect(decided.events).toEqual([
      { type: 'TicketJoined', at: NOW, ticketId: 'k1', code: 'A-01', partySize: 2 },
    ]);
  });

  it('希望タグと通知手段はそのまま記録される', () => {
    const next = join(venue(), 'k1', 2, NOW, {
      requiredTags: ['wheelchair'],
      hasNotificationChannel: true,
    });
    const ticket = ticketOf(next, 'k1');
    expect(ticket.requiredTags).toEqual(['wheelchair']);
    expect(ticket.hasNotificationChannel).toBe(true);
  });

  it('この PR では受付だけで、呼び出しは起きない（割当の実行は PR 6）', () => {
    const next = join(venue(), 'k1', 2);
    expect(ticketOf(next, 'k1').state).toBe('WAITING');
    expect(tableOf(next, 'tb-2').status).toBe('FREE');
  });

  it('同じ ID で二度受け付けようとすると拒否される', () => {
    const state = join(venue(), 'k1', 2);
    expectRejected(
      apply(
        state,
        { type: 'JOIN', ticketId: 'k1', partySize: 2, requiredTags: [], hasNotificationChannel: false },
        at(1),
      ),
      'TICKET_ALREADY_EXISTS',
    );
  });
});

describe('受付の検証 — 人数（7.5 の 1）', () => {
  function joinWith(partySize: number, state: VenueState = venue()) {
    return apply(
      state,
      { type: 'JOIN', ticketId: 'k1', partySize, requiredTags: [], hasNotificationChannel: false },
      NOW,
    );
  }

  it('0 名は拒否される', () => {
    expectRejected(joinWith(0), 'PARTY_TOO_SMALL');
  });

  it('負の人数は拒否される', () => {
    expectRejected(joinWith(-1), 'PARTY_TOO_SMALL');
  });

  it('1 名は通る（下限ちょうど）', () => {
    expect(joinWith(1).ok).toBe(true);
  });

  it('対象席の最大定員ちょうど（4 名）は通る', () => {
    expect(joinWith(4).ok).toBe(true);
  });

  it('最大定員 +1（5 名）は拒否され、上限が理由に出る', () => {
    const failure = expectRejected(joinWith(5), 'PARTY_TOO_LARGE');
    expect(failure.describe).toContain('4');
  });

  it('整数でない人数は拒否される', () => {
    expectRejected(joinWith(2.5), 'PARTY_SIZE_INVALID');
    expectRejected(joinWith(Number.NaN), 'PARTY_SIZE_INVALID');
  });

  it('maxPartySize を設定すれば席の定員より小さい上限にできる', () => {
    const capped = venue({}, { ...DEFAULT_POLICY, maxPartySize: 2 });
    expect(joinWith(2, capped).ok).toBe(true);
    expectRejected(joinWith(3, capped), 'PARTY_TOO_LARGE');
  });

  it('対象席が 1 つも無ければ、誰も受け付けられない', () => {
    const noTables = venue({ tables: [] });
    expectRejected(joinWith(1, noTables), 'PARTY_TOO_LARGE');
  });

  it('対象外の席は最大人数の計算に入らない', () => {
    const onlySmall = venue({ tables: [table('tb-2', 2), table('tb-8', 8, { enabled: false })] });
    expectRejected(joinWith(5, onlySmall), 'PARTY_TOO_LARGE');
  });
});

describe('受付の検証 — 受付の開閉と待ちの上限（7.5 の 1）', () => {
  it('受付を閉じていれば拒否される', () => {
    const closed = venue({ joinOpen: false });
    expectRejected(
      apply(
        closed,
        { type: 'JOIN', ticketId: 'k1', partySize: 2, requiredTags: [], hasNotificationChannel: false },
        NOW,
      ),
      'JOIN_CLOSED',
    );
  });

  it('待ちが上限に達していれば拒否される', () => {
    const policy: Policy = { ...DEFAULT_POLICY, maxQueueLength: 2 };
    const full = join(join(venue({}, policy), 'k1', 2), 'k2', 2, at(1));
    expectRejected(
      apply(
        full,
        { type: 'JOIN', ticketId: 'k3', partySize: 2, requiredTags: [], hasNotificationChannel: false },
        at(2),
      ),
      'QUEUE_FULL',
    );
  });

  it('上限の 1 つ手前までは受け付ける（境界）', () => {
    const policy: Policy = { ...DEFAULT_POLICY, maxQueueLength: 2 };
    const state = join(venue({}, policy), 'k1', 2);
    expect(
      apply(
        state,
        { type: 'JOIN', ticketId: 'k2', partySize: 2, requiredTags: [], hasNotificationChannel: false },
        at(1),
      ).ok,
    ).toBe(true);
  });

  it('取り消した人は行列から外れるので、また受け付けられる', () => {
    const policy: Policy = { ...DEFAULT_POLICY, maxQueueLength: 1 };
    const state = join(venue({}, policy), 'k1', 2);
    const cancelled = expectOk(
      apply(state, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: 'leaving' }, at(1)),
    ).state;
    expect(
      apply(
        cancelled,
        { type: 'JOIN', ticketId: 'k2', partySize: 2, requiredTags: [], hasNotificationChannel: false },
        at(2),
      ).ok,
    ).toBe(true);
  });

  it('人数の誤りは、受付を閉じているかどうかより先に返る（入力の誤りが先）', () => {
    const closed = venue({ joinOpen: false });
    expectRejected(
      apply(
        closed,
        { type: 'JOIN', ticketId: 'k1', partySize: 0, requiredTags: [], hasNotificationChannel: false },
        NOW,
      ),
      'PARTY_TOO_SMALL',
    );
  });

  it('同じ ID の再送は、受付を閉じたあとでも「すでにある」と返る', () => {
    const state = join(venue(), 'k1', 2);
    const closed: VenueState = { ...state, joinOpen: false };
    expectRejected(
      apply(
        closed,
        { type: 'JOIN', ticketId: 'k1', partySize: 2, requiredTags: [], hasNotificationChannel: false },
        at(1),
      ),
      'TICKET_ALREADY_EXISTS',
    );
  });
});

// ---------------------------------------------------------------------------

describe('取り消し（7.9）', () => {
  it('WAITING から取り消せる', () => {
    const state = join(venue(), 'k1', 2);
    const next = expectOk(
      apply(state, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: 'found_seat' }, at(3)),
    ).state;
    const ticket = ticketOf(next, 'k1');
    expect(ticket.state).toBe('CANCELLED');
    expect(ticket.endReason).toBe('user_cancel');
    expect(ticket.endedAt).toBe(at(3));
  });

  it('PAUSED から取り消せる', () => {
    const paused = expectOk(
      apply(join(venue(), 'k1', 2), { type: 'PAUSE', ticketId: 'k1' }, at(1)),
    ).state;
    const next = expectOk(
      apply(paused, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: null }, at(4)),
    ).state;
    expect(ticketOf(next, 'k1').state).toBe('CANCELLED');
  });

  it('PAUSED から取り消すと、保留していた時間が合計に足される', () => {
    const paused = expectOk(apply(join(venue(), 'k1', 2), { type: 'PAUSE', ticketId: 'k1' }, NOW)).state;
    const next = expectOk(
      apply(paused, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: null }, at(6)),
    ).state;
    const ticket = ticketOf(next, 'k1');
    expect(ticket.pausedTotal).toBe(minutes(6));
    expect(ticket.pausedSince).toBeNull();
  });

  it('CALLED から取り消すと、席が即座に空席へ戻る', () => {
    const held = called(join(venue(), 'k1', 2), 'k1', 'tb-2', at(2));
    const decided = expectOk(
      apply(held, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: 'too_long' }, at(3)),
    );
    expect(tableOf(decided.state, 'tb-2').status).toBe('FREE');
    expect(tableOf(decided.state, 'tb-2').occupantTicketId).toBeNull();
    expect(ticketOf(decided.state, 'k1').tableId).toBeNull();
  });

  it('CALLED からの取り消しは、席が空いたことをイベントで知らせる', () => {
    const held = called(join(venue(), 'k1', 2), 'k1', 'tb-2', at(2));
    const decided = expectOk(
      apply(held, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: null }, at(3)),
    );
    expect(decided.events.map((event) => event.type)).toEqual(['TicketCancelled', 'TableFreed']);
  });

  it('席を空けても verifiedFreeAt は更新しない（誰も座っていないので確度は変わらない）', () => {
    const state = join(venue(), 'k1', 2);
    const held = called(state, 'k1', 'tb-2', at(2));
    const before = tableOf(held, 'tb-2').verifiedFreeAt;
    const next = expectOk(
      apply(held, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: null }, at(3)),
    ).state;
    expect(tableOf(next, 'tb-2').verifiedFreeAt).toBe(before);
  });

  it('SEATED からは取り消せない（着席後は退席で扱う）', () => {
    const state = join(venue(), 'k1', 2);
    const seated: VenueState = {
      ...state,
      tickets: state.tickets.map((item) => ({
        ...item,
        state: 'SEATED' as const,
        tableId: 'tb-2',
        seatedAt: NOW,
      })),
      tables: state.tables.map((item) =>
        item.id === 'tb-2' ? { ...item, status: 'OCCUPIED' as const, occupantTicketId: 'k1' } : item,
      ),
    };
    expectRejected(
      apply(seated, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: null }, at(5)),
      'NOT_ALLOWED_IN_STATE',
    );
  });

  it('終端に達したチケットは二度取り消せない', () => {
    const state = join(venue(), 'k1', 2);
    const cancelled = expectOk(
      apply(state, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: null }, at(1)),
    ).state;
    expectRejected(
      apply(cancelled, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: null }, at(2)),
      'NOT_ALLOWED_IN_STATE',
    );
  });

  it('スタッフの取り消しは staff_cancel として記録される', () => {
    const state = join(venue(), 'k1', 2);
    const next = expectOk(
      apply(state, { type: 'CANCEL', ticketId: 'k1', by: 'staff', reason: 'other' }, at(1)),
    ).state;
    expect(ticketOf(next, 'k1').endReason).toBe('staff_cancel');
  });

  it('スタッフの取り消しに理由が無ければ拒否される（監査のため）', () => {
    const state = join(venue(), 'k1', 2);
    expectRejected(
      apply(state, { type: 'CANCEL', ticketId: 'k1', by: 'staff', reason: null }, at(1)),
      'REASON_REQUIRED',
    );
  });

  it('本人の取り消しは理由が無くてもよい（任意選択）', () => {
    const state = join(venue(), 'k1', 2);
    expect(apply(state, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: null }, at(1)).ok).toBe(true);
  });

  it('選んだ理由はイベントに残る（統計に使う）', () => {
    const state = join(venue(), 'k1', 2);
    const decided = expectOk(
      apply(state, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: 'found_seat' }, at(1)),
    );
    expect(decided.events[0]).toMatchObject({ type: 'TicketCancelled', reason: 'found_seat' });
  });

  it('存在しないチケットは取り消せない', () => {
    expectRejected(
      apply(venue(), { type: 'CANCEL', ticketId: 'missing', by: 'user', reason: null }, NOW),
      'TICKET_NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------

describe('保留と準備OK（7.7 の 5〜7）', () => {
  it('保留に入ると PAUSED になり、期限が付く', () => {
    const state = join(venue(), 'k1', 2);
    const decided = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(2)));
    const ticket = ticketOf(decided.state, 'k1');
    expect(ticket.state).toBe('PAUSED');
    expect(ticket.pauseDeadline).toBe(at(2 + DEFAULT_POLICY.pauseStepMin));
    expect(ticket.pausedSince).toBe(at(2));
  });

  it('保留のイベントは期限を伝える（画面の残り時間の元になる）', () => {
    const state = join(venue(), 'k1', 2);
    const decided = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(2)));
    expect(decided.events).toEqual([
      { type: 'TicketPaused', at: at(2), ticketId: 'k1', until: at(12) },
    ]);
  });

  it('準備OKで WAITING に戻る', () => {
    const paused = expectOk(apply(join(venue(), 'k1', 2), { type: 'PAUSE', ticketId: 'k1' }, at(1))).state;
    const decided = expectOk(apply(paused, { type: 'READY', ticketId: 'k1' }, at(5)));
    expect(ticketOf(decided.state, 'k1').state).toBe('WAITING');
    expect(decided.events).toEqual([{ type: 'TicketResumed', at: at(5), ticketId: 'k1' }]);
  });

  it('保留と準備OKを往復しても順番（priorityAt）が変わらない', () => {
    const state = join(venue(), 'k1', 2);
    const original = ticketOf(state, 'k1').priorityAt;
    const paused = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(5))).state;
    const resumed = expectOk(apply(paused, { type: 'READY', ticketId: 'k1' }, at(20))).state;
    expect(ticketOf(paused, 'k1').priorityAt).toBe(original);
    expect(ticketOf(resumed, 'k1').priorityAt).toBe(original);
  });

  it('何度往復しても順番が変わらない', () => {
    let state = join(venue(), 'k1', 2);
    const original = ticketOf(state, 'k1').priorityAt;
    for (const round of [0, 1, 2]) {
      state = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(round * 10 + 1))).state;
      state = expectOk(apply(state, { type: 'READY', ticketId: 'k1' }, at(round * 10 + 3))).state;
    }
    expect(ticketOf(state, 'k1').priorityAt).toBe(original);
  });

  it('準備OKで保留していた時間が合計に足され、起点が消える', () => {
    const paused = expectOk(apply(join(venue(), 'k1', 2), { type: 'PAUSE', ticketId: 'k1' }, at(1))).state;
    const resumed = expectOk(apply(paused, { type: 'READY', ticketId: 'k1' }, at(8))).state;
    const ticket = ticketOf(resumed, 'k1');
    expect(ticket.pausedTotal).toBe(minutes(7));
    expect(ticket.pausedSince).toBeNull();
    expect(ticket.pauseDeadline).toBeNull();
  });

  it('保留の時間は往復のたびに積み上がる', () => {
    let state = join(venue(), 'k1', 2);
    state = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(0))).state;
    state = expectOk(apply(state, { type: 'READY', ticketId: 'k1' }, at(4))).state;
    state = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(10))).state;
    state = expectOk(apply(state, { type: 'READY', ticketId: 'k1' }, at(16))).state;
    expect(ticketOf(state, 'k1').pausedTotal).toBe(minutes(10));
  });

  it('WAITING でない人は準備OKにできない', () => {
    const state = join(venue(), 'k1', 2);
    expectRejected(apply(state, { type: 'READY', ticketId: 'k1' }, at(1)), 'NOT_ALLOWED_IN_STATE');
  });

  it('PAUSED の人をもう一度保留にはできない', () => {
    const paused = expectOk(apply(join(venue(), 'k1', 2), { type: 'PAUSE', ticketId: 'k1' }, at(1))).state;
    expectRejected(apply(paused, { type: 'PAUSE', ticketId: 'k1' }, at(2)), 'NOT_ALLOWED_IN_STATE');
  });

  it('表に無い遷移として、終端の DONE から保留にはできない', () => {
    const state = join(venue(), 'k1', 2);
    const done: VenueState = {
      ...state,
      tickets: state.tickets.map((item) => ({
        ...item,
        state: 'DONE' as const,
        endedAt: NOW,
        endReason: 'checked_out' as const,
      })),
    };
    expectRejected(apply(done, { type: 'PAUSE', ticketId: 'k1' }, at(1)), 'NOT_ALLOWED_IN_STATE');
  });
});

describe('保留の合計上限（7.16 の pause_max_total_min）', () => {
  const policy: Policy = { ...DEFAULT_POLICY, pauseStepMin: 10, pauseMaxTotalMin: 45 };

  it('残りが十分あれば 1 回分（10 分）だけ延びる', () => {
    const state = join(venue({}, policy), 'k1', 2);
    const paused = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(0))).state;
    expect(ticketOf(paused, 'k1').pauseDeadline).toBe(at(10));
  });

  it('残りが 1 回分に満たなければ、残りのぶんだけ延びる', () => {
    let state = join(venue({}, policy), 'k1', 2);
    state = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(0))).state;
    state = expectOk(apply(state, { type: 'READY', ticketId: 'k1' }, at(40))).state;
    const paused = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(50))).state;
    // 40 分使ったので残りは 5 分。10 分ではなく 5 分だけ延びる。
    expect(ticketOf(paused, 'k1').pauseDeadline).toBe(at(55));
  });

  it('使い切っていれば期限が現在時刻になる（次の tick で期限切れ）', () => {
    let state = join(venue({}, policy), 'k1', 2);
    state = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(0))).state;
    state = expectOk(apply(state, { type: 'READY', ticketId: 'k1' }, at(45))).state;
    const paused = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(60))).state;
    expect(ticketOf(paused, 'k1').pauseDeadline).toBe(at(60));
  });

  /**
   * ファズが見つけたこと。上限は期限という 1 つの仕掛けで守っているため、
   * 期限切れにする `tick`（PR 6）が走るまでのあいだは合計が上限を超えうる。
   * 実運用の `tick` は 10 秒ごとなので、超過はその範囲に収まる。
   */
  it('持ち時間を使い切ったあとも、期限切れになるまでは合計が上限を少し超えうる', () => {
    let state = join(venue({}, policy), 'k1', 2);
    state = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(0))).state;
    state = expectOk(apply(state, { type: 'READY', ticketId: 'k1' }, at(45))).state;
    // ここで持ち時間は尽きている。期限は即時になるが、tick が無ければ止まらない。
    state = expectOk(apply(state, { type: 'PAUSE', ticketId: 'k1' }, at(50))).state;
    expect(ticketOf(state, 'k1').pauseDeadline).toBe(at(50));

    state = expectOk(apply(state, { type: 'READY', ticketId: 'k1' }, at(51))).state;
    expect(ticketOf(state, 'k1').pausedTotal).toBe(minutes(46));
  });

  it('remainingPauseBudget は使った分を引いた残りを返す', () => {
    const ticket: Ticket = {
      ...createTicket({ id: 'k1', code: 'A-01', partySize: 2, now: NOW }),
      pausedTotal: minutes(30),
    };
    expect(remainingPauseBudget(ticket, policy)).toBe(minutes(15));
  });

  it('使いすぎていても残りは負にならない', () => {
    const ticket: Ticket = {
      ...createTicket({ id: 'k1', code: 'A-01', partySize: 2, now: NOW }),
      pausedTotal: minutes(90),
    };
    expect(remainingPauseBudget(ticket, policy)).toBe(0);
    expect(pauseDeadlineFor(ticket, policy, at(3))).toBe(at(3));
  });
});

// ---------------------------------------------------------------------------

describe('人数の変更（7.6 のエッジケース）', () => {
  it('減らすときは順番を保つ', () => {
    const state = join(venue(), 'k1', 4);
    const original = ticketOf(state, 'k1').priorityAt;
    const next = expectOk(
      apply(state, { type: 'CHANGE_PARTY_SIZE', ticketId: 'k1', partySize: 2 }, at(10)),
    ).state;
    const ticket = ticketOf(next, 'k1');
    expect(ticket.partySize).toBe(2);
    expect(ticket.priorityAt).toBe(original);
  });

  it('増やすときは順番を現在時刻にやり直す（1 名で登録して 4 名に変える抜け道を防ぐ）', () => {
    const state = join(venue(), 'k1', 1);
    const next = expectOk(
      apply(state, { type: 'CHANGE_PARTY_SIZE', ticketId: 'k1', partySize: 4 }, at(30)),
    ).state;
    const ticket = ticketOf(next, 'k1');
    expect(ticket.partySize).toBe(4);
    expect(ticket.priorityAt).toBe(at(30));
  });

  it('受付時刻（createdAt）は動かさない。絶対上限の起点は変わらない', () => {
    const state = join(venue(), 'k1', 1);
    const next = expectOk(
      apply(state, { type: 'CHANGE_PARTY_SIZE', ticketId: 'k1', partySize: 4 }, at(30)),
    ).state;
    expect(ticketOf(next, 'k1').createdAt).toBe(NOW);
  });

  it('変更のイベントは前後の人数と、やり直した順番を伝える', () => {
    const state = join(venue(), 'k1', 1);
    const decided = expectOk(
      apply(state, { type: 'CHANGE_PARTY_SIZE', ticketId: 'k1', partySize: 3 }, at(30)),
    );
    expect(decided.events).toEqual([
      { type: 'PartySizeChanged', at: at(30), ticketId: 'k1', from: 1, to: 3, priorityAt: at(30) },
    ]);
  });

  it('同じ人数への変更は何も起こさない（イベントも出ない）', () => {
    const state = join(venue(), 'k1', 2);
    const decided = expectOk(
      apply(state, { type: 'CHANGE_PARTY_SIZE', ticketId: 'k1', partySize: 2 }, at(10)),
    );
    expect(decided.events).toEqual([]);
    expect(ticketOf(decided.state, 'k1').priorityAt).toBe(NOW);
  });

  it('保留中でも変えられる（まだ待っている人なので）', () => {
    const paused = expectOk(apply(join(venue(), 'k1', 2), { type: 'PAUSE', ticketId: 'k1' }, at(1))).state;
    const next = expectOk(
      apply(paused, { type: 'CHANGE_PARTY_SIZE', ticketId: 'k1', partySize: 1 }, at(2)),
    ).state;
    expect(ticketOf(next, 'k1').partySize).toBe(1);
  });

  it('席が確保されている人は変えられない（定員を超えうるため）', () => {
    const held = called(join(venue(), 'k1', 2), 'k1', 'tb-2', at(1));
    expectRejected(
      apply(held, { type: 'CHANGE_PARTY_SIZE', ticketId: 'k1', partySize: 1 }, at(2)),
      'NOT_ALLOWED_IN_STATE',
    );
  });

  it('上限を超える人数には変えられない', () => {
    const state = join(venue(), 'k1', 2);
    expectRejected(
      apply(state, { type: 'CHANGE_PARTY_SIZE', ticketId: 'k1', partySize: 9 }, at(1)),
      'PARTY_TOO_LARGE',
    );
  });

  it('0 名には変えられない', () => {
    const state = join(venue(), 'k1', 2);
    expectRejected(
      apply(state, { type: 'CHANGE_PARTY_SIZE', ticketId: 'k1', partySize: 0 }, at(1)),
      'PARTY_TOO_SMALL',
    );
  });
});

// ---------------------------------------------------------------------------

describe('心拍（7.9 の「暗黙のキャンセル」）', () => {
  it('最後に見た時刻を更新する', () => {
    const state = join(venue(), 'k1', 2);
    const next = expectOk(apply(state, { type: 'HEARTBEAT', ticketId: 'k1' }, at(4))).state;
    expect(ticketOf(next, 'k1').lastSeenAt).toBe(at(4));
  });

  it('イベントを出さない（数秒ごとに届くため記録しない）', () => {
    const state = join(venue(), 'k1', 2);
    expect(expectOk(apply(state, { type: 'HEARTBEAT', ticketId: 'k1' }, at(4))).events).toEqual([]);
  });

  it('状態は変わらない', () => {
    const state = join(venue(), 'k1', 2);
    const next = expectOk(apply(state, { type: 'HEARTBEAT', ticketId: 'k1' }, at(4))).state;
    expect(ticketOf(next, 'k1').state).toBe('WAITING');
  });

  it.each(['WAITING', 'PAUSED', 'CALLED', 'SEATED'] as const)('生きている %s では受け付ける', (live) => {
    const state = join(venue(), 'k1', 2);
    const moved: VenueState = {
      ...state,
      tickets: state.tickets.map((item) => ({ ...item, state: live })),
    };
    const result = apply(moved, { type: 'HEARTBEAT', ticketId: 'k1' }, at(4));
    // 不変条件は状態ごとの時刻を要求するため、ここでは「状態のせいでは拒否されない」ことだけを見る。
    expect(result.ok || result.error.code !== 'NOT_ALLOWED_IN_STATE').toBe(true);
  });

  it('終わったチケットの心拍は拒否される', () => {
    const state = join(venue(), 'k1', 2);
    const done = expectOk(
      apply(state, { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: null }, at(1)),
    ).state;
    expectRejected(apply(done, { type: 'HEARTBEAT', ticketId: 'k1' }, at(2)), 'NOT_ALLOWED_IN_STATE');
  });

  it('存在しないチケットの心拍は拒否される', () => {
    expectRejected(apply(venue(), { type: 'HEARTBEAT', ticketId: 'missing' }, NOW), 'TICKET_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------

describe('表示コードの枯渇', () => {
  it('生きているチケットがコードを使い切っていれば受付を拒否する', () => {
    const base = venue();
    const everyCode: readonly Ticket[] = Array.from({ length: 2574 }, (_unused, seq) => ({
      ...createTicket({ id: `k${seq}`, code: '', partySize: 1, now: NOW }),
      code: codeFor(seq),
    }));
    const crowded: VenueState = {
      ...base,
      tickets: everyCode,
      policy: { ...DEFAULT_POLICY, maxQueueLength: 10_000 },
    };
    expectRejected(
      apply(
        crowded,
        { type: 'JOIN', ticketId: 'kx', partySize: 1, requiredTags: [], hasNotificationChannel: false },
        at(1),
      ),
      'NO_CODE_AVAILABLE',
    );
  });

  it('使用中のコードがあっても、空いているコードがあれば受け付ける', () => {
    const base = join(venue(), 'k1', 2);
    // カウンタを 0 に戻す。次の候補 A-01 は k1 が使っているので A-02 になる。
    const rewound: VenueState = { ...base, nextCodeSeq: 0 };
    const next = join(rewound, 'k2', 2, at(1));
    expect(ticketOf(next, 'k2').code).toBe('A-02');
  });
});

function codeFor(seq: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const letter = letters.charAt(Math.floor(seq / 99));
  return `${letter}-${String((seq % 99) + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------

describe('状態の一覧との対応', () => {
  const everyState: readonly TicketState[] = [
    'WAITING',
    'PAUSED',
    'CALLED',
    'SEATED',
    'DONE',
    'CANCELLED',
    'NO_SHOW',
    'EXPIRED',
  ];

  it('保留できるのは WAITING だけ', () => {
    const accepted = everyState.filter((from) => acceptsFrom(from, { type: 'PAUSE', ticketId: 'k1' }));
    expect(accepted).toEqual(['WAITING']);
  });

  it('準備OKにできるのは PAUSED だけ', () => {
    const accepted = everyState.filter((from) => acceptsFrom(from, { type: 'READY', ticketId: 'k1' }));
    expect(accepted).toEqual(['PAUSED']);
  });

  it('取り消せるのは WAITING / PAUSED / CALLED（7.9）', () => {
    const command: Command = { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: null };
    const accepted = everyState.filter((from) => acceptsFrom(from, command));
    expect(accepted).toEqual(['WAITING', 'PAUSED', 'CALLED']);
  });

  /**
   * その状態から、そのコマンドが「状態のせいで」拒否されないかを見る。
   *
   * 手で作った状態は不変条件を満たさないことがあるので、判定は
   * `NOT_ALLOWED_IN_STATE` かどうかだけで行う。
   */
  function acceptsFrom(from: TicketState, command: Command): boolean {
    const base = join(venue(), 'k1', 2);
    const moved: VenueState = {
      ...base,
      tickets: base.tickets.map((item) => ({ ...item, state: from })),
    };
    const result = apply(moved, command, at(1));
    return result.ok || result.error.code !== 'NOT_ALLOWED_IN_STATE';
  }
});

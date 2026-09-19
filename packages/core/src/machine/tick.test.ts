import { describe, expect, it } from 'vitest';
import type { Decision, Tick } from '../decision.js';
import { DEFAULT_POLICY, type NoShowPolicy, type Policy } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import type { Ticket } from '../domain/ticket.js';
import { createVenueState, findTable, findTicket, sameVenueState, type VenueState } from '../domain/state.js';
import type { Result } from '../result.js';
import { minutes, seconds, type Timestamp } from '../time.js';
import { apply } from './apply.js';
import type { Command } from './command.js';
import type { DomainEvent, DomainEventType } from './events.js';
import type { Rejection, RejectionCode } from './rejection.js';
import { tick } from './tick.js';

const NOW: Timestamp = 1_700_000_000_000;

/** NOW から何分後か。7.7 の図の時刻をそのまま書けるようにする。 */
function at(elapsedMin: number): Timestamp {
  return NOW + minutes(elapsedMin);
}

function table(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE', ...overrides };
}

/** 運用中で受付を開いている施設。4 名席が 1 卓だけ空いている。 */
function venue(policy: Policy = DEFAULT_POLICY, tables: readonly Table[] = [table('tb-4', 4)]): VenueState {
  return {
    ...createVenueState({ venueId: 'v1', policy, tables }),
    operating: true,
    joinOpen: true,
  };
}

/** 空席が 1 つも無い施設。受け付けた人は待ちに入る。 */
function crowded(policy: Policy = DEFAULT_POLICY): VenueState {
  return venue(policy, [table('tb-4', 4, { status: 'OCCUPIED_UNKNOWN' })]);
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

function join(
  state: VenueState,
  id: string,
  partySize: number,
  now: Timestamp = NOW,
  hasNotificationChannel = false,
): VenueState {
  return expectOk(
    apply(
      state,
      { type: 'JOIN', ticketId: id, partySize, requiredTags: [], hasNotificationChannel },
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

describe('7.7 の図をそのまま時系列でたどる', () => {
  // 呼び出し(0:00) ── リマインド(5:00) ── 期限(7:00) ──[延長 +3]──> 期限(10:00)
  const called = join(venue(), 'k1', 4);

  it('0 分: 受け付けと同時に呼び出され、7 分後が期限になる', () => {
    const ticket = ticketOf(called, 'k1');
    expect(ticket.state).toBe('CALLED');
    expect(ticket.holdDeadline).toBe(at(7));
    expect(tableOf(called, 'tb-4').status).toBe('HELD');
  });

  it('4 分: まだ何も起きない（リマインドは 5 分から）', () => {
    expect(expectOk(tick(called, at(4))).events).toEqual([]);
  });

  it('5 分: 「あと 2 分」の知らせが出る（hold_reminder_before_min = 2）', () => {
    const decided = expectOk(tick(called, at(5.001)));
    expect(eventTypes(decided)).toEqual(['TicketReminded']);
    expect(ticketOf(decided.state, 'k1').state).toBe('CALLED');
  });

  it('知らせは 1 回だけ。続けて tick しても繰り返さない', () => {
    const reminded = advance(called, at(5.001));
    expect(expectOk(tick(reminded, at(6))).events).toEqual([]);
  });

  it('7 分ちょうどはまだ期限切れではない（期限ちょうどは過ぎていない）', () => {
    const reminded = advance(called, at(5.001));
    expect(ticketOf(advance(reminded, at(7)), 'k1').state).toBe('CALLED');
  });

  it('7 分を過ぎるとホールドが切れ、既定では保留に戻る（順番は保持）', () => {
    const reminded = advance(called, at(5.001));
    const expired = advance(reminded, at(7.001));
    const ticket = ticketOf(expired, 'k1');
    expect(ticket.state).toBe('PAUSED');
    expect(ticket.priorityAt).toBe(NOW);
    expect(ticket.noShows).toBe(1);
    expect(tableOf(expired, 'tb-4').status).toBe('FREE');
  });

  it('5 分に「向かっています」を押すと、期限が 7 分から 10 分へ動く', () => {
    const extended = run(called, { type: 'EXTEND', ticketId: 'k1' }, at(5));
    expect(ticketOf(extended, 'k1').holdDeadline).toBe(at(10));
    expect(ticketOf(extended, 'k1').extensions).toBe(1);
  });

  it('延長したら 7 分を過ぎても期限切れにならない', () => {
    const extended = run(called, { type: 'EXTEND', ticketId: 'k1' }, at(5));
    expect(ticketOf(advance(extended, at(9)), 'k1').state).toBe('CALLED');
  });

  it('延長すると、新しい期限についてもう一度知らせが出る（8 分）', () => {
    const reminded = advance(called, at(5.001));
    const extended = run(reminded, { type: 'EXTEND', ticketId: 'k1' }, at(6));
    expect(ticketOf(extended, 'k1').holdRemindedAt).toBeNull();
    expect(eventTypes(expectOk(tick(extended, at(8.001))))).toEqual(['TicketReminded']);
  });

  /**
   * ファズが見つけた誤り。延長のたびに知らせの記録を無条件に消していたため、
   * `hold_extension_min` が 0 の施設では期限が動かないまま記録だけが消え、
   * 同じ知らせが何度も出ていた。
   */
  it('延長しても期限が動かない設定では、知らせを繰り返さない', () => {
    const policy: Policy = { ...DEFAULT_POLICY, holdExtensionMin: 0 };
    const state = join(venue(policy), 'k1', 4);
    const reminded = advance(state, at(5.001));
    expect(ticketOf(reminded, 'k1').holdRemindedAt).not.toBeNull();

    const extended = run(reminded, { type: 'EXTEND', ticketId: 'k1' }, at(6));
    expect(ticketOf(extended, 'k1').holdDeadline).toBe(at(7));
    expect(ticketOf(extended, 'k1').holdRemindedAt).not.toBeNull();
    expect(expectOk(tick(extended, at(6.5))).events).toEqual([]);
  });

  it('延長したあとの期限（10 分）を過ぎれば切れる', () => {
    const extended = run(called, { type: 'EXTEND', ticketId: 'k1' }, at(5));
    expect(ticketOf(advance(extended, at(10.001)), 'k1').state).toBe('PAUSED');
  });
});

describe('延長の回数制限（7.7 の 4）', () => {
  const called = join(venue(), 'k1', 4);

  it('既定では 1 回まで押せる', () => {
    expect(apply(called, { type: 'EXTEND', ticketId: 'k1' }, at(1)).ok).toBe(true);
  });

  it('2 回目は拒否される（max_extensions = 1）', () => {
    const once = run(called, { type: 'EXTEND', ticketId: 'k1' }, at(1));
    const failure = expectRejected(
      apply(once, { type: 'EXTEND', ticketId: 'k1' }, at(2)),
      'BLOCKED_BY_GUARD',
    );
    expect(failure.describe).toContain('underExtensionLimit');
  });

  it('max_extensions を 2 にすれば 2 回押せる', () => {
    const policy: Policy = { ...DEFAULT_POLICY, maxExtensions: 2 };
    let state = join(venue(policy), 'k1', 4);
    state = run(state, { type: 'EXTEND', ticketId: 'k1' }, at(1));
    state = run(state, { type: 'EXTEND', ticketId: 'k1' }, at(2));
    expect(ticketOf(state, 'k1').holdDeadline).toBe(at(7 + 3 + 3));
  });

  it('max_extensions が 0 なら一度も押せない', () => {
    const policy: Policy = { ...DEFAULT_POLICY, maxExtensions: 0 };
    const state = join(venue(policy), 'k1', 4);
    expectRejected(apply(state, { type: 'EXTEND', ticketId: 'k1' }, at(1)), 'BLOCKED_BY_GUARD');
  });

  it('譲って呼び直されると、延長の回数は数え直しになる', () => {
    let state = join(venue(), 'k1', 4);
    state = run(state, { type: 'EXTEND', ticketId: 'k1' }, at(1));
    state = run(state, { type: 'PASS', ticketId: 'k1' }, at(2));
    state = run(state, { type: 'READY', ticketId: 'k1' }, at(3));
    expect(ticketOf(state, 'k1').state).toBe('CALLED');
    expect(ticketOf(state, 'k1').extensions).toBe(0);
  });
});

describe('パス（7.7 の 5）', () => {
  it('席は即座に空席へ戻り、本人は順番を保ったまま保留になる', () => {
    const called = join(venue(), 'k1', 4);
    const passed = run(called, { type: 'PASS', ticketId: 'k1' }, at(2));
    const ticket = ticketOf(passed, 'k1');
    expect(ticket.state).toBe('PAUSED');
    expect(ticket.priorityAt).toBe(NOW);
    expect(ticket.passes).toBe(1);
    expect(ticket.tableId).toBeNull();
    expect(tableOf(passed, 'tb-4').status).toBe('FREE');
  });

  it('譲った席は、同じ手のうちに次の人へ渡る', () => {
    let state = join(crowded(), 'k1', 4);
    state = join(state, 'k2', 2, at(1));
    // 席を空ける。k1 が呼ばれ、k2 は待つ。
    state = { ...state, tables: state.tables.map((item) => ({ ...item, status: 'FREE' as const })) };
    state = advance(state, at(2));
    expect(ticketOf(state, 'k1').state).toBe('CALLED');

    const passed = run(state, { type: 'PASS', ticketId: 'k1' }, at(3));
    expect(ticketOf(passed, 'k1').state).toBe('PAUSED');
    expect(ticketOf(passed, 'k2').state).toBe('CALLED');
    expect(tableOf(passed, 'tb-4').status).toBe('HELD');
  });

  it('譲ったことはイベントの理由に残る', () => {
    const called = join(venue(), 'k1', 4);
    const decided = expectOk(apply(called, { type: 'PASS', ticketId: 'k1' }, at(2)));
    expect(decided.events[0]).toMatchObject({ type: 'TicketPaused', reason: 'passed' });
  });

  it('準備OKで待ちに戻り、空席があればそのまま呼び直される', () => {
    const called = join(venue(), 'k1', 4);
    const passed = run(called, { type: 'PASS', ticketId: 'k1' }, at(2));
    const ready = run(passed, { type: 'READY', ticketId: 'k1' }, at(6));
    expect(ticketOf(ready, 'k1').state).toBe('CALLED');
    expect(ticketOf(ready, 'k1').priorityAt).toBe(NOW);
  });

  it('待っていない人は譲れない', () => {
    const waitingOnly = join(crowded(), 'k1', 4);
    expectRejected(
      apply(waitingOnly, { type: 'PASS', ticketId: 'k1' }, at(1)),
      'NOT_ALLOWED_IN_STATE',
    );
  });
});

describe('ノーショーの 3 方針（7.7 の 6）', () => {
  /**
   * ホールドの期限切れを `rounds` 回起こす。
   *
   * 保留に戻された場合は「準備OK」を押して呼び直してもらう。ただし最後の周では
   * 押さない。押すと呼び出しが起きて、期限切れの直後の状態が見えなくなるため。
   */
  function afterHoldExpiry(noShowPolicy: NoShowPolicy, rounds = 1): VenueState {
    const policy: Policy = { ...DEFAULT_POLICY, noShowPolicy };
    let state = join(venue(policy), 'k1', 4);
    for (let round = 0; round < rounds; round += 1) {
      state = advance(state, at(8 + round * 10));
      const isLast = round === rounds - 1;
      if (!isLast && ticketOf(state, 'k1').state === 'PAUSED') {
        state = run(state, { type: 'READY', ticketId: 'k1' }, at(9 + round * 10));
      }
    }
    return state;
  }

  it('requeue_once: 1 回目は保留に戻り、順番を保つ', () => {
    const state = afterHoldExpiry('requeue_once');
    const ticket = ticketOf(state, 'k1');
    expect(ticket.state).toBe('PAUSED');
    expect(ticket.priorityAt).toBe(NOW);
    expect(ticket.noShows).toBe(1);
  });

  it('requeue_once: 保留のままでは呼び直されない（準備OKを押すまで）', () => {
    const paused = afterHoldExpiry('requeue_once');
    expect(ticketOf(advance(paused, at(9)), 'k1').state).toBe('PAUSED');
    expect(tableOf(paused, 'tb-4').status).toBe('FREE');
  });

  it('requeue_once: 2 回目の期限切れで NO_SHOW になる', () => {
    const state = afterHoldExpiry('requeue_once', 2);
    const ticket = ticketOf(state, 'k1');
    expect(ticket.state).toBe('NO_SHOW');
    expect(ticket.endReason).toBe('no_show');
    expect(ticket.noShows).toBe(2);
  });

  it('cancel: 1 回で終わる', () => {
    const state = afterHoldExpiry('cancel');
    expect(ticketOf(state, 'k1').state).toBe('NO_SHOW');
    expect(ticketOf(state, 'k1').noShows).toBe(1);
  });

  it('requeue_back: 順番が末尾に戻る（受付時刻をやり直す）', () => {
    const policy: Policy = { ...DEFAULT_POLICY, noShowPolicy: 'requeue_back' };
    const state = advance(join(venue(policy), 'k1', 4), at(8));
    const ticket = ticketOf(state, 'k1');
    // 末尾に戻ったあと、空席がまだあるのでその場で呼び直される。
    expect(ticket.state).toBe('CALLED');
    // 順番は「気づいた時刻」ではなく「期限の時刻」でやり直す。
    expect(ticket.priorityAt).toBe(at(7));
    expect(ticket.noShows).toBe(1);
  });

  it('requeue_back: 先に待っていた人がいれば、その人が先に呼ばれる', () => {
    const policy: Policy = { ...DEFAULT_POLICY, noShowPolicy: 'requeue_back' };
    let state = join(venue(policy), 'k1', 4);
    // 人数を揃える。揃えないとロス最小の側が勝ち、順番の検証にならない（7.6）。
    state = join(state, 'k2', 4, at(1));
    expect(ticketOf(state, 'k2').state).toBe('WAITING');

    state = advance(state, at(8));
    expect(ticketOf(state, 'k2').state).toBe('CALLED');
    expect(ticketOf(state, 'k1').state).toBe('WAITING');
  });

  it('どの方針でも、期限切れで席は必ず空席へ戻る', () => {
    for (const noShowPolicy of ['cancel', 'requeue_once', 'requeue_back'] as const) {
      const policy: Policy = { ...DEFAULT_POLICY, noShowPolicy };
      const tables = [table('tb-4', 4), table('tb-2', 2, { status: 'OCCUPIED_UNKNOWN' })];
      const state = advance(join(venue(policy, tables), 'k1', 4), at(8));
      const held = state.tables.filter((item) => item.occupantTicketId === 'k1' && item.status === 'HELD');
      // requeue_back は呼び直されるので、確保している席が 1 つあってよい。
      expect(held.length).toBe(noShowPolicy === 'requeue_back' ? 1 : 0);
    }
  });

  it('期限切れは終了のイベントを出す', () => {
    const policy: Policy = { ...DEFAULT_POLICY, noShowPolicy: 'cancel' };
    const decided = expectOk(tick(join(venue(policy), 'k1', 4), at(8)));
    expect(eventTypes(decided)).toEqual(['TicketReminded', 'TicketEnded', 'TableFreed']);
    expect(decided.events.at(-2)).toMatchObject({ endReason: 'no_show', by: null });
  });
});

describe('保留の期限切れ（7.7 の 7）', () => {
  it('操作が無ければ pause_step_min で期限切れになる', () => {
    const paused = run(join(crowded(), 'k1', 4), { type: 'PAUSE', ticketId: 'k1' }, at(1));
    expect(ticketOf(paused, 'k1').pauseDeadline).toBe(at(11));

    const expired = advance(paused, at(11.001));
    const ticket = ticketOf(expired, 'k1');
    expect(ticket.state).toBe('EXPIRED');
    expect(ticket.endReason).toBe('pause_expired');
  });

  it('期限ちょうどでは切れない', () => {
    const paused = run(join(crowded(), 'k1', 4), { type: 'PAUSE', ticketId: 'k1' }, at(1));
    expect(ticketOf(advance(paused, at(11)), 'k1').state).toBe('PAUSED');
  });

  it('「延長」を押すと、そこから pause_step_min 先へ延びる', () => {
    const paused = run(join(crowded(), 'k1', 4), { type: 'PAUSE', ticketId: 'k1' }, at(1));
    const extended = run(paused, { type: 'EXTEND', ticketId: 'k1' }, at(9));
    expect(ticketOf(extended, 'k1').pauseDeadline).toBe(at(19));
    expect(ticketOf(advance(extended, at(12)), 'k1').state).toBe('PAUSED');
  });

  it('延長のイベントは、どちらの期限を延ばしたかを伝える', () => {
    const paused = run(join(crowded(), 'k1', 4), { type: 'PAUSE', ticketId: 'k1' }, at(1));
    const decided = expectOk(apply(paused, { type: 'EXTEND', ticketId: 'k1' }, at(9)));
    expect(decided.events[0]).toMatchObject({ type: 'TicketExtended', from: 'PAUSED' });
  });

  /**
   * ファズが見つけた誤り。`pausedTotal` は保留を閉じるときにしか増えないので、
   * 続いている保留の経過を見ないと、延長のたびに上限いっぱいの持ち時間が
   * 戻ってしまい、いつまでも保留していられた。
   */
  it('延長を繰り返しても、合計の上限より先へは延びない', () => {
    const policy: Policy = { ...DEFAULT_POLICY, pauseStepMin: 10, pauseMaxTotalMin: 25 };
    let state = run(join(crowded(policy), 'k1', 4), { type: 'PAUSE', ticketId: 'k1' }, at(0));
    expect(ticketOf(state, 'k1').pauseDeadline).toBe(at(10));

    state = run(state, { type: 'EXTEND', ticketId: 'k1' }, at(9));
    expect(ticketOf(state, 'k1').pauseDeadline).toBe(at(19));

    // ここで上限（0 分から 25 分）に達する。あと 6 分しか残っていない。
    state = run(state, { type: 'EXTEND', ticketId: 'k1' }, at(18));
    expect(ticketOf(state, 'k1').pauseDeadline).toBe(at(25));

    // これ以上は延びない。
    state = run(state, { type: 'EXTEND', ticketId: 'k1' }, at(24));
    expect(ticketOf(state, 'k1').pauseDeadline).toBe(at(25));
    expect(ticketOf(advance(state, at(25.001)), 'k1').state).toBe('EXPIRED');
  });

  it('保留の合計が上限に達したら、延長しても期限が伸びない', () => {
    const policy: Policy = { ...DEFAULT_POLICY, pauseStepMin: 10, pauseMaxTotalMin: 10 };
    let state = run(join(crowded(policy), 'k1', 4), { type: 'PAUSE', ticketId: 'k1' }, at(0));
    state = run(state, { type: 'READY', ticketId: 'k1' }, at(10));
    state = run(state, { type: 'PAUSE', ticketId: 'k1' }, at(11));
    expect(ticketOf(state, 'k1').pauseDeadline).toBe(at(11));
    expect(ticketOf(advance(state, at(11.001)), 'k1').state).toBe('EXPIRED');
  });
});

describe('受付からの絶対上限（7.7 の 7）', () => {
  it('待っている人は ticket_max_age_min で終わる', () => {
    // 通知手段を持たせる。持たない人は先に放置（10 分）で終わってしまう。
    const waitingOnly = join(crowded(), 'k1', 4, NOW, true);
    const expired = advance(waitingOnly, at(91));
    expect(ticketOf(expired, 'k1').state).toBe('EXPIRED');
    expect(ticketOf(expired, 'k1').endReason).toBe('max_age');
  });

  it('通知手段が無い人は、絶対上限より先に放置で終わる（期限が早いほうが効く）', () => {
    const waitingOnly = join(crowded(), 'k1', 4, NOW, false);
    expect(ticketOf(advance(waitingOnly, at(91)), 'k1').endReason).toBe('abandoned');
  });

  it('保留中の人にも適用される', () => {
    const policy: Policy = { ...DEFAULT_POLICY, pauseStepMin: 200, pauseMaxTotalMin: 200 };
    const paused = run(join(crowded(policy), 'k1', 4), { type: 'PAUSE', ticketId: 'k1' }, at(1));
    expect(ticketOf(advance(paused, at(91)), 'k1').endReason).toBe('max_age');
  });

  it('上限は受付時刻から数える（保留や呼び出しでやり直さない）', () => {
    const policy: Policy = { ...DEFAULT_POLICY, pauseStepMin: 200, pauseMaxTotalMin: 200 };
    const paused = run(join(crowded(policy), 'k1', 4), { type: 'PAUSE', ticketId: 'k1' }, at(60));
    expect(ticketOf(advance(paused, at(95)), 'k1').endedAt).toBe(at(90));
  });

  it('呼び出し中の人には適用されない（確保した席を無駄にしない）', () => {
    const policy: Policy = { ...DEFAULT_POLICY, ticketMaxAgeMin: 5, holdMin: 60 };
    const called = join(venue(policy), 'k1', 4);
    expect(ticketOf(advance(called, at(10)), 'k1').state).toBe('CALLED');
  });

  /**
   * **時間の飛ばし方によらず同じ終わり方になること。**
   *
   * 保留の期限（11 分）と受付からの上限（90 分）の両方を過ぎた状態を、1 回の
   * tick でまとめて処理しても、先に来た保留の期限で終わる。期限の早い順に
   * 処理しているためで、種類の順で決めると `max_age` になってしまう。
   */
  it('両方の期限を過ぎていても、先に来たほうの理由で終わる', () => {
    const paused = run(join(crowded(), 'k1', 4), { type: 'PAUSE', ticketId: 'k1' }, at(1));
    expect(ticketOf(advance(paused, at(200)), 'k1').endReason).toBe('pause_expired');
  });
});

describe('放置（7.9 の「暗黙のキャンセル」）', () => {
  it('通知手段が無く、接続が途絶えたまま abandon_timeout_min が過ぎたら終わる', () => {
    const waitingOnly = join(crowded(), 'k1', 4, NOW, false);
    const expired = advance(waitingOnly, at(11));
    expect(ticketOf(expired, 'k1').state).toBe('EXPIRED');
    expect(ticketOf(expired, 'k1').endReason).toBe('abandoned');
  });

  it('通知手段がある人には適用されない', () => {
    const waitingOnly = join(crowded(), 'k1', 4, NOW, true);
    expect(ticketOf(advance(waitingOnly, at(60)), 'k1').state).toBe('WAITING');
  });

  it('心拍が届いていれば起点が動き、放置にならない', () => {
    let state = join(crowded(), 'k1', 4, NOW, false);
    state = run(state, { type: 'HEARTBEAT', ticketId: 'k1' }, at(9));
    expect(ticketOf(advance(state, at(11)), 'k1').state).toBe('WAITING');
    expect(ticketOf(advance(state, at(20)), 'k1').state).toBe('EXPIRED');
  });

  it('呼び出し中の人には適用されない（応答はノーショーで扱う）', () => {
    const policy: Policy = { ...DEFAULT_POLICY, abandonTimeoutMin: 1, holdMin: 60 };
    const called = join(venue(policy), 'k1', 4, NOW, false);
    expect(ticketOf(advance(called, at(30)), 'k1').state).toBe('CALLED');
  });

  it('保留中の人には適用されない（保留の期限が別に働く）', () => {
    const policy: Policy = { ...DEFAULT_POLICY, abandonTimeoutMin: 1, pauseStepMin: 60, pauseMaxTotalMin: 60 };
    const paused = run(join(crowded(policy), 'k1', 4, NOW, false), { type: 'PAUSE', ticketId: 'k1' }, at(1));
    expect(ticketOf(advance(paused, at(30)), 'k1').state).toBe('PAUSED');
  });
});

describe('tick そのもの', () => {
  it('Tick の形をしている', () => {
    const shape: Tick<VenueState, DomainEvent, Rejection> = tick;
    expect(typeof shape).toBe('function');
  });

  it('何も来ていなければ状態を変えない', () => {
    const state = join(crowded(), 'k1', 4);
    const decided = expectOk(tick(state, at(1)));
    expect(decided.events).toEqual([]);
    // 時計の刻みだけは進む（9.4）。ほかは何も変わらない。
    expect(decided.state).toEqual({ ...state, clockAt: at(1) });
  });

  it('渡した状態を書き換えない', () => {
    const state = join(venue(), 'k1', 4);
    const snapshot = structuredClone(state);
    advance(state, at(20));
    expect(state).toStrictEqual(snapshot);
  });

  it('同じ時刻で 2 回呼んでも 2 回目は何も起きない（冪等）', () => {
    const state = join(venue(), 'k1', 4);
    const once = expectOk(tick(state, at(8)));
    const twice = expectOk(tick(once.state, at(8)));
    expect(twice.events).toEqual([]);
    expect(twice.state).toEqual(once.state);
  });

  it('空いた席は tick のうちに次の人へ渡る', () => {
    const policy: Policy = { ...DEFAULT_POLICY, noShowPolicy: 'cancel' };
    let state = join(venue(policy), 'k1', 4);
    state = join(state, 'k2', 3, at(1));
    expect(ticketOf(state, 'k2').state).toBe('WAITING');

    const decided = expectOk(tick(state, at(8)));
    expect(ticketOf(decided.state, 'k1').state).toBe('NO_SHOW');
    expect(ticketOf(decided.state, 'k2').state).toBe('CALLED');
    expect(eventTypes(decided)).toContain('TicketCalled');
  });

  it('連鎖する期限を 1 回の tick でまとめて処理する', () => {
    // ホールドが切れて保留になり、その保留の期限も過ぎている時刻を一度に渡す。
    const policy: Policy = { ...DEFAULT_POLICY, pauseStepMin: 1, pauseMaxTotalMin: 1 };
    const called = join(venue(policy), 'k1', 4);
    const settled = advance(called, at(30));
    expect(ticketOf(settled, 'k1').state).toBe('EXPIRED');
    expect(ticketOf(settled, 'k1').endReason).toBe('pause_expired');
  });

  it('チケットが 1 枚も無くても動く', () => {
    const empty = venue();
    expect(expectOk(tick(empty, at(60))).state).toEqual({ ...empty, clockAt: at(60) });
  });
});

// ---------------------------------------------------------------------------

/**
 * 大きな時間の飛び（全体プラン 9.4、Phase 1 プラン PR 12）。
 *
 * サーバの再起動やスケジューラの遅れで、`tick` は 10 秒ではなく 1 時間ぶん
 * 飛ぶことがある。**飛んでも取りこぼさない**ことを、10 秒刻みで 360 回進めた
 * 場合と 1 回で進めた場合を並べて確かめる。
 */
describe('大きな時間の飛び（9.4）', () => {
  /** `from` から `to` まで 10 秒ごとに進める。実運用と同じ刻み。 */
  function everyTenSeconds(state: VenueState, from: Timestamp, to: Timestamp): VenueState {
    let current: VenueState = state;
    let calls = 0;
    for (let now: Timestamp = from; now <= to; now += seconds(10)) {
      current = expectOk(tick(current, now)).state;
      calls += 1;
    }
    expect(calls).toBe(361);
    return current;
  }

  /** 空席が無い施設で、呼ばれた人が来ないまま 1 時間が過ぎる。 */
  function noShowScenario(policy: Policy): { readonly built: VenueState; readonly from: Timestamp } {
    const state = venue(policy, [table('tb-4', 4), table('tb-2', 2, { status: 'OCCUPIED_UNKNOWN' })]);
    const built = join(state, 'k1', 3, NOW, true);
    expect(ticketOf(built, 'k1').state).toBe('CALLED');
    return { built, from: NOW };
  }

  /**
   * **刻み方によらず、同じ終わり方に落ち着く。**
   *
   * 呼び出し → ホールドの期限切れ → 保留 → 保留の期限切れ → 終了、と 3 つの
   * 期限が連鎖する筋書き。まとめて 1 回で処理しても、10 秒ごとに 361 回
   * 処理しても、同じところへ落ちる。
   */
  it('1 時間を 361 回に分けて進めても、1 回で進めても同じ状態になる', () => {
    const quiet: Policy = { ...DEFAULT_POLICY, ticketMaxAgeMin: 600, timeLimitMode: 'off' };
    const { built, from } = noShowScenario(quiet);
    const to: Timestamp = from + minutes(60);

    const stepped = everyTenSeconds(built, from, to);
    const jumped = expectOk(tick(built, to)).state;
    expect(sameVenueState(stepped, jumped)).toBe(true);
  });

  it('そのとき、終わり方も同じになる', () => {
    const quiet: Policy = { ...DEFAULT_POLICY, ticketMaxAgeMin: 600, timeLimitMode: 'off' };
    const { built, from } = noShowScenario(quiet);
    const to: Timestamp = from + minutes(60);

    const jumped = expectOk(tick(built, to)).state;
    expect(ticketOf(jumped, 'k1').state).toBe('EXPIRED');
    expect(ticketOf(jumped, 'k1').endReason).toBe('pause_expired');
    expect(ticketOf(everyTenSeconds(built, from, to), 'k1').endReason).toBe('pause_expired');
  });

  /**
   * **期限は、その期限の時刻で刻まれる。** 1 時間後に気づいても、7 分で切れた
   * ホールドは「7 分に切れた」として扱う。現在時刻で刻むと、そこから置かれる
   * 次の期限が現在時刻より先になり、連鎖が途切れる。
   */
  it('飛ばして処理しても、刻まれる時刻は期限の時刻になる', () => {
    const quiet: Policy = { ...DEFAULT_POLICY, ticketMaxAgeMin: 600, timeLimitMode: 'off' };
    const { built } = noShowScenario(quiet);
    const decided = expectOk(tick(built, at(60)));

    const reminded = decided.events.find((event) => event.type === 'TicketReminded');
    // hold_min 7 分、リマインドはその 2 分前。
    expect(reminded?.at).toBe(at(5));
    const ended = decided.events.find((event) => event.type === 'TicketEnded');
    // 7 分でホールドが切れて保留へ、そこから 10 分で保留の期限。
    expect(ended?.at).toBe(at(17));
  });

  /**
   * **呼び出しだけは「いま」起きる。**
   *
   * 席が空いたことは期限の時刻で刻めるが、次の人を呼べるのは `tick` が走った
   * 時点である。止まっているあいだに遡って呼び出すと、**届いていない呼び出しの
   * ホールドがすでに切れている**、という利用者に厳しい結果になる。
   * 設計上の判断であって、取りこぼしではない。
   */
  it('席が空くのは期限の時刻、呼び出しは tick の時刻になる', () => {
    const slow: Policy = { ...DEFAULT_POLICY, turnoverMin: 5, ticketMaxAgeMin: 600 };
    let state = venue(slow, [table('tb-4', 4)]);
    state = join(state, 'k1', 4, NOW, true);
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(1));
    state = join(state, 'k2', 4, at(2), true);
    state = run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(3));
    expect(tableOf(state, 'tb-4').status).toBe('TURNOVER');

    // 片付けの猶予は 8 分に明ける。1 時間後にまとめて処理する。
    const decided = expectOk(tick(state, at(63)));
    expect(decided.events.find((event) => event.type === 'TableFreed')?.at).toBe(at(8));
    expect(decided.events.find((event) => event.type === 'TicketCalled')?.at).toBe(at(63));
    expect(ticketOf(decided.state, 'k2').calledAt).toBe(at(63));
  });

  /**
   * **止まっていたあいだの呼び出しは、遡らない。**
   *
   * 10 秒ごとに動いていれば、8 分に席が空いて呼ばれ、来なければ 15 分に
   * ホールドが切れ、やがて保留の期限で終わる。1 時間止まっていた場合は、
   * **再開した時点で呼び直す**。遡って呼び出すと、届いていない呼び出しの
   * ホールドがすでに切れていることになり、利用者に不利になる（CLAUDE.md 2.5）。
   *
   * ここだけは刻み方で結果が変わる。**取りこぼしではなく、そう決めている。**
   */
  it('止まっていたあいだの呼び出しは遡らず、再開した時点で呼び直す', () => {
    const slow: Policy = { ...DEFAULT_POLICY, turnoverMin: 5, ticketMaxAgeMin: 600 };
    let state = venue(slow, [table('tb-4', 4)]);
    state = join(state, 'k1', 4, NOW, true);
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(1));
    state = join(state, 'k2', 4, at(2), true);
    state = run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(3));

    // 動き続けていた場合: 8 分に呼ばれ、来ないまま期限を重ねて終わる。
    const stepped = everyTenSeconds(state, at(3), at(63));
    expect(ticketOf(stepped, 'k2').state).toBe('EXPIRED');

    // 1 時間止まっていた場合: いま呼び直す。7 分の猶予がそのまま与えられる。
    const jumped = expectOk(tick(state, at(63))).state;
    expect(ticketOf(jumped, 'k2').state).toBe('CALLED');
    expect(ticketOf(jumped, 'k2').holdDeadline).toBe(at(70));
  });
});

/**
 * 評価の順序（Phase 1 プラン PR 12）。
 *
 * `tick` は毎回この順で進む。**順序を明示しておかないと、期限の処理より先に
 * 割当が走って「空くはずの席」を飛ばす**、といった取りこぼしが起きる。
 *
 * | 段 | 何をするか | どこ |
 * |---|---|---|
 * | 1 | チケットの期限（ホールド・保留・上限・放置・運用終了） | `tick.ts` |
 * | 2 | 施設の期限（受付の締切・運用終了） | `tick.ts` |
 * | 3 | 席の期限（片付けの猶予・確認要の整理・運用から外れる席） | `settle.ts` |
 * | 4 | 割当 | `settle.ts` |
 * | 5 | 不変条件の検査 | `settle.ts` |
 *
 * 3 以降は `apply` と共有している。**席の期限を割当の前に明かす**のがここの
 * 肝で、そうしないと空いているはずの席が次の人に渡らない（PR 7）。
 */
describe('評価の順序（期限 → 整理 → 割当）', () => {
  /** 1 回の `tick` で、チケットの期限・席の期限・割当がすべて起きる筋書き。 */
  function everythingAtOnce(): Decision<VenueState, DomainEvent> {
    const slow: Policy = { ...DEFAULT_POLICY, turnoverMin: 5, ticketMaxAgeMin: 600 };
    let state = venue(slow, [table('tb-a', 4), table('tb-b', 4)]);
    state = join(state, 'k1', 4, NOW, true);
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-a' }, at(1));
    state = run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(2));
    expect(tableOf(state, 'tb-a').status).toBe('TURNOVER');

    state = join(state, 'k2', 4, at(3), true);
    expect(ticketOf(state, 'k2').tableId).toBe('tb-b');
    state = join(state, 'k3', 4, at(4), true);
    expect(ticketOf(state, 'k3').state).toBe('WAITING');

    // 7 分で片付けの猶予が明け、10 分で k2 のホールドが切れる。
    return expectOk(tick(state, at(12)));
  }

  it('チケットの期限 → 席の期限 → 割当 の順に起きる', () => {
    expect(eventTypes(everythingAtOnce())).toEqual([
      // 1. チケットの期限（k2 のホールド）
      'TicketReminded',
      'TicketPaused',
      'TableFreed',
      // 3. 席の期限（tb-a の片付けの猶予）
      'TableFreed',
      // 4. 割当（k3 を呼ぶ）
      'TicketCalled',
      'TableHeld',
    ]);
  });

  it('席の期限はその期限の時刻で、割当は tick の時刻で刻まれる', () => {
    const events = everythingAtOnce().events;
    const freed = events.filter((event) => event.type === 'TableFreed');
    expect(freed.map((event) => event.at)).toEqual([at(10), at(7)]);
    expect(events.find((event) => event.type === 'TicketCalled')?.at).toBe(at(12));
  });

  it('割当は最後なので、その手のうちに空いた席も使われる', () => {
    const decided = everythingAtOnce();
    expect(ticketOf(decided.state, 'k3').state).toBe('CALLED');
    expect(ticketOf(decided.state, 'k3').tableId).toBe('tb-a');
  });
});

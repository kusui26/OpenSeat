import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import type { Ticket } from '../domain/ticket.js';
import { createVenueState, findTable, findTicket, type VenueState } from '../domain/state.js';
import type { Decision } from '../decision.js';
import { checkInvariants, formatViolations } from '../invariant.js';
import type { Result } from '../result.js';
import { minutes, type Timestamp } from '../time.js';
import { apply } from './apply.js';
import type { Command } from './command.js';
import type { DomainEvent, DomainEventType } from './events.js';
import { POST_ALLOCATION_INVARIANTS, STATE_INVARIANTS } from './invariants.js';
import type { Rejection, RejectionCode } from './rejection.js';
import { tick } from './tick.js';

/**
 * 運用時間帯とモード切替（全体プラン 7.14）と、全席解放（7.9、12.6）。
 *
 * **運用終了は「期限」として実装してある。** 施設は `closesAt`（この営業回が
 * 終わる時刻）だけを持ち、曜日と時間帯の評価は境界側が `schedule.ts` で行う。
 * だからここでは、時計を進めるだけで運用終了を再現できる。
 */

const NOW: Timestamp = 1_700_000_000_000;

function at(elapsedMin: number): Timestamp {
  return NOW + minutes(elapsedMin);
}

function table(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), ...overrides };
}

/**
 * 運用の開閉だけを見るための設定。
 *
 * 着席時間の上限と問いかけ（7.10、7.11）、受付からの絶対上限を十分先へずらす。
 * どれも数十分で動くので、3 時間の営業回を回すと見たいものが埋もれる。
 */
const QUIET: Policy = {
  ...DEFAULT_POLICY,
  timeLimitMode: 'off',
  stillHerePromptMin: 6000,
  ticketMaxAgeMin: 6000,
};

/** まだ運用していない施設。席はすべて対象外（自由席）から始まる。 */
function closedVenue(policy: Policy = QUIET, tables: readonly Table[] = [table('tb-4', 4)]): VenueState {
  return createVenueState({ venueId: 'v1', policy, tables });
}

type Outcome = Result<Decision<VenueState, DomainEvent>, Rejection>;

function expectOk(result: Outcome): Decision<VenueState, DomainEvent> {
  if (!result.ok) throw new Error(`拒否された: ${result.error.code} ${result.error.describe}`);
  return result.value;
}

function expectRejected(result: Outcome, code: RejectionCode): void {
  if (result.ok) throw new Error(`拒否されるはずが通った: ${JSON.stringify(result.value.events)}`);
  expect(result.error.code).toBe(code);
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

function expectHealthy(state: VenueState): void {
  const violations = checkInvariants([...STATE_INVARIANTS, ...POST_ALLOCATION_INVARIANTS], state);
  expect(formatViolations(violations)).toBe('');
}

function join(state: VenueState, id: string, partySize: number, now: Timestamp): VenueState {
  return run(
    state,
    { type: 'JOIN', ticketId: id, partySize, requiredTags: [], hasNotificationChannel: true },
    now,
  );
}

/** 3 時間の営業回を開いた施設。 */
function opened(policy: Policy = QUIET, tables?: readonly Table[]): VenueState {
  return run(closedVenue(policy, tables), { type: 'OPEN', closesAt: at(180), by: 'staff' }, NOW);
}

// ---------------------------------------------------------------------------

describe('運用の開始（7.14）', () => {
  it('対象席が自由席から戻る', () => {
    const state = opened();
    expect(tableOf(state, 'tb-4').status).toBe('FREE');
    expect(state.operating).toBe(true);
    expect(state.joinOpen).toBe(true);
  });

  it('いつ終わるかを覚える', () => {
    expect(opened().closesAt).toBe(at(180));
  });

  it('開始と、席が使えるようになったことを知らせる', () => {
    const decided = expectOk(
      apply(closedVenue(), { type: 'OPEN', closesAt: at(180), by: 'staff' }, NOW),
    );
    expect(eventTypes(decided)).toEqual(['VenueOpened', 'TableFreed']);
  });

  it('運用していなければ受付できない', () => {
    expectRejected(
      apply(
        closedVenue(),
        { type: 'JOIN', ticketId: 'k1', partySize: 2, requiredTags: [], hasNotificationChannel: true },
        NOW,
      ),
      'JOIN_CLOSED',
    );
  });

  it('開いたあとは受付できる', () => {
    expect(ticketOf(join(opened(), 'k1', 2, at(1)), 'k1').state).toBe('CALLED');
  });

  it('二重に開こうとすると拒否される', () => {
    expectRejected(apply(opened(), { type: 'OPEN', closesAt: at(180), by: 'staff' }, at(1)), 'NOT_ALLOWED_IN_STATE');
  });

  /**
   * `enabled`（対象席かどうか）と `DISABLED`（いま運用から外れているか）は
   * 別のことを表している。管理者が外した席は、運用が始まっても戻らない。
   */
  it('管理対象から外れた席は、運用が始まっても戻らない', () => {
    const tables = [table('tb-4', 4), table('tb-2', 2, { enabled: false })];
    const state = run(closedVenue(QUIET, tables), { type: 'OPEN', closesAt: null, by: 'staff' }, NOW);
    expect(tableOf(state, 'tb-4').status).toBe('FREE');
    expect(tableOf(state, 'tb-2').status).toBe('DISABLED');
  });
});

describe('受付の締切（7.14 の join_cutoff_before_close_min）', () => {
  /** 既定は終了の 15 分前。 */
  it('締切の前は、まだ受付できる', () => {
    const state = advance(opened(), at(164));
    expect(state.joinOpen).toBe(true);
  });

  it('締切を過ぎると受付を止める', () => {
    const state = advance(opened(), at(166));
    expect(state.joinOpen).toBe(false);
    expect(state.operating).toBe(true);
  });

  it('止めたことを知らせる。いつ終わるかも載る', () => {
    const decided = expectOk(tick(opened(), at(166)));
    expect(decided.events[0]).toMatchObject({ type: 'JoinClosed', at: at(165), closesAt: at(180) });
  });

  it('知らせは 1 回だけ出る', () => {
    const closed = advance(opened(), at(166));
    expect(expectOk(tick(closed, at(167))).events).toEqual([]);
  });

  it('止まったあとの受付は拒否される', () => {
    const state = advance(opened(), at(166));
    expectRejected(
      apply(
        state,
        { type: 'JOIN', ticketId: 'k1', partySize: 2, requiredTags: [], hasNotificationChannel: true },
        at(167),
      ),
      'JOIN_CLOSED',
    );
  });

  /** すでに並んでいる人は、締切のあとも案内される（7.14「既存のチケットは自然終了させ」）。 */
  it('すでに並んでいる人は、締切のあとも席に案内される', () => {
    // 140 分で確認要、170 分で空席に戻る（7.11 の 5 層目）。締切の 165 分より後。
    const slow: Policy = { ...QUIET, unknownOccupancyToCheckMin: 140 };
    const tables = [table('tb-4', 4, { status: 'OCCUPIED_UNKNOWN', statusSince: NOW })];
    let state = run(closedVenue(slow, tables), { type: 'OPEN', closesAt: at(180), by: 'staff' }, NOW);
    state = join(state, 'k1', 3, at(1));
    expect(ticketOf(state, 'k1').state).toBe('WAITING');

    const later = advance(state, at(171));
    expect(later.joinOpen).toBe(false);
    expect(ticketOf(later, 'k1').state).toBe('CALLED');
  });

  it('終了時刻を持たない施設では、受付は止まらない', () => {
    const state = run(closedVenue(), { type: 'OPEN', closesAt: null, by: 'staff' }, NOW);
    expect(advance(state, at(600)).joinOpen).toBe(true);
  });
});

describe('運用の終了（7.14）', () => {
  /** 待っている人が 1 人、着席中の人が 1 人いる状態で終了時刻を迎える。 */
  function busy(): VenueState {
    const tables = [table('tb-4', 4), table('tb-2', 2)];
    let state = run(closedVenue(QUIET, tables), { type: 'OPEN', closesAt: at(180), by: 'staff' }, NOW);
    state = join(state, 'k1', 3, at(1));
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(2));
    state = join(state, 'k2', 4, at(3));
    expect(ticketOf(state, 'k1').state).toBe('SEATED');
    expect(ticketOf(state, 'k2').state).toBe('WAITING');
    return state;
  }

  it('終了時刻を過ぎると運用が終わる', () => {
    const state = advance(busy(), at(181));
    expect(state.operating).toBe(false);
    expect(state.joinOpen).toBe(false);
  });

  it('待っている人は施設都合で取り消される', () => {
    const state = advance(busy(), at(181));
    expect(ticketOf(state, 'k2').state).toBe('CANCELLED');
    expect(ticketOf(state, 'k2').endReason).toBe('venue_closed');
  });

  /** 7.14「`SEATED` は `DISABLED` になっても座り続けて問題ない」。 */
  it('着席中の人は巻き込まれない', () => {
    const state = advance(busy(), at(181));
    expect(ticketOf(state, 'k1').state).toBe('SEATED');
    expect(tableOf(state, 'tb-4').status).toBe('OCCUPIED');
  });

  it('着席中の人は、終了後でも自分で退席できる', () => {
    const closed = advance(busy(), at(181));
    const left = run(closed, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(182));
    expect(ticketOf(left, 'k1').state).toBe('DONE');
    expect(ticketOf(left, 'k1').endReason).toBe('checked_out');
  });

  /** 使われていた席は、利用が終わった時点で外れる（7.4、`disableAfterCurrent` と同じ考え方）。 */
  it('使われていた席は、利用が終わってから外れる', () => {
    const closed = advance(busy(), at(181));
    expect(tableOf(closed, 'tb-2').status).toBe('DISABLED');
    expect(tableOf(closed, 'tb-4').status).toBe('OCCUPIED');

    const left = run(closed, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(182));
    expect(tableOf(left, 'tb-4').status).toBe('DISABLED');
  });

  it('外れた席は管理対象のままで、次の運用で戻る', () => {
    const closed = advance(busy(), at(181));
    expect(tableOf(closed, 'tb-2').enabled).toBe(true);

    const reopened = run(closed, { type: 'OPEN', closesAt: null, by: 'staff' }, at(200));
    expect(tableOf(reopened, 'tb-2').status).toBe('FREE');
  });

  /**
   * **取り消しの知らせが先に出る。** 待っている人の取り消しは 1 枚ごとの期限
   * として処理してあり（`tick.ts`）、施設の欄はそのあとで畳むためである。
   * 誰が取り消されたかは、それぞれの `TicketEnded` が理由つきで語る。
   */
  it('終了を知らせる。取り消しはそれぞれのチケットが語る', () => {
    const decided = expectOk(tick(busy(), at(181)));
    // 締切（165 分）と終了（180 分）が同じ刻みで来ているので、両方が並ぶ。
    expect(eventTypes(decided)).toEqual(['TicketEnded', 'JoinClosed', 'VenueClosed', 'TableDisabled']);
    expect(decided.events[0]).toMatchObject({ ticketId: 'k2', endReason: 'venue_closed' });
    expect(decided.events[2]).toMatchObject({ type: 'VenueClosed', at: at(180), reason: 'schedule' });
  });

  it('終了は 1 回だけ起きる', () => {
    const closed = advance(busy(), at(181));
    expect(expectOk(tick(closed, at(182))).events).toEqual([]);
  });

  it('終了のあとも不変条件は成立している', () => {
    expectHealthy(advance(busy(), at(181)));
  });

  /**
   * **呼び出し中の人は締め出さない。** 7.4 が「利用中の席（`HELD` を含む）は
   * 現在の利用が終わってから外す」としている。確保した席に向かっている人を
   * 終了時刻ちょうどで取り消す理由が無い。
   */
  it('呼び出し中の人は残り、到着すれば座れる', () => {
    const tables = [table('tb-4', 4)];
    let state = run(closedVenue(QUIET, tables), { type: 'OPEN', closesAt: at(180), by: 'staff' }, NOW);
    state = join(state, 'k1', 3, at(178));
    expect(ticketOf(state, 'k1').state).toBe('CALLED');

    const closed = advance(state, at(181));
    expect(ticketOf(closed, 'k1').state).toBe('CALLED');
    expect(tableOf(closed, 'tb-4').status).toBe('HELD');

    const seated = run(closed, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(182));
    expect(ticketOf(seated, 'k1').state).toBe('SEATED');
  });

  /**
   * 終了後に待ちへ戻る人がいる（ノーショーの繰り上げなど）。`closesAt` を
   * 消さずに残してあるので、次の `tick` が拾う。
   */
  it('終了したあとに待ちへ戻った人も、取り消される', () => {
    const lenient: Policy = { ...QUIET, noShowPolicy: 'requeue_back', holdMin: 5 };
    const tables = [table('tb-4', 4)];
    let state = run(closedVenue(lenient, tables), { type: 'OPEN', closesAt: at(180), by: 'staff' }, NOW);
    state = join(state, 'k1', 3, at(178));
    expect(ticketOf(state, 'k1').state).toBe('CALLED');

    // 181 分で運用終了（呼び出し中なので残る）。183 分でホールドが切れて待ちに戻る。
    const closed = advance(state, at(181));
    expect(ticketOf(closed, 'k1').state).toBe('CALLED');

    const later = advance(closed, at(184));
    expect(ticketOf(later, 'k1').state).toBe('CANCELLED');
    expect(ticketOf(later, 'k1').endReason).toBe('venue_closed');
  });
});

describe('手動の切替（7.14「スタッフの手動 ON/OFF を優先させる」）', () => {
  it('終了時刻より前でも、手で閉じればその時点で閉まる', () => {
    const state = run(opened(), { type: 'CLOSE', by: 'staff' }, at(30));
    expect(state.operating).toBe(false);
    expect(tableOf(state, 'tb-4').status).toBe('DISABLED');
  });

  it('手で閉じたことが理由として残る', () => {
    const decided = expectOk(apply(opened(), { type: 'CLOSE', by: 'staff' }, at(30)));
    expect(decided.events[0]).toMatchObject({ type: 'VenueClosed', reason: 'manual' });
  });

  it('手で閉じても、待っている人は施設都合の取り消しになる', () => {
    // 4 人席を埋めてから、2 人席に収まらない組を並ばせる。
    let state = opened(QUIET, [table('tb-4', 4), table('tb-2', 2)]);
    state = join(state, 'k1', 4, at(1));
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(2));
    state = join(state, 'k2', 3, at(3));
    expect(ticketOf(state, 'k2').state).toBe('WAITING');

    const closed = run(state, { type: 'CLOSE', by: 'staff' }, at(30));
    expect(ticketOf(closed, 'k2').endReason).toBe('venue_closed');
  });

  /** 終了時刻を持たない施設は、時間では閉まらない。手で閉じるまで続く。 */
  it('終了時刻を持たない施設は、時間が経っても閉まらない', () => {
    const state = run(closedVenue(), { type: 'OPEN', closesAt: null, by: 'staff' }, NOW);
    expect(advance(state, at(6000)).operating).toBe(true);
  });

  it('閉じたあとにもう一度閉じようとすると拒否される', () => {
    const closed = run(opened(), { type: 'CLOSE', by: 'staff' }, at(30));
    expectRejected(apply(closed, { type: 'CLOSE', by: 'staff' }, at(31)), 'NOT_ALLOWED_IN_STATE');
  });

  it('閉じたあと、また開ける', () => {
    const closed = run(opened(), { type: 'CLOSE', by: 'staff' }, at(30));
    const again = run(closed, { type: 'OPEN', closesAt: at(300), by: 'staff' }, at(60));
    expect(again.operating).toBe(true);
    expect(again.closesAt).toBe(at(300));
    expect(tableOf(again, 'tb-4').status).toBe('FREE');
  });
});

describe('全席解放（7.9 の施設都合、12.6）', () => {
  /** 待ち・呼び出し・着席がすべて居る状態。 */
  function crowded(): VenueState {
    const tables = [table('tb-4', 4), table('tb-2', 2)];
    let state = run(closedVenue(QUIET, tables), { type: 'OPEN', closesAt: at(180), by: 'staff' }, NOW);
    state = join(state, 'k1', 3, at(1));
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(2));
    state = join(state, 'k2', 2, at(3));
    state = join(state, 'k3', 2, at(4));
    expect(ticketOf(state, 'k1').state).toBe('SEATED');
    expect(ticketOf(state, 'k2').state).toBe('CALLED');
    expect(ticketOf(state, 'k3').state).toBe('WAITING');
    return state;
  }

  it('待っている人も呼び出し中の人も取り消される', () => {
    const state = run(crowded(), { type: 'RELEASE_ALL', by: 'staff' }, at(10));
    expect(ticketOf(state, 'k2').state).toBe('CANCELLED');
    expect(ticketOf(state, 'k3').state).toBe('CANCELLED');
    expect(ticketOf(state, 'k2').endReason).toBe('venue_closed');
  });

  /** 7.3 の図「着席していた分は利用として扱う」。取り消しにはしない。 */
  it('着席中の人は利用として終わる', () => {
    const state = run(crowded(), { type: 'RELEASE_ALL', by: 'staff' }, at(10));
    expect(ticketOf(state, 'k1').state).toBe('DONE');
    expect(ticketOf(state, 'k1').endReason).toBe('auto_release');
  });

  it('すべての席が自由席に戻る', () => {
    const state = run(crowded(), { type: 'RELEASE_ALL', by: 'staff' }, at(10));
    expect(state.tables.every((item) => item.status === 'DISABLED')).toBe(true);
    expect(state.tables.every((item) => item.occupantTicketId === null)).toBe(true);
  });

  it('運用も受付も止まる', () => {
    const state = run(crowded(), { type: 'RELEASE_ALL', by: 'staff' }, at(10));
    expect(state.operating).toBe(false);
    expect(state.joinOpen).toBe(false);
    expect(state.closesAt).toBeNull();
  });

  it('解放のあとも不変条件は成立している', () => {
    expectHealthy(run(crowded(), { type: 'RELEASE_ALL', by: 'staff' }, at(10)));
  });

  it('解放を知らせ、続いて 1 枚ずつの終わりを知らせる', () => {
    const decided = expectOk(apply(crowded(), { type: 'RELEASE_ALL', by: 'staff' }, at(10)));
    expect(decided.events[0]).toMatchObject({ type: 'VenueClosed', reason: 'release_all' });
    const ended = decided.events.filter((event) => event.type === 'TicketEnded');
    expect(ended.map((event) => (event.type === 'TicketEnded' ? event.endReason : ''))).toEqual([
      'auto_release',
      'venue_closed',
      'venue_closed',
    ]);
  });

  /**
   * **この操作はいつでも動かなければならない**（CLAUDE.md 8 章）。障害時に
   * 自由席へ戻す手順が、システムの復旧より優先される。
   */
  it('運用していない施設でも通る', () => {
    const closed = run(crowded(), { type: 'CLOSE', by: 'staff' }, at(10));
    const released = run(closed, { type: 'RELEASE_ALL', by: 'staff' }, at(11));
    expect(released.tables.every((item) => item.status === 'DISABLED')).toBe(true);
    expect(ticketOf(released, 'k1').state).toBe('DONE');
  });

  it('何も無い施設でも通る', () => {
    expect(run(closedVenue(), { type: 'RELEASE_ALL', by: 'staff' }, NOW).operating).toBe(false);
  });
});

describe('席を対象から外す（7.6 のエッジケース）', () => {
  it('空席はその場で外れる', () => {
    const state = run(opened(), { type: 'DISABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(10));
    expect(tableOf(state, 'tb-4').status).toBe('DISABLED');
    expect(tableOf(state, 'tb-4').enabled).toBe(false);
  });

  it('外したことを知らせる', () => {
    const decided = expectOk(apply(opened(), { type: 'DISABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(10)));
    expect(eventTypes(decided)).toEqual(['TableDisabled']);
  });

  /** 7.6「`HELD`/`OCCUPIED` の席は現在の利用が終わってから反映」。 */
  it('使われている席は、利用が終わってから外れる', () => {
    let state = join(opened(), 'k1', 3, at(1));
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(2));
    state = run(state, { type: 'DISABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(3));

    expect(tableOf(state, 'tb-4').status).toBe('OCCUPIED');
    expect(tableOf(state, 'tb-4').enabled).toBe(true);
    expect(tableOf(state, 'tb-4').disableAfterCurrent).toBe(true);

    const left = run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(30));
    expect(tableOf(left, 'tb-4').status).toBe('DISABLED');
    expect(tableOf(left, 'tb-4').enabled).toBe(false);
  });

  it('呼び出し中の人は追い出されない', () => {
    let state = join(opened(), 'k1', 3, at(1));
    state = run(state, { type: 'DISABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(2));
    expect(ticketOf(state, 'k1').state).toBe('CALLED');
    expect(tableOf(state, 'tb-4').status).toBe('HELD');
  });

  it('外れるのを待っている席には、次の人を案内しない', () => {
    let state = join(opened(), 'k1', 3, at(1));
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(2));
    state = run(state, { type: 'DISABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(3));
    state = join(state, 'k2', 2, at(4));
    state = run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(30));

    expect(ticketOf(state, 'k2').state).toBe('WAITING');
    expect(tableOf(state, 'tb-4').status).toBe('DISABLED');
  });

  it('外した席は、次の運用が始まっても戻らない', () => {
    const state = run(opened(), { type: 'DISABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(10));
    const closed = run(state, { type: 'CLOSE', by: 'staff' }, at(20));
    const reopened = run(closed, { type: 'OPEN', closesAt: null, by: 'staff' }, at(30));
    expect(tableOf(reopened, 'tb-4').status).toBe('DISABLED');
  });

  it('存在しない席は外せない', () => {
    expectRejected(apply(opened(), { type: 'DISABLE_TABLE', tableId: 'nope', by: 'staff' }, at(10)), 'TABLE_NOT_FOUND');
  });
});

describe('席を対象に戻す（7.6 のエッジケース）', () => {
  it('運用中なら、その場で使えるようになる', () => {
    const excluded = run(opened(), { type: 'DISABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(10));
    const restored = run(excluded, { type: 'ENABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(11));
    expect(tableOf(restored, 'tb-4').status).toBe('FREE');
    expect(tableOf(restored, 'tb-4').enabled).toBe(true);
  });

  it('戻した席には、待っている人がすぐ案内される', () => {
    // 4 人席が 2 つ。片方を外し、もう片方は埋めておく。3 名は並ぶことになる。
    let state = opened(QUIET, [table('tb-4a', 4), table('tb-4b', 4)]);
    state = run(state, { type: 'DISABLE_TABLE', tableId: 'tb-4a', by: 'staff' }, at(10));
    state = join(state, 'k1', 4, at(11));
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4b' }, at(12));
    state = join(state, 'k2', 3, at(13));
    expect(ticketOf(state, 'k2').state).toBe('WAITING');

    const restored = run(state, { type: 'ENABLE_TABLE', tableId: 'tb-4a', by: 'staff' }, at(14));
    expect(ticketOf(restored, 'k2').state).toBe('CALLED');
    expect(ticketOf(restored, 'k2').tableId).toBe('tb-4a');
  });

  it('運用していなければ、対象に戻すだけで席は開かない', () => {
    const excluded = run(opened(), { type: 'DISABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(10));
    const closed = run(excluded, { type: 'CLOSE', by: 'staff' }, at(11));
    const restored = run(closed, { type: 'ENABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(12));
    expect(tableOf(restored, 'tb-4').enabled).toBe(true);
    expect(tableOf(restored, 'tb-4').status).toBe('DISABLED');
  });

  it('外れるのを待っている予約も取り消される', () => {
    let state = join(opened(), 'k1', 3, at(1));
    state = run(state, { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(2));
    state = run(state, { type: 'DISABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(3));
    state = run(state, { type: 'ENABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(4));
    expect(tableOf(state, 'tb-4').disableAfterCurrent).toBe(false);

    const left = run(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(30));
    expect(tableOf(left, 'tb-4').status).toBe('FREE');
  });

  it('存在しない席は戻せない', () => {
    expectRejected(apply(opened(), { type: 'ENABLE_TABLE', tableId: 'nope', by: 'staff' }, at(10)), 'TABLE_NOT_FOUND');
  });
});

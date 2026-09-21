import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from './domain/policy.js';
import { createTable, type Table } from './domain/table.js';
import { createTicket, type Ticket } from './domain/ticket.js';
import { createVenueState, type VenueState } from './domain/state.js';
import { minutes, type Timestamp } from './time.js';
import { estimateForJoin, estimateForTicket, type WaitEstimate } from './eta.js';

/**
 * 待ち時間の推定（全体プラン 7.13）。
 *
 * 7.13 は式で書かれているので、**式の各項を 1 つずつ確かめる**形にしてある。
 * 席の状態ごとの見積もり（`r_t`）、前に並んでいる組（`k`）、表示の幅の 3 つ。
 */

const NOW: Timestamp = 1_700_000_000_000;

function at(elapsedMin: number): Timestamp {
  return NOW + minutes(elapsedMin);
}

function table(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE', ...overrides };
}

function ticket(id: string, partySize: number, overrides: Partial<Ticket> = {}): Ticket {
  return { ...createTicket({ id, code: id, partySize, now: NOW }), ...overrides };
}

function venue(
  tables: readonly Table[],
  tickets: readonly Ticket[] = [],
  policy: Policy = DEFAULT_POLICY,
): VenueState {
  return {
    ...createVenueState({ venueId: 'v1', policy, tables }),
    tickets,
    operating: true,
    joinOpen: true,
  };
}

/** 2 名の組がいま登録したら、という見積もり。 */
function forJoin(state: VenueState, now: Timestamp, partySize = 2): WaitEstimate {
  return estimateForJoin(state, { partySize, requiredTags: [] }, now);
}

/** 目安の分数。見積もれない場合はテストを落とす。 */
function minutesOf(estimate: WaitEstimate): number {
  if (estimate.kind !== 'estimate') throw new Error(`見積もれなかった: ${estimate.kind}`);
  return estimate.minutes;
}

// ---------------------------------------------------------------------------

describe('席の状態ごとの見積もり（7.13 の r_t）', () => {
  it('空席があれば 5 分未満', () => {
    expect(forJoin(venue([table('tb-2', 2)]), NOW)).toMatchObject({
      minutes: 0,
      fromMin: 0,
      toMin: 5,
    });
  });

  it('片付け中の席は、猶予の残りで数える', () => {
    const policy: Policy = { ...DEFAULT_POLICY, turnoverMin: 3 };
    const cleaning = table('tb-2', 2, { status: 'TURNOVER', statusSince: NOW });
    expect(minutesOf(forJoin(venue([cleaning], [], policy), at(1)))).toBe(2);
  });

  it('片付けの猶予が 0 分の施設では、空席と同じに数える', () => {
    const cleaning = table('tb-2', 2, { status: 'TURNOVER', statusSince: NOW });
    expect(minutesOf(forJoin(venue([cleaning]), at(1)))).toBe(0);
  });

  /** 呼び出した人が着いてから、さらに滞在する。 */
  it('確保されている席は、ホールドの残りに想定滞在を足す', () => {
    const held = table('tb-2', 2, { status: 'HELD', occupantTicketId: 'k1' });
    const holder = ticket('k1', 2, {
      state: 'CALLED',
      tableId: 'tb-2',
      calledAt: NOW,
      holdDeadline: at(7),
    });
    // 2 分の時点で、ホールドの残りは 5 分。35 分の滞在を足して 40 分。
    expect(minutesOf(forJoin(venue([held], [holder]), at(2)))).toBe(40);
  });

  it('延長された席は、延びた期限で数える', () => {
    const held = table('tb-2', 2, { status: 'HELD', occupantTicketId: 'k1' });
    const holder = ticket('k1', 2, {
      state: 'CALLED',
      tableId: 'tb-2',
      calledAt: NOW,
      holdDeadline: at(10),
      extensions: 1,
    });
    expect(minutesOf(forJoin(venue([held], [holder]), at(2)))).toBe(43);
  });

  it('着席中の席は、想定滞在から経過ぶんを引く', () => {
    const occupied = table('tb-2', 2, { status: 'OCCUPIED', occupantTicketId: 'k1' });
    const guest = ticket('k1', 2, { state: 'SEATED', tableId: 'tb-2', seatedAt: NOW });
    expect(minutesOf(forJoin(venue([occupied], [guest]), at(10)))).toBe(25);
  });

  /** v1 の割り切り。長く座っている人ほど「いつ立ってもおかしくない」と見る。 */
  it('想定滞在を超えて座っている席は 0 分になる', () => {
    const occupied = table('tb-2', 2, { status: 'OCCUPIED', occupantTicketId: 'k1' });
    const guest = ticket('k1', 2, { state: 'SEATED', tableId: 'tb-2', seatedAt: NOW });
    expect(minutesOf(forJoin(venue([occupied], [guest]), at(50)))).toBe(0);
  });

  it('着席の記録が無い席は、その状態になった時刻から数える', () => {
    const unknown = table('tb-2', 2, { status: 'OCCUPIED', statusSince: at(5) });
    expect(minutesOf(forJoin(venue([unknown]), at(10)))).toBe(30);
  });
});

// ---------------------------------------------------------------------------

/**
 * **確証の無い席は、システムが空けると決めている時刻で数える**（7.11 の 5 層目）。
 *
 * 既定値では、使用中（誰か不明）は 40 分で「確認要」に落ち、そこから 30 分で
 * 自動解放される。合わせて 70 分が、その席が確実に空く時刻になる。
 */
describe('確証の無い席（7.13、7.11 の 5 層目）', () => {
  it('使用中（誰か不明）の席は、確認要に落ちて自動解放されるまでで数える', () => {
    const unknown = table('tb-2', 2, { status: 'OCCUPIED_UNKNOWN', statusSince: NOW });
    expect(minutesOf(forJoin(venue([unknown]), NOW))).toBe(70);
  });

  it('確認要の席は、自動解放までで数える', () => {
    const uncertain = table('tb-2', 2, { status: 'NEEDS_CHECK', statusSince: NOW });
    expect(minutesOf(forJoin(venue([uncertain]), NOW))).toBe(30);
  });

  /**
   * **状態が移るところで数字が跳ねない。** 使用中（不明）のまま 40 分たった席は
   * 残り 30 分。その瞬間に確認要へ落ちても、やはり残り 30 分である。
   */
  it('使用中から確認要へ移っても、目安が跳ねない', () => {
    const unknown = table('tb-2', 2, { status: 'OCCUPIED_UNKNOWN', statusSince: NOW });
    const uncertain = table('tb-2', 2, { status: 'NEEDS_CHECK', statusSince: at(40) });
    expect(minutesOf(forJoin(venue([unknown]), at(40)))).toBe(30);
    expect(minutesOf(forJoin(venue([uncertain]), at(40)))).toBe(30);
  });

  it('自動解放を切っている施設では、確認要も使用中と同じに数える', () => {
    const policy: Policy = { ...DEFAULT_POLICY, needsCheckAutoFreeMin: null };
    const uncertain = table('tb-2', 2, { status: 'NEEDS_CHECK', occupantTicketId: 'k1' });
    const guest = ticket('k1', 2, { state: 'SEATED', tableId: 'tb-2', seatedAt: NOW });
    expect(minutesOf(forJoin(venue([uncertain], [guest], policy), at(10)))).toBe(25);
  });

  it('自動解放を切っている施設では、使用中（不明）も想定滞在で数える', () => {
    const policy: Policy = { ...DEFAULT_POLICY, needsCheckAutoFreeMin: null };
    const unknown = table('tb-2', 2, { status: 'OCCUPIED_UNKNOWN', statusSince: NOW });
    expect(minutesOf(forJoin(venue([unknown], [], policy), at(10)))).toBe(25);
  });
});

// ---------------------------------------------------------------------------

describe('前に並んでいる組（7.13 の k）', () => {
  /** 2 名席が 3 卓。空く時刻がそれぞれ 0 分、10 分、20 分になるように置く。 */
  function threeSeats(): readonly Table[] {
    return [
      table('tb-a', 2),
      table('tb-b', 2, { status: 'OCCUPIED', statusSince: at(-25) }),
      table('tb-c', 2, { status: 'OCCUPIED', statusSince: at(-15) }),
    ];
  }

  it('前に誰もいなければ、いちばん早く空く席の時刻になる', () => {
    expect(minutesOf(forJoin(venue(threeSeats()), NOW))).toBe(0);
  });

  it('前に 1 組いれば、2 番目に早く空く席の時刻になる', () => {
    const state = venue(threeSeats(), [ticket('k1', 2)]);
    expect(minutesOf(forJoin(state, NOW))).toBe(10);
  });

  it('前に 2 組いれば、3 番目に早く空く席の時刻になる', () => {
    const state = venue(threeSeats(), [ticket('k1', 2), ticket('k2', 2)]);
    expect(minutesOf(forJoin(state, NOW))).toBe(20);
  });

  /** 順番は保持されているので、戻ってくれば自分より先に案内される（7.7 の 5）。 */
  it('保留中の人も前の組に数える', () => {
    const paused = ticket('k1', 2, {
      state: 'PAUSED',
      pauseDeadline: at(10),
      pausedSince: NOW,
    });
    expect(minutesOf(forJoin(venue(threeSeats(), [paused]), NOW))).toBe(10);
  });

  /** その席はもう確保されていて、`r_t` の側に織り込んである。 */
  it('呼び出し中の人は前の組に数えない', () => {
    const called = ticket('k1', 2, {
      state: 'CALLED',
      tableId: 'tb-a',
      calledAt: NOW,
      holdDeadline: at(7),
    });
    const seats = [
      table('tb-a', 2, { status: 'HELD', occupantTicketId: 'k1' }),
      table('tb-b', 2, { status: 'OCCUPIED', statusSince: at(-25) }),
      table('tb-c', 2, { status: 'OCCUPIED', statusSince: at(-15) }),
    ];
    // 確保された席は 7 + 35 = 42 分。前に誰もいないので、いちばん早い 10 分。
    expect(minutesOf(forJoin(venue(seats, [called]), NOW))).toBe(10);
  });

  it('終わったチケットは前の組に数えない', () => {
    const done = ticket('k1', 2, { state: 'DONE', endedAt: NOW, endReason: 'checked_out' });
    expect(minutesOf(forJoin(venue(threeSeats(), [done]), NOW))).toBe(0);
  });

  /** 6 名組は 2 名席を取り合わない。 */
  it('自分の席に収まらない人は数えない', () => {
    const big = ticket('k1', 6);
    expect(minutesOf(forJoin(venue(threeSeats(), [big]), NOW))).toBe(0);
  });

  it('自分より小さい組は、同じ席を取り合うので数える', () => {
    const small = ticket('k1', 1);
    expect(minutesOf(forJoin(venue(threeSeats(), [small]), NOW))).toBe(10);
  });

  it('希望タグを満たせない人は数えない', () => {
    const seats = [table('tb-a', 2, { tags: [] }), table('tb-b', 2, { status: 'OCCUPIED', statusSince: at(-25) })];
    const needsPower = ticket('k1', 2, { requiredTags: ['power'] });
    expect(minutesOf(forJoin(venue(seats, [needsPower]), NOW))).toBe(0);
  });

  describe('並んでいる人の見積もり', () => {
    it('自分は前の組に数えない', () => {
      const mine = ticket('k1', 2);
      const state = venue(threeSeats(), [mine]);
      expect(minutesOf(estimateForTicket(state, mine, NOW))).toBe(0);
    });

    it('自分より受付が早い人だけを数える', () => {
      const earlier = ticket('k0', 2, { priorityAt: at(-5) });
      const mine = ticket('k1', 2, { priorityAt: NOW });
      const later = ticket('k2', 2, { priorityAt: at(5) });
      const state = venue(threeSeats(), [earlier, mine, later]);
      expect(minutesOf(estimateForTicket(state, mine, NOW))).toBe(10);
    });

    it('保留中の人にも目安を返す（準備OK を押すかの判断に要る）', () => {
      const paused = ticket('k1', 2, { state: 'PAUSED', pauseDeadline: at(10), pausedSince: NOW });
      expect(estimateForTicket(venue(threeSeats(), [paused]), paused, NOW).kind).toBe('estimate');
    });

    it.each([
      ['CALLED', { state: 'CALLED' as const, tableId: 'tb-a', calledAt: NOW, holdDeadline: at(7) }],
      ['SEATED', { state: 'SEATED' as const, tableId: 'tb-a', seatedAt: NOW }],
      ['DONE', { state: 'DONE' as const, endedAt: NOW, endReason: 'checked_out' as const }],
    ])('%s のチケットには目安を返さない', (_label, overrides) => {
      const item = ticket('k1', 2, overrides);
      expect(estimateForTicket(venue(threeSeats(), [item]), item, NOW).kind).toBe('not_waiting');
    });
  });
});

// ---------------------------------------------------------------------------

/**
 * **待ちが席数より多いときは、席が回るのを待つ**（7.13 に書かれていない場面）。
 *
 * 7.13 の式は `k + 1` 番目の `r_t` を採るとしか書いていないが、席が 2 卓で
 * 前に 5 組いれば 6 番目の席は無い。過負荷のときこそ数字が要る（7.5 の 5）。
 * 席が空くたびに前の人から入っていき、入られた席は滞在のぶんまた埋まる、
 * という形で数える。
 */
describe('待ちが席数より多いとき', () => {
  /** 2 名席が 2 卓。いま両方とも空いている。 */
  function twoFreeSeats(count: number): VenueState {
    const waiting = Array.from({ length: count }, (_unused, index) => ticket(`k${String(index)}`, 2));
    return venue([table('tb-a', 2), table('tb-b', 2)], waiting);
  }

  it('前に 1 組なら、2 卓目がそのまま使える（1 巡目）', () => {
    expect(minutesOf(forJoin(twoFreeSeats(1), NOW))).toBe(0);
  });

  it('前に 2 組なら、1 回転を待つ（想定滞在 1 回ぶん）', () => {
    expect(minutesOf(forJoin(twoFreeSeats(2), NOW))).toBe(35);
  });

  it('前に 5 組なら、2 回転を待つ', () => {
    expect(minutesOf(forJoin(twoFreeSeats(5), NOW))).toBe(70);
  });

  it('回転を待つ人ほど目安が長い（順番が逆転しない）', () => {
    const waits = [0, 1, 2, 3, 4, 5, 6].map((count) => minutesOf(forJoin(twoFreeSeats(count), NOW)));
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
  });

  /**
   * **滞在より長く待つ席があっても、順番が逆転しない。**
   *
   * 確保されている席は「ホールドの残り＋滞在」なので、滞在 1 回ぶんより長い。
   * 「何巡目か」で数える形だと、巡が変わるところで目安が縮んでしまう
   * （ここでは前に 2 組のときに 42 分から 35 分へ下がっていた）。
   */
  it('確保されている席があっても、前の組が増えるほど目安が伸びる', () => {
    function withHeldSeat(waiting: number): VenueState {
      const held = table('tb-b', 2, { status: 'HELD', occupantTicketId: 'h1' });
      const holder = ticket('h1', 2, {
        state: 'CALLED',
        tableId: 'tb-b',
        calledAt: NOW,
        holdDeadline: at(7),
      });
      const queue = Array.from({ length: waiting }, (_unused, index) =>
        ticket(`k${String(index)}`, 2),
      );
      return venue([table('tb-a', 2), held], [holder, ...queue]);
    }

    // 空席 0 分、確保中の席 7 + 35 = 42 分。前の組が増えるたびに伸びていく。
    expect([0, 1, 2, 3].map((count) => minutesOf(forJoin(withHeldSeat(count), NOW)))).toEqual([
      0, 35, 42, 70,
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('表示の幅（7.16 の eta_display）', () => {
  /** 2 名席 1 卓を、狙った分数だけ先に空くように置く。 */
  function freesIn(min: number): VenueState {
    const occupied = table('tb-2', 2, { status: 'OCCUPIED', statusSince: at(min - 35) });
    return venue([occupied]);
  }

  it('12 分の見込みは「10〜15 分」になる', () => {
    expect(forJoin(freesIn(12), NOW)).toMatchObject({ minutes: 12, fromMin: 10, toMin: 15 });
  });

  it('刻みちょうどの見込みは、そこから 1 刻みぶんの幅になる', () => {
    expect(forJoin(freesIn(15), NOW)).toMatchObject({ minutes: 15, fromMin: 15, toMin: 20 });
  });

  it('5 分未満は下限が 0 になる', () => {
    expect(forJoin(freesIn(3), NOW)).toMatchObject({ minutes: 3, fromMin: 0, toMin: 5 });
  });

  it('秒は切り上げる（目安を短く見せない）', () => {
    const occupied = table('tb-2', 2, { status: 'OCCUPIED', statusSince: NOW - 34 * 60_000 - 30_000 });
    expect(minutesOf(forJoin(venue([occupied]), NOW))).toBe(1);
  });

  it('刻みを変えると幅も変わる', () => {
    const policy: Policy = { ...DEFAULT_POLICY, etaBucketMin: 10 };
    const occupied = table('tb-2', 2, { status: 'OCCUPIED', statusSince: at(12 - 35) });
    expect(forJoin(venue([occupied], [], policy), NOW)).toMatchObject({ fromMin: 10, toMin: 20 });
  });

  it('前に何組いるかを返す（7.5 の画面）', () => {
    const state = venue([table('tb-2', 2)], [ticket('k1', 2), ticket('k2', 2)]);
    expect(forJoin(state, NOW)).toMatchObject({ ahead: 2 });
  });
});

// ---------------------------------------------------------------------------

describe('見積もれないとき', () => {
  it('人数が収まる席が無ければ、目安を返さない', () => {
    expect(forJoin(venue([table('tb-2', 2)]), NOW, 6).kind).toBe('no_seat');
  });

  it('希望タグを満たす席が無ければ、目安を返さない', () => {
    const state = venue([table('tb-2', 2)]);
    expect(estimateForJoin(state, { partySize: 2, requiredTags: ['power'] }, NOW).kind).toBe('no_seat');
  });

  it('運用していない時間帯は、目安を返さない', () => {
    const closed = table('tb-2', 2, { status: 'DISABLED' });
    expect(forJoin(venue([closed]), NOW).kind).toBe('no_seat');
  });

  it('対象から外した席は数に入らない', () => {
    const excluded = table('tb-2', 2, { status: 'DISABLED', enabled: false });
    const state = venue([excluded, table('tb-4', 4, { status: 'OCCUPIED', statusSince: NOW })]);
    // 使えるのは 4 名席だけ。空席の見込みにならない。
    expect(minutesOf(forJoin(state, NOW))).toBe(35);
  });
});

import { describe, expect, it } from 'vitest';
import type { DomainEvent, Table, Timestamp } from '../src/index.js';
import { createTable, createVenueState, DEFAULT_POLICY, minutes, seconds } from '../src/index.js';
import type { Party } from './agent.js';
import {
  collect,
  HISTOGRAM_BUCKETS,
  overtaking,
  spanCoverage,
  summarize,
} from './metrics.js';
import type { RunResult, TableSpan } from './runner.js';
import { SIM_EPOCH, TICK_INTERVAL } from './runner.js';

/**
 * 指標の検算（全体プラン 8.3）。
 *
 * **手で組み立てた小さな筋書きで確かめる。** シミュレータを走らせて出た数字を
 * 「それらしい」と眺めるのではなく、答えが分かっている入力を入れて、その答えが
 * 出ることを見る。シミュレータの側が変わっても、ここが壊れない。
 */

const TABLES: readonly Table[] = [
  { ...createTable({ id: 'tb0', label: 'A', capacity: 2, now: SIM_EPOCH }), status: 'FREE' },
  { ...createTable({ id: 'tb1', label: 'B', capacity: 4, now: SIM_EPOCH }), status: 'FREE' },
];

/** 開始から何分後か。 */
function at(min: number): Timestamp {
  return SIM_EPOCH + minutes(min);
}

function result(patch: Partial<RunResult>): RunResult {
  return {
    scenario: 'test',
    seed: 0,
    state: { ...createVenueState({ venueId: 'v1', policy: DEFAULT_POLICY, tables: TABLES }) },
    events: [],
    parties: [],
    sitters: [],
    commands: 0,
    ticks: 0,
    defects: [],
    estimates: [],
    balked: [],
    tableSpans: [],
    appliedAt: [],
    endedAt: at(60),
    ...patch,
  };
}

/** 到着した組。指標が見るのは人数だけなので、ほかは既定で埋める。 */
function party(index: number): Party {
  return {
    index,
    ticketId: `p${String(index)}`,
    arriveAt: SIM_EPOCH,
    partySize: 2,
    stay: minutes(30),
    walk: minutes(2),
    noShowRoll: 0.5,
    reportsCheckout: true,
    balkRoll: 0.5,
    hasNotificationChannel: true,
  };
}

function joined(ticketId: string, min: number, partySize: number): DomainEvent {
  return {
    type: 'TicketJoined',
    at: at(min),
    ticketId,
    code: ticketId,
    partySize,
    origin: 'JOIN',
  };
}

function called(ticketId: string, min: number): DomainEvent {
  return {
    type: 'TicketCalled',
    at: at(min),
    ticketId,
    tableId: 'tb0',
    holdDeadline: at(min + 7),
    reason: 'only_candidate',
  };
}

function seated(ticketId: string, min: number): DomainEvent {
  return { type: 'TicketSeated', at: at(min), ticketId, tableId: 'tb0' };
}

function span(patch: Partial<TableSpan> & Pick<TableSpan, 'status' | 'from' | 'until'>): TableSpan {
  return { tableId: 'tb0', occupantTicketId: null, ...patch };
}

// ---------------------------------------------------------------------------

describe('分布のまとめ方', () => {
  /**
   * **補間しない。** 3 人が 5・10・30 分待ったなら p90 は 30 分である。
   * 実際に誰かが待った長さだけを返す（存在しない 26 分を作らない）。
   */
  it('p90 は「これ以下に 9 割が入る」いちばん小さい実測値', () => {
    const seen = summarize([minutes(5), minutes(10), minutes(30)]);
    expect(seen).toMatchObject({ count: 3, meanMin: 15, p50Min: 10, p90Min: 30, maxMin: 30 });
  });

  /**
   * **偶数件の中央値を平均しない。**
   *
   * 3 件では補間する式としない式が同じ答えを出してしまい、区別できない
   * （実際、最初に書いたときは 3 件だけで確かめていて、補間に取り替えても
   * 落ちなかった）。偶数件はそこが分かれる。
   */
  it('偶数件でも補間せず、下側の実測値を返す', () => {
    const seen = summarize([minutes(10), minutes(20), minutes(30), minutes(40)]);
    expect(seen.p50Min).toBe(20);
    expect(seen.p90Min).toBe(40);
  });

  it('1 件も無ければ 0 を返し、件数が 0 だと語る', () => {
    expect(summarize([])).toMatchObject({ count: 0, meanMin: 0, p90Min: 0 });
  });

  it('分は小数第 1 位まで丸める', () => {
    expect(summarize([seconds(95)]).meanMin).toBe(1.6);
  });

  it('ヒストグラムは 5 分刻みで、上限を超えたものは最後の階級に入る', () => {
    const seen = summarize([minutes(3), minutes(7), minutes(12), minutes(95)]);
    expect(seen.histogram).toHaveLength(HISTOGRAM_BUCKETS);
    expect(seen.histogram[0]).toBe(1);
    expect(seen.histogram[1]).toBe(1);
    expect(seen.histogram[2]).toBe(1);
    expect(seen.histogram[HISTOGRAM_BUCKETS - 1]).toBe(1);
  });
});

describe('来た組がどうなったか', () => {
  it('到着・やめた・受付・着席の数が合う', () => {
    const seen = collect(
      result({
        parties: [party(0), party(1), party(2), party(3)],
        balked: ['p3'],
        events: [joined('p0', 0, 2), joined('p1', 1, 2), called('p0', 5), seated('p0', 7)],
      }),
    );
    expect(seen.demand).toMatchObject({
      arrived: 4,
      balked: 1,
      joined: 2,
      seated: 1,
      leftWithoutSeat: 1,
      // 4 組来て 1 組やめて 2 組しか受け付けていないので、1 組は断られている。
      refused: 1,
    });
  });

  it('飛び込みは受付した組に数えない', () => {
    const walkIn: DomainEvent = {
      type: 'TicketJoined',
      at: at(3),
      ticketId: 'w0',
      code: 'w0',
      partySize: 2,
      origin: 'WALK_IN',
    };
    const seen = collect(result({ parties: [party(0)], events: [joined('p0', 0, 2), walkIn] }));
    expect(seen.demand).toMatchObject({ joined: 1, walkIns: 1 });
  });
});

describe('待ち時間', () => {
  it('受付から呼び出しまでと、受付から着席までを分けて測る', () => {
    const seen = collect(
      result({ parties: [party(0)], events: [joined('p0', 0, 2), called('p0', 12), seated('p0', 15)] }),
    );
    expect(seen.wait.meanMin).toBe(12);
    expect(seen.toSeat.meanMin).toBe(15);
  });

  it('2 度目の呼び出しではなく、最初の呼び出しまでを測る', () => {
    const seen = collect(
      result({ parties: [party(0)], events: [joined('p0', 0, 2), called('p0', 10), called('p0', 40)] }),
    );
    expect(seen.wait.meanMin).toBe(10);
  });

  it('人数別に分け、いない人数の行も残す', () => {
    const seen = collect(
      result({
        parties: [party(0), party(1)],
        events: [joined('p0', 0, 2), joined('p1', 0, 4), called('p0', 30), called('p1', 10)],
      }),
    );
    expect(seen.bySize.map((slice) => slice.partySize)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen.bySize[1]).toMatchObject({ parties: 1, wait: { meanMin: 30 } });
    expect(seen.bySize[3]).toMatchObject({ parties: 1, wait: { meanMin: 10 } });
    expect(seen.bySize[4]).toMatchObject({ parties: 0, wait: { count: 0 } });
  });
});

describe('席の使われ方', () => {
  it('運用していた時間を分母にして、状態ごとの割合を出す', () => {
    const seen = collect(
      result({
        endedAt: at(40),
        tableSpans: [
          span({ status: 'FREE', from: at(0), until: at(10) }),
          span({ status: 'HELD', from: at(10), until: at(20), occupantTicketId: 'p0' }),
          span({ status: 'OCCUPIED', from: at(20), until: at(40), occupantTicketId: 'p0' }),
        ],
      }),
    );
    expect(seen.seatUse).toMatchObject({
      managedTableMin: 40,
      freeShare: 0.25,
      heldShare: 0.25,
      occupiedShare: 0.5,
    });
  });

  it('運用から外れていた時間は分母に入れない', () => {
    const seen = collect(
      result({
        tableSpans: [
          span({ status: 'DISABLED', from: at(0), until: at(20) }),
          span({ status: 'OCCUPIED', from: at(20), until: at(40), occupantTicketId: 'p0' }),
        ],
      }),
    );
    expect(seen.seatUse).toMatchObject({ managedTableMin: 20, occupiedShare: 1 });
  });

  /** 4 人席に 2 人が座っているあいだは 0.5。稼働率とは別に動く（7.6）。 */
  it('定員の埋まりは、使われていた卓だけで測る', () => {
    const seen = collect(
      result({
        events: [joined('p0', 0, 2)],
        tableSpans: [
          span({ tableId: 'tb1', status: 'FREE', from: at(0), until: at(20) }),
          span({
            tableId: 'tb1',
            status: 'OCCUPIED',
            from: at(20),
            until: at(40),
            occupantTicketId: 'p0',
          }),
        ],
      }),
    );
    expect(seen.seatUse.fillShare).toBe(0.5);
  });
});

describe('ノーショーで遊ばせた席時間', () => {
  /**
   * **区間の終わりとノーショーの時刻は一致しない。**
   *
   * 期限はその期限の時刻で処理される（PR 6）が、空いた席が同じ刻みのうちに
   * 次の人へ確保されると、区間の切れ目はその確保の時刻になる。時刻の一致で
   * 探していたときは、実測で 7 件のうち 5 件を取りこぼしていた。
   */
  it('席がすぐ次の人に渡っても、前の人のぶんを数える', () => {
    const missed: DomainEvent = {
      type: 'TicketPaused',
      at: at(17),
      ticketId: 'p0',
      until: at(27),
      reason: 'no_show',
    };
    const seen = collect(
      result({
        events: [joined('p0', 0, 2), called('p0', 10), missed],
        tableSpans: [
          // 期限は 17 分だが、切れ目は次の確保が起きた刻みの時刻になっている。
          span({
            status: 'HELD',
            from: at(10),
            until: at(17) + TICK_INTERVAL,
            occupantTicketId: 'p0',
          }),
        ],
      }),
    );
    expect(seen.seatUse.noShowLostMin).toBe(7);
  });

  it('来た人の確保は数えない', () => {
    const seen = collect(
      result({
        events: [joined('p0', 0, 2), called('p0', 10), seated('p0', 12)],
        tableSpans: [span({ status: 'HELD', from: at(10), until: at(12), occupantTicketId: 'p0' })],
      }),
    );
    expect(seen.seatUse.noShowLostMin).toBe(0);
  });
});

describe('事故と回復', () => {
  it('「案内された席が塞がっていた」は、先頭へ戻された回数で数える', () => {
    const takenBack: DomainEvent = {
      type: 'TicketRequeued',
      at: at(12),
      ticketId: 'p0',
      priorityAt: at(0),
      reason: 'seat_taken',
    };
    const lateBack: DomainEvent = { ...takenBack, ticketId: 'p1', reason: 'no_show' };
    const seen = collect(
      result({ events: [called('p0', 10), called('p1', 10), takenBack, lateBack] }),
    );
    expect(seen.incidents).toMatchObject({ calls: 2, seatTaken: 1, seatTakenRate: 0.5 });
  });

  /** 確認要が何に変わったかで、誰が片づけたのかが分かる（8.3 のスタッフ介入）。 */
  it('確認要が、次にどの姿になったかを数える', () => {
    const marked: DomainEvent = {
      type: 'TableNeedsCheck',
      at: at(20),
      tableId: 'tb0',
      reason: 'no_answer',
      occupantTicketId: 'p0',
    };
    const seen = collect(
      result({
        events: [marked, { ...marked, at: at(50), tableId: 'tb1', reason: 'overstay' }],
        tableSpans: [
          span({ status: 'NEEDS_CHECK', from: at(20), until: at(30) }),
          span({ status: 'FREE', from: at(30), until: at(60) }),
          span({ tableId: 'tb1', status: 'NEEDS_CHECK', from: at(50), until: at(55) }),
          span({ tableId: 'tb1', status: 'OCCUPIED', from: at(55), until: at(60) }),
        ],
      }),
    );
    expect(seen.recovery).toMatchObject({
      needsCheck: 2,
      byNoAnswer: 1,
      byOverstay: 1,
      needsCheckMin: 15,
    });
    expect(seen.recovery.clearedTo).toMatchObject({ FREE: 1, OCCUPIED: 1, DISABLED: 0 });
  });
});

describe('終わり方', () => {
  /** **起きなかった終わり方も 0 として残す。** どれを測れていないかが見えるため。 */
  it('10 通りすべてを、0 も含めて出す', () => {
    const ended: DomainEvent = {
      type: 'TicketEnded',
      at: at(30),
      ticketId: 'p0',
      endReason: 'checked_out',
      by: 'user',
      cancelReason: null,
    };
    const seen = collect(result({ events: [ended] }));
    expect(Object.keys(seen.endings)).toHaveLength(10);
    expect(seen.endings.checked_out).toBe(1);
    expect(seen.endings.user_cancel).toBe(0);
    expect(seen.endings.abandoned).toBe(0);
  });
});

describe('順番が守られたか', () => {
  it('自分より後から来たのに先に席へ向かえた組を数える', () => {
    const seen = overtaking([
      { at: at(0), reachedAt: at(30) },
      { at: at(1), reachedAt: at(10) },
      { at: at(2), reachedAt: at(20) },
    ]);
    // 先頭の組は、後から来た 2 組に抜かれている。
    expect(seen).toMatchObject({ overtakenMean: 0.67, overtakenMax: 2, overtakenShare: 0.333 });
  });

  it('順番どおりなら 0', () => {
    expect(
      overtaking([
        { at: at(0), reachedAt: at(10) },
        { at: at(1), reachedAt: at(20) },
      ]),
    ).toMatchObject({ overtakenMean: 0, overtakenMax: 0 });
  });
});

describe('目安の誤差', () => {
  it('予測と実績を突き合わせ、呼ばれなかった人は別に数える', () => {
    const seen = collect(
      result({
        estimates: [
          { ticketId: 'p0', at: at(0), minutes: 20 },
          { ticketId: 'p1', at: at(0), minutes: 30 },
        ],
        events: [joined('p0', 0, 2), called('p0', 12)],
      }),
    );
    // 予測 20 分に対し実績 12 分。長めに出しているので偏りは正。
    expect(seen.eta).toMatchObject({ samples: 1, unmatched: 1, maeMin: 8, biasMin: 8 });
  });

  it('実績が画面の幅に入ったかを数える', () => {
    const seen = collect(
      result({
        // 既定の刻みは 5 分なので、予測 12 分の幅は 10〜15 分。
        estimates: [{ ticketId: 'p0', at: at(0), minutes: 12 }],
        events: [joined('p0', 0, 2), called('p0', 11)],
      }),
    );
    expect(seen.eta.inBucketShare).toBe(1);
  });
});

describe('席の区間の検算', () => {
  /**
   * **覆い漏れは数字を静かに小さくするだけで、例外を出さない。**
   * だから CLI は書き出しの手前でここを見る。
   */
  it('席ごとに、開始から見届けた時刻までを隙間なく覆っていれば一致する', () => {
    const seen = spanCoverage(
      result({
        endedAt: at(30),
        tableSpans: [
          span({ status: 'FREE', from: at(0), until: at(30) }),
          span({ tableId: 'tb1', status: 'FREE', from: at(0), until: at(30) }),
        ],
      }),
    );
    expect(seen).toEqual({ expectedMin: 60, observedMin: 60 });
  });

  it('区間が足りなければ、期待と観測が食い違う', () => {
    const seen = spanCoverage(
      result({ endedAt: at(30), tableSpans: [span({ status: 'FREE', from: at(0), until: at(30) })] }),
    );
    expect(seen.observedMin).toBeLessThan(seen.expectedMin);
  });
});

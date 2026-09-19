import { describe, expect, it } from 'vitest';
import type { DomainEvent, DomainEventType, Timestamp } from '../src/index.js';
import { DEFAULT_POLICY, minutes } from '../src/index.js';
import { createParty, decidesNoShow } from './agent.js';
import { openVenue, run, SIM_EPOCH, TICK_INTERVAL, type RunResult } from './runner.js';
import {
  seatCount,
  TABLES_26,
  WEEKDAY_LUNCH,
  WEEKEND_OVERLOAD,
  WEEKEND_PEAK,
  withCheckoutReportRate,
  withPolicy,
  withUnregisteredRate,
  withWalkInShare,
  type Scenario,
} from './scenario.js';

/**
 * 短いシナリオ。**多数回まわす検査に使う。**
 *
 * 土日昼のピークの最初の 1 時間だけを切り出す。1 回あたりの `tick` が
 * 4 分の 1 になるので、100 回まわしても数秒で終わる。見ている性質
 * （不変条件が破れないこと）は長さに依らない。
 */
const SHORT: Scenario = {
  ...WEEKEND_PEAK,
  name: 'short',
  arrivals: WEEKEND_PEAK.arrivals.slice(0, 4),
  joinOpenFor: minutes(60),
};

function typesOf(events: readonly DomainEvent[]): readonly DomainEventType[] {
  return events.map((event) => event.type);
}

function countOf(result: RunResult, type: DomainEventType): number {
  return result.events.filter((event) => event.type === type).length;
}

function ticketStates(result: RunResult): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const ticket of result.state.tickets) {
    counts[ticket.state] = (counts[ticket.state] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------

describe('施設の組み立て', () => {
  const state = openVenue(WEEKEND_PEAK);

  it('席の数がシナリオどおりになる', () => {
    expect(state.tables).toHaveLength(4 + 3 + 1);
    expect(state.tables.reduce((sum, table) => sum + table.capacity, 0)).toBe(seatCount(TABLES_26));
  });

  it('席はすべて空席から始まり、管理対象になっている', () => {
    expect(state.tables.every((table) => table.status === 'FREE' && table.enabled)).toBe(true);
  });

  it('運用中で、受付が開いている', () => {
    expect(state.operating).toBe(true);
    expect(state.joinOpen).toBe(true);
  });

  it('席の ID とラベルが重複しない', () => {
    expect(new Set(state.tables.map((table) => table.id)).size).toBe(state.tables.length);
    expect(new Set(state.tables.map((table) => table.label)).size).toBe(state.tables.length);
  });

  it('シナリオの運用パラメータがそのまま入る', () => {
    expect(state.policy).toBe(WEEKEND_PEAK.policy);
  });
});

describe('再現できること', () => {
  it('同じシードで 2 回走らせると、イベント列が完全に一致する', () => {
    const first = run({ scenario: SHORT, seed: 1234 });
    const second = run({ scenario: SHORT, seed: 1234 });
    expect(second.events).toEqual(first.events);
  });

  it('同じシードなら、最後の状態も一致する', () => {
    const first = run({ scenario: SHORT, seed: 1234 });
    const second = run({ scenario: SHORT, seed: 1234 });
    expect(second.state).toEqual(first.state);
  });

  it('同じシードなら、到着する組の性質も一致する', () => {
    const first = run({ scenario: SHORT, seed: 77 });
    const second = run({ scenario: SHORT, seed: 77 });
    expect(second.parties).toEqual(first.parties);
  });

  it('シードが違えば別の結果になる', () => {
    const first = run({ scenario: SHORT, seed: 1 });
    const second = run({ scenario: SHORT, seed: 2 });
    expect(typesOf(second.events)).not.toEqual(typesOf(first.events));
  });

  /**
   * **方針を変えても、来る人は変わらない（共通乱数）。**
   *
   * 8.2 の比較が成り立つ条件そのもの。ノーショーの扱いを変えると乱数を引く
   * 回数は変わるが、到着も人数も滞在時間も 1 つも動かない。
   */
  it('運用パラメータを変えても、到着する組はまったく同じ', () => {
    const base = run({ scenario: SHORT, seed: 9 });
    const strict = run({
      scenario: withPolicy(SHORT, { ...DEFAULT_POLICY, noShowPolicy: 'cancel' }),
      seed: 9,
    });
    expect(strict.parties).toEqual(base.parties);
  });

  it('運用パラメータを変えると、結果は変わる', () => {
    const base = run({ scenario: SHORT, seed: 9 });
    const patient = run({
      scenario: withPolicy(SHORT, { ...DEFAULT_POLICY, holdMin: 30 }),
      seed: 9,
    });
    expect(typesOf(patient.events)).not.toEqual(typesOf(base.events));
  });
});

describe('仮想の時計', () => {
  const result = run({ scenario: SHORT, seed: 5 });

  it('コマンドを投入した時刻が巻き戻らない', () => {
    const wentBack = result.appliedAt.filter(
      (at, index) => index > 0 && at < (result.appliedAt[index - 1] ?? at),
    );
    expect(wentBack).toEqual([]);
  });

  it('コマンドは、開始から終了までのあいだに投入される', () => {
    expect(result.appliedAt.every((at) => at >= SIM_EPOCH && at <= result.endedAt)).toBe(true);
  });

  it('tick は 10 秒ごとに呼ばれる（9.4）', () => {
    expect(TICK_INTERVAL).toBe(10_000);
    const span: number = result.endedAt - SIM_EPOCH;
    expect(result.ticks).toBe(Math.floor(span / TICK_INTERVAL) + 1);
  });

  it('受付を閉じたあとも、しばらく見届ける', () => {
    expect(result.endedAt - SIM_EPOCH).toBe(SHORT.joinOpenFor + minutes(60));
  });

  it('見届ける時間を変えられる', () => {
    const short = run({ scenario: SHORT, seed: 5, cooldown: minutes(10) });
    expect(short.endedAt - SIM_EPOCH).toBe(SHORT.joinOpenFor + minutes(10));
  });
});

describe('到着と受付', () => {
  const result = run({ scenario: SHORT, seed: 3 });

  it('到着した組がひととおり現れる', () => {
    expect(result.parties.length).toBeGreaterThan(5);
  });

  it('到着は受付時間のあいだに収まる', () => {
    const last: Timestamp = SIM_EPOCH + SHORT.joinOpenFor;
    expect(result.parties.every((party) => party.arriveAt >= SIM_EPOCH && party.arriveAt < last)).toBe(true);
  });

  it('到着した順に並んでいる', () => {
    const sorted = result.parties.every(
      (party, index) => index === 0 || party.arriveAt >= (result.parties[index - 1]?.arriveAt ?? 0),
    );
    expect(sorted).toBe(true);
  });

  it('チケットの ID が重複しない', () => {
    const ids = result.parties.map((party) => party.ticketId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('受付のイベントが、受け付けられた組の数だけ出る', () => {
    expect(countOf(result, 'TicketJoined')).toBe(result.state.tickets.length);
  });

  it('到着した組は、受け付けられるか断られるかのどちらか', () => {
    expect(result.state.tickets.length).toBeLessThanOrEqual(result.parties.length);
  });
});

describe('一周が回る', () => {
  /** 全員が退席を申告する場合。PR 10 までは、これが健全に回る唯一の設定。 */
  const result = run({ scenario: withCheckoutReportRate(SHORT, 1), seed: 12 });

  it('呼び出し・着席・退席がすべて起きる', () => {
    expect(countOf(result, 'TicketCalled')).toBeGreaterThan(0);
    expect(countOf(result, 'TicketSeated')).toBeGreaterThan(0);
    expect(countOf(result, 'TableVacated')).toBeGreaterThan(0);
  });

  it('席が繰り返し使われる（卓数より多く着席が起きる）', () => {
    expect(countOf(result, 'TicketSeated')).toBeGreaterThan(result.state.tables.length);
  });

  it('呼び出しと席の確保が対になっている', () => {
    expect(countOf(result, 'TableHeld')).toBe(countOf(result, 'TicketCalled'));
  });

  it('着席と席の使用開始が対になっている', () => {
    expect(countOf(result, 'TableOccupied')).toBe(countOf(result, 'TicketSeated'));
  });

  it('最後には、ほとんどの人が使い終わっている', () => {
    const states = ticketStates(result);
    expect(states['DONE'] ?? 0).toBeGreaterThan((states['SEATED'] ?? 0) + (states['WAITING'] ?? 0));
  });

  it('終わったチケットは席を持たない', () => {
    const ended = result.state.tickets.filter((ticket) => ticket.endedAt !== null);
    expect(ended.every((ticket) => ticket.tableId === null)).toBe(true);
  });
});

describe('ノーショーと遅刻', () => {
  it('呼ばれても来ない人がいる（8.1 のノーショー率）', () => {
    const result = run({ scenario: withCheckoutReportRate(SHORT, 1), seed: 31 });
    expect(countOf(result, 'TicketReminded')).toBeGreaterThan(0);
    expect(countOf(result, 'TicketPaused')).toBeGreaterThan(0);
  });

  it('待ち時間が短ければ基礎の率、長ければ高いほうの率で決まる', () => {
    const party = createParty(1, 0, SIM_EPOCH, SHORT);
    const patient = { ...party, noShowRoll: 0.1 };
    expect(decidesNoShow(patient, minutes(5), SHORT)).toBe(false);
    expect(decidesNoShow(patient, minutes(25), SHORT)).toBe(true);
  });

  it('目が率より大きければ、どんなに待ってもノーショーしない', () => {
    const party = { ...createParty(1, 0, SIM_EPOCH, SHORT), noShowRoll: 0.99 };
    expect(decidesNoShow(party, minutes(120), SHORT)).toBe(false);
  });
});

describe('登録せずに席へ向かう人（8.1「無断利用」、7.12「飛び込み」）', () => {
  /**
   * 無断利用の率を 8.1 の 0.2 件/卓/時から 1 件へ上げてある。
   *
   * 1 時間の短いシナリオでは、8.1 の率だと 1 回の実行に 0〜2 件しか起きず、
   * 「起きること」と「起きないこと」を見分けられない。**率だけを上げて、
   * 起きたときの扱いを見る。** 率そのものの妥当性は 8.1 の値で測る。
   */
  function withShare(share: number): Scenario {
    return withWalkInShare(withUnregisteredRate(withCheckoutReportRate(SHORT, 1), 1), share);
  }

  it('全員が座席 QR を読めば、すべて飛び込み着席として記録される', () => {
    const result = run({ scenario: withShare(1), seed: 3 });
    const walkIns = result.events.filter(
      (event) => event.type === 'TicketJoined' && event.origin === 'WALK_IN',
    );
    expect(result.sitters.length).toBeGreaterThan(0);
    expect(walkIns).toHaveLength(result.sitters.length);
  });

  /**
   * **7.12 の狙いが数字で出る。**
   *
   * 座席 QR から登録できないと、システムには空席に見えたまま席が使われる。
   * そこへ案内された人は「誰かが座っています」と報告することになる（7.8 の 10）。
   */
  it('誰も読まなければ、案内された席が塞がっていた事故が起きる', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(countOf(run({ scenario: withShare(0), seed }), 'TableReportedInUse')).toBeGreaterThan(0);
    }
  });

  it('全員が読めば、その事故は 1 件も起きない', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(countOf(run({ scenario: withShare(1), seed }), 'TableReportedInUse')).toBe(0);
    }
  });

  it('無断利用が無ければ、登録せずに座る人も現れない', () => {
    const none = withUnregisteredRate(withCheckoutReportRate(SHORT, 1), 0);
    expect(run({ scenario: none, seed: 3 }).sitters).toEqual([]);
  });

  it('読む割合を変えても、受付から並ぶ人は 1 人も変わらない（共通乱数）', () => {
    const base = run({ scenario: withShare(0), seed: 8 });
    const scanning = run({ scenario: withShare(1), seed: 8 });
    expect(scanning.parties).toEqual(base.parties);
  });

  it('同じシードなら、登録せずに来る人も同じ', () => {
    expect(run({ scenario: withShare(0.5), seed: 8 }).sitters).toEqual(
      run({ scenario: withShare(0.5), seed: 8 }).sitters,
    );
  });

  it('8.1 の率（0.2 件/卓/時）でも、飛び込み着席は記録される', () => {
    const result = run({ scenario: withCheckoutReportRate(WEEKEND_PEAK, 1), seed: 2026 });
    expect(result.sitters.length).toBeGreaterThan(0);
  });
});

describe('不変条件（9.12）', () => {
  /**
   * **100 回の実行で違反ゼロ。** Phase 1 プラン PR 8 の完了条件。
   *
   * 違反は `apply` と `tick` の出口で検査されていて、破れれば拒否として返る。
   * ランナーはそれを `defects` に積むので、ここが空であることが「破れなかった」
   * ことを意味する。
   */
  it('100 回走らせても、実装の誤りを示す拒否が 1 つも出ない', () => {
    const failures = Array.from({ length: 100 }, (_unused, seed) =>
      run({ scenario: SHORT, seed }),
    ).filter((result) => result.defects.length > 0);
    expect(failures.map((result) => result.seed)).toEqual([]);
  });

  it('退席の申告率を変えても、違反は出ない', () => {
    for (const rate of [0, 0.3, 0.6, 1]) {
      const result = run({ scenario: withCheckoutReportRate(SHORT, rate), seed: 42 });
      expect(result.defects).toEqual([]);
    }
  });

  it('ノーショーの方針を変えても、違反は出ない', () => {
    for (const noShowPolicy of ['cancel', 'requeue_once', 'requeue_back'] as const) {
      const scenario = withPolicy(SHORT, { ...DEFAULT_POLICY, noShowPolicy });
      expect(run({ scenario, seed: 42 }).defects).toEqual([]);
    }
  });

  it('登録せずに座る人がいても、違反は出ない', () => {
    for (const share of [0, 0.5, 1]) {
      expect(run({ scenario: withWalkInShare(SHORT, share), seed: 42 }).defects).toEqual([]);
    }
  });

  it('過負荷でも違反は出ない', () => {
    const overloaded: Scenario = { ...WEEKEND_OVERLOAD, arrivals: WEEKEND_OVERLOAD.arrivals.slice(0, 4), joinOpenFor: minutes(60) };
    expect(run({ scenario: overloaded, seed: 7 }).defects).toEqual([]);
  });
});

describe('完了条件（Phase 1 プラン PR 8）', () => {
  /** **`weekend-peak` が 1 日分（3 時間半）を数秒で走り、不変条件が破れない。** */
  it('weekend-peak の 3 時間半が数秒で走り、違反が出ない', () => {
    const started = performance.now();
    const result = run({ scenario: WEEKEND_PEAK, seed: 2026 });
    const elapsed = performance.now() - started;

    expect(result.defects).toEqual([]);
    expect(result.ticks).toBeGreaterThan(1500);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('weekday-lunch も違反なく走る', () => {
    expect(run({ scenario: WEEKDAY_LUNCH, seed: 2026 }).defects).toEqual([]);
  });
});

describe('この版の限界（PR 10 で解消する）', () => {
  /**
   * **退席を申告しない人の席は戻らない。**
   *
   * 8.1 は申告率 60% を置き、申告しない人は「p90 の問いかけ → 無応答 →
   * 確認要」の経路を通るとしている（7.11 の 2 と 5）。その経路は PR 10 で
   * 実装するので、いまは席が埋まったまま残る。**シミュレータはその様子を
   * 隠さずに出す。** これが PR 10 を待つ理由を数字で示している。
   */
  it('申告率 60% だと、席が埋まったまま戻らなくなる', () => {
    const result = run({ scenario: WEEKEND_PEAK, seed: 2026 });
    const stuck = result.state.tables.filter((table) => table.status === 'OCCUPIED');
    expect(stuck.length).toBe(result.state.tables.length);
  });

  it('申告率 100% なら、最後には席が空く', () => {
    const result = run({ scenario: withCheckoutReportRate(WEEKEND_PEAK, 1), seed: 2026 });
    const free = result.state.tables.filter((table) => table.status === 'FREE');
    expect(free.length).toBeGreaterThan(0);
  });

  it('申告率が下がるほど、使い終わる人が減る', () => {
    const counts = [1, 0.6, 0.2].map(
      (rate) => run({ scenario: withCheckoutReportRate(SHORT, rate), seed: 55 }).state.tickets.filter(
        (ticket) => ticket.endReason === 'checked_out',
      ).length,
    );
    expect(counts[0]).toBeGreaterThan(counts[1] ?? 0);
    expect(counts[1]).toBeGreaterThan(counts[2] ?? 0);
  });
});

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
  withBalkShare,
  withCheckoutReportRate,
  withClosing,
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

/** コマンドを投入した時刻が、どこかで前に戻っているか（9.4）。 */
function wentBackward(appliedAt: readonly Timestamp[]): boolean {
  return appliedAt.some((at, index) => index > 0 && at < (appliedAt[index - 1] ?? at));
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

  /**
   * **ここは 1 シードしか見ていない。** 現実のシナリオを 200 シード流す検査は
   * 「不変条件（9.12）」にある。**この 1 本だけでは PR 13.5 の不具合を
   * 見つけられなかった**（短いシナリオでは起きない）。
   */
  it('コマンドを投入した時刻が巻き戻らない', () => {
    expect(wentBackward(result.appliedAt)).toBe(false);
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
  /**
   * **短いシナリオでは見られない。** ノーショーは 1 組ずつの引きなので、
   * 1 時間ぶん（10 組ほど）では「たまたま全員が間に合った」が普通に起きる。
   * 率が効いていることを見るには、3 時間半ぶんの組数が要る。
   */
  it('呼ばれても来ない人がいる（8.1 のノーショー率）', () => {
    const result = run({ scenario: withCheckoutReportRate(WEEKEND_PEAK, 1), seed: 31 });
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

  /**
   * **現実のシナリオを 200 回**（Phase 1 プラン 1 章の完了条件 C8）。
   *
   * 上の 100 回は 1 時間の短いシナリオで、速いかわりに浅い。**3 時間半を 200 回
   * 回して初めて見つかる壊れ方がある。** 実際、シミュレータが時刻を戻して
   * コマンドを送る不具合（PR 13.5）は、200 シード中 2 回しか起きなかった。
   *
   * 時刻の巻き戻りもここで見る。コアは 9.4 のとおり拒否するので `defects` にも
   * 出るが、**送る側の記録（`appliedAt`）でも確かめる**。片方だけだと、拒否を
   * 握り潰す変更が入ったときに気づけない。
   */
  it('現実のシナリオを 200 回走らせても、拒否も時刻の巻き戻りも出ない（C8）', { timeout: 120_000 }, () => {
    const problems: string[] = [];
    for (let seed = 0; seed < 200; seed += 1) {
      const result = run({ scenario: WEEKEND_PEAK, seed });
      for (const defect of result.defects) {
        problems.push(`種 ${String(seed)}: ${defect.code}`);
      }
      if (wentBackward(result.appliedAt)) problems.push(`種 ${String(seed)}: 時刻が巻き戻った`);
    }
    expect(problems).toEqual([]);
  });

  /**
   * **PR 13.5 の不具合の再現テスト。**
   *
   * 予定した行動の反応が、同じ刻みの中の過ぎた時刻に入ると、次の刻みまで
   * 取り残される。そのときにはもう `tick` が時計を進めているので、コアが
   * `CLOCK_WENT_BACKWARD` で弾き、その人は着席できないまま消えていた。
   */
  it('同じ刻みの中で予定が増えても、時刻が巻き戻らない（種 76・190）', () => {
    for (const seed of [76, 190]) {
      const result = run({ scenario: WEEKEND_PEAK, seed });
      expect(result.defects, `種 ${String(seed)}`).toEqual([]);
      expect(wentBackward(result.appliedAt), `種 ${String(seed)}`).toBe(false);
    }
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

describe('整合性の回復が効いていること（7.10、7.11）', () => {
  /**
   * **PR 8 が数字で示した限界が解消した。**
   *
   * 8.1 の退席申告率 60% をそのまま回すと、PR 9 までは 8 卓すべてが埋まった
   * まま戻らず、47 組中 7 組しか使い終わらなかった。7.11 の 3 つの層（問いかけ、
   * 確認要の席の案内、時間経過による整理）が入って、**席が回るようになった。**
   *
   * **PR 13 で数字が動いた。** 目安を見て登録をやめる人（7.5 の 5）が入り、
   * 同じ種で 4 組が引き返す。そのぶん着席は 44 → 40 に減るが、**並んだ人の
   * 実際の待ちは 40 分から 28 分に縮む**（4 シードの平均。PR 13 の記録）。
   */
  it('申告率 60%（8.1 の値）でも、席が回るようになった', () => {
    const result = run({ scenario: WEEKEND_PEAK, seed: 2026 });
    const done = result.state.tickets.filter((ticket) => ticket.state === 'DONE');
    expect(done.length).toBeGreaterThan(33);
    expect(countOf(result, 'TicketSeated')).toBeGreaterThan(37);
  });

  it('申告しなかった人の席は、問いかけと時間経過で取り戻される', () => {
    const result = run({ scenario: WEEKEND_PEAK, seed: 2026 });
    expect(countOf(result, 'StillHereAsked')).toBeGreaterThan(0);
    expect(countOf(result, 'TableNeedsCheck')).toBeGreaterThan(0);
    const reclaimed = result.state.tickets.filter((ticket) => ticket.endReason === 'auto_release');
    expect(reclaimed.length).toBeGreaterThan(0);
  });

  it('申告率が高いほど、取り戻しに頼らずに済む', () => {
    const lazy = run({ scenario: WEEKEND_PEAK, seed: 2026 });
    const diligent = run({ scenario: withCheckoutReportRate(WEEKEND_PEAK, 1), seed: 2026 });
    expect(countOf(diligent, 'TableNeedsCheck')).toBeLessThan(countOf(lazy, 'TableNeedsCheck'));
  });

  it('申告率 100% でも、最後には席が空く', () => {
    const result = run({ scenario: withCheckoutReportRate(WEEKEND_PEAK, 1), seed: 2026 });
    expect(result.state.tables.filter((table) => table.status === 'FREE').length).toBeGreaterThan(0);
  });

  /**
   * **自動解放を切ると、席が永久に塞がりうる。**
   *
   * 7.11 の 5 層目が「最悪でも席が永久に塞がらない」と書いている保証は、
   * `needs_check_auto_free_min` を入れたときにだけ成り立つ。切った施設では
   * スタッフの確認を待つことになる。
   */
  it('自動解放を切ると、確認要の席が残ったままになる', () => {
    const manual: Scenario = withPolicy(WEEKEND_PEAK, {
      ...DEFAULT_POLICY,
      needsCheckAutoFreeMin: null,
    });
    const result = run({ scenario: manual, seed: 2026 });
    const stuck = result.state.tables.filter((table) => table.status === 'NEEDS_CHECK');
    expect(stuck.length).toBeGreaterThan(0);
  });
});

/**
 * 確認要の席を次の利用者に委ねる（7.11 の 3 層目）。
 *
 * **これは「30 分待って自動で戻す」より速い経路である。** 5 層目だけでも席は
 * いつか戻るが、そのあいだ席は空いたまま誰も座れない。見に行ける人がいるなら、
 * その人に確かめてもらったほうが早い。
 */
/**
 * 運用時間帯（全体プラン 7.14）。
 *
 * **シナリオが運用時間を持てるようになった**（PR 11 の完了条件）。持たせると、
 * 終了時刻に残っていた待ちが施設都合で取り消され、席が自由席に戻る。
 */
describe('運用時間を持つシナリオ（7.14）', () => {
  /** 1 時間ぶんの到着に、45 分で終わる運用時間をかぶせる。 */
  const CLOSING: Scenario = withClosing(SHORT, minutes(45));

  function endedBy(result: RunResult, reason: string): number {
    return result.state.tickets.filter((ticket) => ticket.endReason === reason).length;
  }

  it('既定のシナリオは運用終了を持たない', () => {
    expect(SHORT.closesAfter).toBeNull();
    expect(countOf(run({ scenario: SHORT, seed: 5 }), 'VenueClosed')).toBe(0);
  });

  it('運用時間を持たせると、終了して席が自由席に戻る', () => {
    const result = run({ scenario: CLOSING, seed: 5 });
    expect(countOf(result, 'VenueClosed')).toBe(1);
    expect(result.state.operating).toBe(false);
    expect(result.state.tables.every((table) => table.status === 'DISABLED')).toBe(true);
  });

  it('終了の手前で受付が止まる', () => {
    const result = run({ scenario: CLOSING, seed: 5 });
    expect(countOf(result, 'JoinClosed')).toBe(1);
    expect(result.state.joinOpen).toBe(false);
  });

  /** 締切（既定 15 分前）より後の受付は通らない。 */
  it('締切より後に来た人は、受付に入れない', () => {
    const result = run({ scenario: CLOSING, seed: 5 });
    const joined = result.events.filter((event) => event.type === 'TicketJoined');
    const cutoff: Timestamp = SIM_EPOCH + minutes(45 - DEFAULT_POLICY.joinCutoffBeforeCloseMin);
    expect(joined.every((event) => event.at <= cutoff)).toBe(true);
  });

  /**
   * **待ちが残る混み方でないと見えない。** 8.1 の到着率は席数に釣り合わせて
   * あるので、`SHORT` では終了時刻に誰も待っていないことがある。過負荷の
   * シナリオ（`weekend-overload`）で確かめる。
   */
  it('終了時に待っていた人は、施設都合で取り消される', () => {
    const crowded: Scenario = withClosing(WEEKEND_OVERLOAD, minutes(60));
    const result = run({ scenario: crowded, seed: 5 });
    expect(endedBy(result, 'venue_closed')).toBeGreaterThan(0);
    // 取り消されたのは待っていた人だけ。着席していた人は使い終わっている。
    expect(endedBy(result, 'checked_out')).toBeGreaterThan(0);
  });

  it('運用時間が無ければ、施設都合の取り消しは 1 件も起きない', () => {
    expect(endedBy(run({ scenario: SHORT, seed: 5 }), 'venue_closed')).toBe(0);
  });

  /** 7.14「`SEATED` は `DISABLED` になっても座り続けて問題ない」。 */
  it('終了しても、着席していた人は最後まで使い終わる', () => {
    const result = run({ scenario: CLOSING, seed: 5 });
    expect(countOf(result, 'TicketSeated')).toBeGreaterThan(0);
    expect(endedBy(result, 'checked_out')).toBeGreaterThan(0);
  });

  it('十分に時間が経てば、生きたチケットは 1 枚も残らない', () => {
    const result = run({ scenario: CLOSING, seed: 5 });
    expect(result.state.tickets.every((ticket) => ticket.endedAt !== null)).toBe(true);
  });

  it('多数回まわしても、実装の誤りを示す拒否が出ない', () => {
    const failures = Array.from({ length: 50 }, (_unused, seed) =>
      run({ scenario: CLOSING, seed }),
    ).filter((result) => result.defects.length > 0);
    expect(failures.map((result) => result.seed)).toEqual([]);
  });
});

describe('確認要の席を次の人に委ねる（7.11 の 3 層目）', () => {
  const SEEDS: readonly number[] = [2026, 7, 99, 31];

  /** 案内を切った施設。ほかの条件は 8.1 のまま。 */
  const off: Scenario = withPolicy(WEEKEND_PEAK, { ...DEFAULT_POLICY, assignNeedsCheck: false });

  function finished(result: RunResult): number {
    return result.state.tickets.filter((ticket) => ticket.state === 'DONE').length;
  }

  /** 呼ばれずに座った、並んでいた人。この版では 3 層目の案内しか経路が無い。 */
  function seatedWithoutCall(result: RunResult): number {
    const skip = new Set<string>();
    let seated = 0;

    for (const event of result.events) {
      if (event.type === 'TicketCalled') skip.add(event.ticketId);
      if (event.type === 'TicketJoined' && event.origin === 'WALK_IN') skip.add(event.ticketId);
      if (event.type === 'TicketSeated' && !skip.has(event.ticketId)) seated += 1;
    }
    return seated;
  }

  it.each(SEEDS)('種 %i で、案内を出すほうが多くの組が使い終わる', (seed) => {
    expect(finished(run({ scenario: WEEKEND_PEAK, seed }))).toBeGreaterThan(
      finished(run({ scenario: off, seed })),
    );
  });

  it('案内された人が、呼ばれないまま席に着いている', () => {
    expect(seatedWithoutCall(run({ scenario: WEEKEND_PEAK, seed: 2026 }))).toBeGreaterThan(0);
  });

  it('案内を切れば、呼ばれずに座る人はいなくなる', () => {
    expect(seatedWithoutCall(run({ scenario: off, seed: 2026 }))).toBe(0);
  });

  it('使用中だったときは報告になり、その人は次の席で繰り上げを受ける', () => {
    const result = run({ scenario: WEEKEND_PEAK, seed: 31 });
    expect(countOf(result, 'TableReportedInUse')).toBeGreaterThan(0);
    expect(countOf(result, 'TicketRequeued')).toBeGreaterThan(0);
  });

  it('案内を出しても、実装の誤りを示す拒否は出ない', () => {
    for (const seed of SEEDS) {
      expect(run({ scenario: WEEKEND_PEAK, seed }).defects).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------

/**
 * **待ち時間の目安（7.13）と、それを見て引き返す人（7.5 の 5）。**
 *
 * PR 8 が積み残した振る舞いである。目安が出せるようになって初めて、
 * 「40 分以上お待ちいただく見込みです。登録しますか？」に答える人を置ける。
 * これが入るまで、過負荷のシナリオは現実より厳しく出ていた。
 */
describe('待ち時間の目安と、登録をやめる人（7.13、7.5 の 5）', () => {
  /** 予測と実績の組。実績は「登録してから呼ばれるまで」。 */
  function samples(result: RunResult): readonly { readonly 予測: number; readonly 実績: number }[] {
    const calledAt = new Map<string, Timestamp>();
    for (const event of result.events) {
      if (event.type === 'TicketCalled' && !calledAt.has(event.ticketId)) {
        calledAt.set(event.ticketId, event.at);
      }
    }
    return result.estimates.flatMap((sample) => {
      const called: Timestamp | undefined = calledAt.get(sample.ticketId);
      return called === undefined
        ? []
        : [{ 予測: sample.minutes, 実績: (called - sample.at) / minutes(1) }];
    });
  }

  function mean(values: readonly number[]): number {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  it('到着した組の全員に、登録の前の目安が出ている', () => {
    const result = run({ scenario: WEEKEND_PEAK, seed: 2026 });
    expect(result.estimates).toHaveLength(result.parties.length);
  });

  it('目安が長いと、登録をやめる人が出る', () => {
    expect(run({ scenario: WEEKEND_OVERLOAD, seed: 2026 }).balked.length).toBeGreaterThan(0);
  });

  it('やめる割合を 0 にすれば、1 人も引き返さない', () => {
    expect(run({ scenario: withBalkShare(WEEKEND_PEAK, 0), seed: 2026 }).balked).toEqual([]);
  });

  /** **この振る舞いが入るまで、過負荷では待ち行列が上限まで伸びきっていた。** */
  it('やめる人がいると、登録そのものが減る', () => {
    const none = run({ scenario: withBalkShare(WEEKEND_OVERLOAD, 0), seed: 2026 });
    const some = run({ scenario: WEEKEND_OVERLOAD, seed: 2026 });
    expect(countOf(some, 'TicketJoined')).toBeLessThan(countOf(none, 'TicketJoined'));
  });

  /** 並ぶ人が減るので、並んだ人の待ちは短くなる。 */
  it('やめる人がいると、並んだ人の実際の待ちが短くなる', () => {
    const none = mean(samples(run({ scenario: withBalkShare(WEEKEND_PEAK, 0), seed: 2026 })).map((s) => s.実績));
    const some = mean(samples(run({ scenario: WEEKEND_PEAK, seed: 2026 })).map((s) => s.実績));
    expect(some).toBeLessThan(none);
  });

  /**
   * **予測と実績の差（MAE）が測れる。** 数字そのものは PR 15 のレポートに載せる。
   * ここでは「測れること」と「桁が壊れていないこと」だけを見る。
   */
  it('予測と実績の差が測れる', () => {
    const rows = samples(run({ scenario: WEEKEND_PEAK, seed: 2026 }));
    expect(rows.length).toBeGreaterThan(20);
    expect(mean(rows.map((row) => Math.abs(row.予測 - row.実績)))).toBeLessThan(30);
  });

  /**
   * **目安は長めに出る**（7.13 の「悲観側に寄せる」）。早く案内されるのは嬉しく、
   * 遅れるのは不満なので、平均としては実績を上回っていてよい。
   */
  it('目安は、実績より長めに出る', () => {
    const rows = samples(run({ scenario: WEEKEND_PEAK, seed: 2026 }));
    expect(mean(rows.map((row) => row.予測))).toBeGreaterThan(mean(rows.map((row) => row.実績)));
  });
});

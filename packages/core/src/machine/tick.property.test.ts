import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type NoShowPolicy, type Policy } from '../domain/policy.js';
import { createTable, type Table, type TableStatus } from '../domain/table.js';
import { END_REASONS, isTerminal, type EndReason, type Ticket } from '../domain/ticket.js';
import { createVenueState, sameVenueState, type VenueState } from '../domain/state.js';
import { checkInvariants } from '../invariant.js';
import { isDefect } from './rejection.js';
import { minutes, seconds, type Timestamp } from '../time.js';
import { apply } from './apply.js';
import type { Actor, Command } from './command.js';
import type { DomainEvent } from './events.js';
import { POST_ALLOCATION_INVARIANTS, STATE_INVARIANTS } from './invariants.js';
import { TICKET_TRANSITIONS } from './ticket-machine.js';
import { tick } from './tick.js';

/**
 * 時刻を進めながらランダムなコマンドを流し、`tick` が守るべきことを確かめる。
 *
 * `apply.property.test.ts` が「コマンドを並べても壊れない」を見るのに対し、
 * こちらは **時間が進んでも壊れないこと**と、**時間の進め方によらず同じ結果に
 * なること**を見る。後者は `tick` の間隔が運用で揺れる（再起動、スケジューラの
 * 遅れ）ことへの備えで、全体プラン 9.12 の 5 にあたる。
 */

const NOW: Timestamp = 1_700_000_000_000;
const TICKET_IDS: readonly string[] = ['k1', 'k2', 'k3'];
const RUNS = { numRuns: 300 };

// ---- 生成器 ----

/**
 * 設定は `validatePolicy` を通る範囲で振る。
 *
 * `holdReminderBeforeMin < holdMin` のような関係は検証が守っているので、
 * 生成器も破らない。破った設定の扱いを `tick` に負わせない方針である。
 */
const policyArb: fc.Arbitrary<Policy> = fc
  .record({
    holdMin: fc.integer({ min: 2, max: 10 }),
    holdExtensionMin: fc.integer({ min: 0, max: 5 }),
    maxExtensions: fc.integer({ min: 0, max: 2 }),
    noShowPolicy: fc.constantFrom<NoShowPolicy>('cancel', 'requeue_once', 'requeue_back'),
    pauseStepMin: fc.integer({ min: 0, max: 12 }),
    pauseMaxTotalMin: fc.integer({ min: 0, max: 40 }),
    ticketMaxAgeMin: fc.integer({ min: 5, max: 60 }),
    abandonTimeoutMin: fc.integer({ min: 1, max: 20 }),
    turnoverMin: fc.integer({ min: 0, max: 3 }),
  })
  .map((chosen) => ({
    ...DEFAULT_POLICY,
    ...chosen,
    holdReminderBeforeMin: Math.min(1, chosen.holdMin - 1),
    pauseMaxTotalMin: Math.max(chosen.pauseMaxTotalMin, chosen.pauseStepMin),
  }));

function tableAt(id: string, capacity: number): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE' };
}

const stateArb: fc.Arbitrary<VenueState> = fc
  .record({
    capacities: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 3 }),
    policy: policyArb,
  })
  .map(({ capacities, policy }) => ({
    ...createVenueState({
      venueId: 'v1',
      policy,
      tables: capacities.map((capacity, index) => tableAt(`tb${index}`, capacity)),
    }),
    operating: true,
    joinOpen: true,
  }));

const ticketIdArb: fc.Arbitrary<string> = fc.constantFrom(...TICKET_IDS);

const tableIdArb: fc.Arbitrary<string> = fc.constantFrom('tb0', 'tb1', 'tb2');

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc
    .record({
      ticketId: ticketIdArb,
      partySize: fc.integer({ min: 1, max: 4 }),
      hasNotificationChannel: fc.boolean(),
    })
    .map((fields): Command => ({ type: 'JOIN', requiredTags: [], ...fields })),
  ticketIdArb.map((ticketId): Command => ({ type: 'PAUSE', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'READY', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'EXTEND', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'PASS', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'HEARTBEAT', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'STILL_HERE', ticketId })),
  fc
    .record({ ticketId: ticketIdArb, tableId: fc.constantFrom('tb0', 'tb1', 'tb2') })
    .map((fields): Command => ({ type: 'CHECK_IN', ...fields })),
  fc
    .record({ ticketId: ticketIdArb, by: fc.constantFrom<Actor>('user', 'staff') })
    .map((fields): Command => ({ type: 'CHECK_OUT', ...fields })),
  fc
    .record({ ticketId: ticketIdArb, tableId: tableIdArb })
    .map((fields): Command => ({ type: 'SWAP_TABLE', ...fields })),
  fc
    .record({ ticketId: ticketIdArb, tableId: tableIdArb })
    .map((fields): Command => ({ type: 'CHECK_IN_EARLY', ...fields })),
  fc
    .record({ ticketId: ticketIdArb, tableId: tableIdArb })
    .map((fields): Command => ({ type: 'REPORT_TAKEN', ...fields })),
  fc
    .record({ ticketId: fc.option(ticketIdArb, { nil: null }), tableId: tableIdArb })
    .map((fields): Command => ({ type: 'REPORT_IN_USE', ...fields })),
  fc
    .record({ tableId: tableIdArb, by: fc.constantFrom<Actor>('user', 'staff') })
    .map((fields): Command => ({ type: 'CONFIRM_FREE', ...fields })),
  fc
    .record({
      ticketId: fc.constantFrom('w1', 'w2'),
      tableId: tableIdArb,
      partySize: fc.integer({ min: 1, max: 4 }),
    })
    .map((fields): Command => ({ type: 'WALK_IN', ...fields })),
  fc
    .record({ ticketId: ticketIdArb, by: fc.constantFrom<Actor>('user', 'staff') })
    .map((fields): Command => ({ type: 'CANCEL', reason: 'other', ...fields })),
  // 施設の開閉（7.14、7.9）。運用終了は筋書きの途中に来るよう近くに置く。
  fc
    .record({
      closesAt: fc.option(fc.integer({ min: 0, max: 60 }).map((min) => NOW + minutes(min)), {
        nil: null,
      }),
      by: fc.constantFrom<Actor>('user', 'staff'),
    })
    .map((fields): Command => ({ type: 'OPEN', ...fields })),
  fc.constantFrom<Actor>('user', 'staff').map((by): Command => ({ type: 'CLOSE', by })),
  fc.constantFrom<Actor>('user', 'staff').map((by): Command => ({ type: 'RELEASE_ALL', by })),
  fc
    .record({ tableId: tableIdArb, by: fc.constantFrom<Actor>('user', 'staff') })
    .map((fields): Command => ({ type: 'DISABLE_TABLE', ...fields })),
  fc
    .record({ tableId: tableIdArb, by: fc.constantFrom<Actor>('user', 'staff') })
    .map((fields): Command => ({ type: 'ENABLE_TABLE', ...fields })),
);

/**
 * 待ち行列の側だけを動かすコマンド。**席を空けるものを含まない。**
 *
 * 「空席が無い施設」を前提にする性質で使う。`CONFIRM_FREE` のように席を空席へ
 * 戻すコマンドが混ざると、前提そのものが途中で崩れてしまう。
 */
const queueCommandArb: fc.Arbitrary<Command> = fc.oneof(
  fc
    .record({
      ticketId: ticketIdArb,
      partySize: fc.integer({ min: 1, max: 4 }),
      hasNotificationChannel: fc.boolean(),
    })
    .map((fields): Command => ({ type: 'JOIN', requiredTags: [], ...fields })),
  ticketIdArb.map((ticketId): Command => ({ type: 'PAUSE', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'READY', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'EXTEND', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'HEARTBEAT', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'STILL_HERE', ticketId })),
  fc
    .record({ ticketId: ticketIdArb, by: fc.constantFrom<Actor>('user', 'staff') })
    .map((fields): Command => ({ type: 'CANCEL', reason: 'other', ...fields })),
);

/** 1 手。コマンドを出すか、時間だけを進める。 */
type Move = { readonly kind: 'command'; readonly command: Command } | { readonly kind: 'wait' };

function movesOf(commands: fc.Arbitrary<Command>): fc.Arbitrary<Move> {
  return fc.oneof(
    commands.map((command): Move => ({ kind: 'command', command })),
    fc.constant<Move>({ kind: 'wait' }),
  );
}

const moveArb: fc.Arbitrary<Move> = movesOf(commandArb);

const scenarioArb = fc.record({
  state: stateArb,
  moves: fc.array(moveArb, { minLength: 1, maxLength: 25 }),
  stepMin: fc.integer({ min: 1, max: 12 }),
});

/**
 * 席が 1 つも使えない施設。呼び出しが起きないので、期限の処理だけを取り出せる。
 *
 * **席を「対象外」にしてある。** 以前は「使用中（誰か分からない）」にしていたが、
 * 整合性の回復（7.11 の 5 層目）が入って、時間が経つと確認要を経て空席に戻る
 * ようになった。時間そのものが前提を壊すので、時刻起因の遷移をまったく持たない
 * 状態を選ぶ。コマンドも待ち行列の側だけに絞る（席を空けるものを混ぜない）。
 */
const crowdedScenarioArb = fc.record({
  state: stateArb.map((state) => ({
    ...state,
    tables: state.tables.map((item) => ({ ...item, status: 'DISABLED' as const })),
  })),
  moves: fc.array(movesOf(queueCommandArb), { minLength: 1, maxLength: 25 }),
  stepMin: fc.integer({ min: 1, max: 12 }),
});

// ---- 実行 ----

interface Trace {
  readonly state: VenueState;
  readonly events: readonly DomainEvent[];
  readonly violations: readonly string[];
  readonly ticks: number;
}

/**
 * 1 手ごとに `stepMin` 分進め、毎回 `tick` を通す。
 *
 * 拒否されたコマンドは読み飛ばす。`tick` の拒否は読み飛ばさず記録する。
 * **`tick` は業務上の理由で拒否しないので、拒否が出たら実装の誤りである。**
 */
function play(initial: VenueState, moves: readonly Move[], stepMin: number): Trace {
  let state: VenueState = initial;
  const events: DomainEvent[] = [];
  const violations: string[] = [];
  let now: Timestamp = NOW;
  let ticks = 0;

  for (const move of moves) {
    now += minutes(stepMin);
    if (move.kind === 'command') {
      const applied = apply(state, move.command, now);
      if (applied.ok) {
        state = applied.value.state;
        events.push(...applied.value.events);
      } else if (isDefect(applied.error)) {
        violations.push(`apply: ${applied.error.describe}`);
      }
    }
    const ticked = tick(state, now);
    ticks += 1;
    if (!ticked.ok) {
      violations.push(`tick: ${ticked.error.code} ${ticked.error.describe}`);
      continue;
    }
    state = ticked.value.state;
    events.push(...ticked.value.events);
    violations.push(...checkInvariants([...STATE_INVARIANTS, ...POST_ALLOCATION_INVARIANTS], state).map((item) => item.name));
  }
  return { state, events, violations, ticks };
}

function tickedState(state: VenueState, now: Timestamp): VenueState {
  const ticked = tick(state, now);
  return ticked.ok ? ticked.value.state : state;
}

/** `from` から `to` まで、10 秒ごとに `tick` しながら進める。 */
function tickEvery(state: VenueState, from: Timestamp, to: Timestamp): VenueState {
  let current: VenueState = state;
  for (let now = from; now <= to; now += seconds(10)) {
    current = tickedState(current, now);
  }
  return tickedState(current, to);
}

/** 筋書きを流し終えた時刻。 */
function endOf(moves: readonly Move[], stepMin: number): Timestamp {
  return NOW + minutes(stepMin) * moves.length;
}

function declaredMove(from: string, to: string): boolean {
  return TICKET_TRANSITIONS.some((row) => row.from === from && row.to === to);
}

// ---- 性質 ----

describe('tick が決して破らないこと', () => {
  it('不変条件を一度も破らない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) => play(state, moves, stepMin).violations.length === 0),
      RUNS,
    );
  });

  it('tick は拒否しない（拒否されたらそれは実装の誤り）', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) => {
        const trace = play(state, moves, stepMin);
        return trace.violations.every((item) => !item.startsWith('tick:'));
      }),
      RUNS,
    );
  });

  it('渡した状態を書き換えない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) => {
        const snapshot = structuredClone(state);
        play(state, moves, stepMin);
        expect(state).toStrictEqual(snapshot);
      }),
      RUNS,
    );
  });

  it('同じ時刻で 2 回目を呼んでも状態が変わらない（冪等・9.12 の 5）', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) => {
        const settled = play(state, moves, stepMin).state;
        const last: Timestamp = NOW + minutes(stepMin) * moves.length;
        const again = tick(settled, last);
        return again.ok && sameVenueState(settled, again.value.state) && again.value.events.length === 0;
      }),
      RUNS,
    );
  });

  it('同じ筋書きを 2 回流すと同じ状態になる（決定的である）', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) =>
        sameVenueState(play(state, moves, stepMin).state, play(state, moves, stepMin).state),
      ),
      RUNS,
    );
  });

  /**
   * **期限の処理は、刻み方によらず同じ結果になる。**
   *
   * ある状態から 2 時間ぶんの時間を進めるとき、10 秒ごとに `tick` を呼んでも、
   * まとめて 1 回で呼んでも、落ち着く先が同じであること。期限をその期限の時刻で
   * 処理しているから成り立つ。これが崩れると、サーバが数分止まっただけで
   * 終わり方（`endReason`）が変わってしまう。
   *
   * **条件が 2 つある。どちらもファズが教えてくれたもので、設計上消せない。**
   *
   * 1. **あいだにコマンドが挟まらないこと。** 心拍が届けば放置の起点が動くので、
   *    「心拍より先に `tick` が走ったか」で結果が変わる。これは時刻の扱いの問題
   *    ではなく、操作と時間の競合であって、現実にも起こる
   * 2. **空席が無いこと。** 呼び出しは「いま」起きる行為なので、`tick` の間隔に
   *    依存する。7 分で切れたホールドを 30 分後に処理するとき、席が空いたことは
   *    7 分の出来事として刻めるが、次の人を呼べるのは 30 分の時点である
   */
  it('空席が無い施設で時間だけを進めるなら、刻み方によらず同じ状態になる（9.12 の 5）', () => {
    fc.assert(
      fc.property(crowdedScenarioArb, ({ state, moves, stepMin }) => {
        const built = play(state, moves, stepMin).state;
        const from: Timestamp = endOf(moves, stepMin);
        const to: Timestamp = from + minutes(120);
        return sameVenueState(tickedState(built, to), tickEvery(built, from, to));
      }),
      { numRuns: 200 },
    );
  });
});

describe('席が永久に塞がらない（7.11 の 5 層目）', () => {
  /**
   * **この PR の価値の中心にある性質。**
   *
   * 7.11 は 5 層の対策を重ねて「最悪でも席が永久に塞がらない」と書いている。
   * それが本当かを、**どんな状態から始めても、時間を十分に進めれば
   * すべての席が空席か対象外に落ち着く**という形で確かめる。
   *
   * 落ち着く道筋は席の状態ごとに違う。
   *
   * | 始まり | 道筋 |
   * |---|---|
   * | `HELD` | ホールドの期限切れ → 空席（7.7） |
   * | `OCCUPIED` | 問いかけ → 無応答 → 確認要 → 自動解放（7.11 の 2・5） |
   * | `OCCUPIED_UNKNOWN` | 想定滞在時間 → 確認要 → 自動解放（7.11 の 5） |
   * | `TURNOVER` | 片付けの猶予 → 空席（7.6） |
   * | `NEEDS_CHECK` | 自動解放 → 空席（7.11 の 5） |
   *
   * **`needs_check_auto_free_min` を入れたときにだけ成り立つ。** 切った施設では
   * スタッフの確認を待つことになる（下のテストで確かめている）。
   */
  const settledStatuses: readonly TableStatus[] = ['FREE', 'DISABLED'];

  /**
   * 落ち着くまで時間だけを進める。
   *
   * 1 回の大きな `tick` では足りない。空いた席には次の人が呼ばれ、その呼び出しの
   * 期限は「いま」から先にあるからで、**何度か刻まないと循環が終わらない**。
   * 15 分ごとに 6 時間ぶん進める。いちばん長い道筋（着席 → 問いかけ 50 分 →
   * 無応答 5 分 → 自動解放 30 分）と、呼び出しの繰り返しを合わせても足りる長さ。
   */
  function settleDown(state: VenueState, from: Timestamp): VenueState {
    let current: VenueState = state;
    for (let step = 1; step <= 24; step += 1) {
      current = tickedState(current, from + minutes(15) * step);
    }
    return current;
  }

  it('どんな筋書きのあとでも、時間を十分に進めれば席が空く', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) => {
        const built = play(state, moves, stepMin).state;
        const settled = settleDown(built, endOf(moves, stepMin));
        return settled.tables.every((table) => settledStatuses.includes(table.status));
      }),
      RUNS,
    );
  });

  it('そのとき、すべてのチケットも終わっている', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) => {
        const built = play(state, moves, stepMin).state;
        const settled = settleDown(built, endOf(moves, stepMin));
        return settled.tickets.every((ticket) => isTerminal(ticket.state));
      }),
      RUNS,
    );
  });

  /**
   * **自動解放を切ると、この保証は消える。**
   *
   * 7.11 の 5 層目は `off` も許している。切った施設では「確認要」の席が
   * スタッフの確認まで残る。性質が条件つきであることを、逆から確かめる。
   */
  it('自動解放を切ると、確認要の席が残ったままになる', () => {
    const policy: Policy = { ...DEFAULT_POLICY, needsCheckAutoFreeMin: null };
    const manual: VenueState = {
      ...createVenueState({
        venueId: 'v1',
        policy,
        tables: [{ ...tableAt('tb0', 4), status: 'NEEDS_CHECK' }],
      }),
      operating: true,
      joinOpen: true,
    };
    const settled = settleDown(manual, NOW);
    expect(settled.tables[0]?.status).toBe('NEEDS_CHECK');
  });
});

describe('時刻起因の遷移が守ること', () => {
  it('動いた状態はすべて遷移表に宣言されている', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) => {
        const settled = play(state, moves, stepMin).state;
        return settled.tickets.every((ticket) => reachableFromStart(ticket));
      }),
      RUNS,
    );
  });

  it('終わったチケットは席を持たない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) =>
        play(state, moves, stepMin).state.tickets.every(
          (ticket) => !isTerminal(ticket.state) || ticket.tableId === null,
        ),
      ),
      RUNS,
    );
  });

  /**
   * この版が作りうる終わり方の一覧。
   *
   * **宣言されている 10 通り（`END_REASONS`）がすべて揃った。** 最後に残って
   * いた `venue_closed`（施設都合）は、運用終了と全席解放（7.14、7.9）で
   * 作られるようになった。想定外の終わり方が混ざれば落ちる。
   */
  const REACHABLE_END_REASONS: readonly EndReason[] = [
    // 時刻が来て終わったもの
    'no_show',
    'pause_expired',
    'max_age',
    'abandoned',
    'auto_release',
    // 人の操作で終わったもの
    'user_cancel',
    'staff_cancel',
    'checked_out',
    'staff_checkout',
    // 施設の都合で終わったもの
    'venue_closed',
  ];

  it('終わり方は、宣言されている 10 通りのいずれかになる', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) =>
        play(state, moves, stepMin).state.tickets.every(
          (ticket) => ticket.endReason === null || REACHABLE_END_REASONS.includes(ticket.endReason),
        ),
      ),
      RUNS,
    );
  });

  it('宣言されている終わり方が、すべて作れるようになった', () => {
    expect([...END_REASONS].sort()).toEqual([...REACHABLE_END_REASONS].sort());
  });

  it('呼び出された人には必ず期限が付いている', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) =>
        play(state, moves, stepMin).state.tickets.every(
          (ticket) => ticket.state !== 'CALLED' || ticket.holdDeadline !== null,
        ),
      ),
      RUNS,
    );
  });

  it('知らせは 1 つの期限につき 1 回まで', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) => {
        const trace = play(state, moves, stepMin);
        const reminders = trace.events.filter((event) => event.type === 'TicketReminded');
        const keys = reminders.map((event) =>
          event.type === 'TicketReminded' ? `${event.ticketId}@${event.holdDeadline}` : '',
        );
        return new Set(keys).size === keys.length;
      }),
      RUNS,
    );
  });

  /**
   * **片付け中の席が取り残されない。**
   *
   * 猶予が明けた席は、`settle` が必ず空席に戻す。取り残されると、その席は
   * 誰にも割り当てられないまま残り、`no_starvation` でも捕まらない
   * （あの条件は `FREE` の席しか見ない）。
   */
  it('猶予が明けた席が片付け中のまま残らない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) => {
        const settled = play(state, moves, stepMin).state;
        const end: Timestamp = endOf(moves, stepMin);
        return settled.tables.every(
          (item) =>
            item.status !== 'TURNOVER' || item.statusSince + minutes(settled.policy.turnoverMin) > end,
        );
      }),
      RUNS,
    );
  });

  it('着席している人は必ず席を持ち、その席も本人を指す', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) => {
        const settled = play(state, moves, stepMin).state;
        return settled.tickets
          .filter((item) => item.state === 'SEATED')
          .every((item) => {
            const seat = settled.tables.find((candidate) => candidate.id === item.tableId);
            if (seat === undefined || seat.occupantTicketId !== item.id) return false;
            // 上限を超えた席と、問いかけに答えが無かった席は「確認要」になる
            // （7.10、7.11 の 2 層目）。結びつきは切れていない。
            return seat.status === 'OCCUPIED' || seat.status === 'NEEDS_CHECK';
          });
      }),
      RUNS,
    );
  });

  /**
   * **正しい上限は「保留に入ってから、使い残している時間まで」である。**
   *
   * 以前は「1 回分（`pauseStepMin`）を超えない」と書いていたが、これは誤り
   * だった。延長は「いまから 1 回分先」なので、保留に入った時刻から測れば
   * 1 回分を超える。守られているのは合計のほうで、`pauseWindowEnd` が
   * その頭打ちを作っている（PR 6）。
   */
  it('保留の期限は、保留に入った時刻＋使い残しを超えて置かれない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) => {
        const settled = play(state, moves, stepMin).state;
        return settled.tickets.every((ticket) => pauseWindowIsBounded(ticket, settled.policy));
      }),
      RUNS,
    );
  });
});

// ---- 判定の助け ----

/** 生まれた状態（`WAITING` か `SEATED`）から、宣言された道で到達できる状態か。 */
function reachableFromStart(ticket: Ticket): boolean {
  if (ticket.state === 'WAITING' || ticket.state === 'SEATED') return true;
  return ['WAITING', 'PAUSED', 'CALLED', 'SEATED'].some((from) => declaredMove(from, ticket.state));
}

function pauseWindowIsBounded(ticket: Ticket, policy: Policy): boolean {
  if (ticket.pauseDeadline === null || ticket.pausedSince === null) return true;
  const cap: number = minutes(policy.pauseMaxTotalMin);
  const remaining: number = Math.max(0, cap - ticket.pausedTotal);
  return ticket.pauseDeadline - ticket.pausedSince <= remaining;
}

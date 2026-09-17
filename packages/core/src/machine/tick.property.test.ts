import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type NoShowPolicy, type Policy } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import { isTerminal, type Ticket } from '../domain/ticket.js';
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
  fc
    .record({ ticketId: ticketIdArb, by: fc.constantFrom<Actor>('user', 'staff') })
    .map((fields): Command => ({ type: 'CANCEL', reason: 'other', ...fields })),
);

/** 1 手。コマンドを出すか、時間だけを進める。 */
type Move = { readonly kind: 'command'; readonly command: Command } | { readonly kind: 'wait' };

const moveArb: fc.Arbitrary<Move> = fc.oneof(
  commandArb.map((command): Move => ({ kind: 'command', command })),
  fc.constant<Move>({ kind: 'wait' }),
);

const scenarioArb = fc.record({
  state: stateArb,
  moves: fc.array(moveArb, { minLength: 1, maxLength: 25 }),
  stepMin: fc.integer({ min: 1, max: 12 }),
});

/** 空席が 1 つも無い施設。呼び出しが起きないので、期限の処理だけを取り出せる。 */
const crowdedScenarioArb = scenarioArb.map((scenario) => ({
  ...scenario,
  state: {
    ...scenario.state,
    tables: scenario.state.tables.map((item) => ({ ...item, status: 'OCCUPIED_UNKNOWN' as const })),
  },
}));

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

  it('終わり方は、時刻起因なら 4 つのいずれかになる', () => {
    const byTime: readonly string[] = ['no_show', 'pause_expired', 'max_age', 'abandoned'];
    const byPerson: readonly string[] = ['user_cancel', 'staff_cancel'];
    fc.assert(
      fc.property(scenarioArb, ({ state, moves, stepMin }) =>
        play(state, moves, stepMin).state.tickets.every(
          (ticket) =>
            ticket.endReason === null ||
            byTime.includes(ticket.endReason) ||
            byPerson.includes(ticket.endReason),
        ),
      ),
      RUNS,
    );
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

  it('保留の期限は、1 回分の上限を超えて置かれない', () => {
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
  return ticket.pauseDeadline - ticket.pausedSince <= minutes(policy.pauseStepMin);
}

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type NoShowPolicy, type Policy } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import { createTicket, type Ticket, type TicketState } from '../domain/ticket.js';
import { createVenueState, findTicket, sameVenueState, type VenueState } from '../domain/state.js';
import { checkInvariants, checkTransition } from '../invariant.js';
import { minutes, seconds, type Timestamp } from '../time.js';
import { apply } from './apply.js';
import { remainingPauseBudget } from './deadlines.js';
import { COMMAND_TYPES, type Actor, type CancelReason, type Command, type CommandType } from './command.js';
import type { DomainEvent } from './events.js';
import { STATE_INVARIANTS, priorityPreservedAcrossPause } from './invariants.js';
import { TICKET_TRANSITIONS } from './ticket-machine.js';

/**
 * ランダムなコマンド列を流し、`apply` の骨格が守るべきことを確かめる。
 *
 * 手で書いたテスト（`apply.test.ts`）は「何が起きるか」を読めるようにするもので、
 * こちらは「何が **決して** 起きないか」を探すものである。以降の PR でコマンドが
 * 増えるたびに、下の生成器へ足していく。足し忘れは
 * 「生成器が COMMAND_TYPES をすべて覆う」というテストが捕まえる。
 *
 * 生成器は PR 4（割当の選択）のものとは別に書いてある。あちらは不整合な状態も
 * 含めてよい（`chooseAssignments` は `WAITING` と `FREE` しか読まない）が、
 * こちらは **不変条件を満たす状態から始めなければならない**。壊れた状態から
 * 始めるとすべてのコマンドが `INVARIANT_VIOLATED` で弾かれ、何も検査できない。
 */

const NOW: Timestamp = 1_700_000_000_000;
const TICKET_IDS: readonly string[] = ['k1', 'k2', 'k3', 'k4'];
const TAG_POOL: readonly string[] = ['power', 'wheelchair'];
const RUNS = { numRuns: 500 };

/** 呼び出し済みで置いておくチケットと席。PR 5 には呼び出しのコマンドが無いため。 */
const CALLED_TICKET_ID = 'k0';
const HELD_TABLE_ID = 'tb-held';

// ---- 生成器 ----

const policyArb: fc.Arbitrary<Policy> = fc
  .record({
    maxQueueLength: fc.integer({ min: 1, max: 6 }),
    pauseStepMin: fc.integer({ min: 0, max: 20 }),
    pauseMaxTotalMin: fc.integer({ min: 0, max: 60 }),
    maxPartySize: fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }),
    noShowPolicy: fc.constantFrom<NoShowPolicy>('cancel', 'requeue_once', 'requeue_back'),
  })
  .map((chosen) => ({ ...DEFAULT_POLICY, ...chosen }));

function tableAt(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE', ...overrides };
}

/** 呼び出し済みの 1 組を含む、不変条件を満たす出発点。 */
function withCalledParty(state: VenueState): VenueState {
  const held: Table = tableAt(HELD_TABLE_ID, 4, {
    status: 'HELD',
    occupantTicketId: CALLED_TICKET_ID,
  });
  const ticket: Ticket = {
    ...createTicket({ id: CALLED_TICKET_ID, code: 'Z-99', partySize: 2, now: NOW }),
    state: 'CALLED',
    tableId: HELD_TABLE_ID,
    calledAt: NOW,
    holdDeadline: NOW + minutes(7),
  };
  return { ...state, tables: [...state.tables, held], tickets: [...state.tickets, ticket] };
}

const stateArb: fc.Arbitrary<VenueState> = fc
  .record({
    capacities: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 }),
    policy: policyArb,
    joinOpen: fc.boolean(),
    called: fc.boolean(),
  })
  .map(({ capacities, policy, joinOpen, called }) => {
    const tables = capacities.map((capacity, index) => tableAt(`tb${index}`, capacity));
    const base: VenueState = {
      ...createVenueState({ venueId: 'v1', policy, tables }),
      operating: true,
      joinOpen,
    };
    return called ? withCalledParty(base) : base;
  });

const ticketIdArb: fc.Arbitrary<string> = fc.constantFrom(...TICKET_IDS, CALLED_TICKET_ID, 'missing');

const tableIdArb: fc.Arbitrary<string> = fc.constantFrom('tb0', 'tb1', 'tb2', HELD_TABLE_ID, 'missing');

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc
    .record({
      ticketId: fc.constantFrom(...TICKET_IDS),
      partySize: fc.integer({ min: 0, max: 6 }),
      requiredTags: fc.subarray([...TAG_POOL]),
      hasNotificationChannel: fc.boolean(),
    })
    .map((fields): Command => ({ type: 'JOIN', ...fields })),
  fc
    .record({
      ticketId: ticketIdArb,
      by: fc.constantFrom<Actor>('user', 'staff'),
      reason: fc.option(fc.constantFrom<CancelReason>('found_seat', 'leaving', 'too_long', 'other'), {
        nil: null,
      }),
    })
    .map((fields): Command => ({ type: 'CANCEL', ...fields })),
  ticketIdArb.map((ticketId): Command => ({ type: 'PAUSE', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'READY', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'EXTEND', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'PASS', ticketId })),
  fc
    .record({ ticketId: ticketIdArb, tableId: tableIdArb })
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
    .record({ ticketId: ticketIdArb, tableId: tableIdArb, partySize: fc.integer({ min: 0, max: 6 }) })
    .map((fields): Command => ({ type: 'WALK_IN', ...fields })),
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
    .record({ ticketId: ticketIdArb, partySize: fc.integer({ min: 0, max: 6 }) })
    .map((fields): Command => ({ type: 'CHANGE_PARTY_SIZE', ...fields })),
  ticketIdArb.map((ticketId): Command => ({ type: 'HEARTBEAT', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'STILL_HERE', ticketId })),
);

const scenarioArb = fc.record({
  state: stateArb,
  commands: fc.array(commandArb, { minLength: 1, maxLength: 20 }),
});

// ---- 実行 ----

interface Step {
  readonly before: VenueState;
  readonly after: VenueState;
  readonly command: Command;
  readonly events: readonly DomainEvent[];
  /** そのコマンドを適用した時刻。**拒否された分は記録されないので、間隔は一定でない。** */
  readonly at: Timestamp;
}

/**
 * コマンドを順に適用し、通ったものを記録する。
 *
 * 1 件ごとに 30 秒進める。`tick` はまだ無いので、時刻が進むこと自体は
 * 何も起こさない。拒否されたコマンドは状態を変えずに読み飛ばす。
 */
function run(initial: VenueState, commands: readonly Command[]): readonly Step[] {
  const steps: Step[] = [];
  let state: VenueState = initial;
  let now: Timestamp = NOW;
  for (const command of commands) {
    now += seconds(30);
    const result = apply(state, command, now);
    if (result.ok) {
      steps.push({
        before: state,
        after: result.value.state,
        command,
        events: result.value.events,
        at: now,
      });
      state = result.value.state;
    }
  }
  return steps;
}

function finalState(initial: VenueState, commands: readonly Command[]): VenueState {
  const steps = run(initial, commands);
  return steps.at(-1)?.after ?? initial;
}

function ticketStates(state: VenueState): ReadonlyMap<string, TicketState> {
  return new Map(state.tickets.map((ticket) => [ticket.id, ticket.state]));
}

function tableStatuses(state: VenueState): ReadonlyMap<string, string> {
  return new Map(state.tables.map((table) => [table.id, table.status]));
}

/** 状態機械の状態が動いたか（欄の書き換えだけなら動いていない）。 */
function machineMoved(step: Step): boolean {
  const before = ticketStates(step.before);
  const beforeTables = tableStatuses(step.before);
  const ticketMoved = step.after.tickets.some((ticket) => before.get(ticket.id) !== ticket.state);
  const tableMoved = step.after.tables.some((table) => beforeTables.get(table.id) !== table.status);
  return ticketMoved || tableMoved;
}

// ---- 性質 ----

describe('生成器そのもの', () => {
  it('出発点は必ず不変条件を満たす（満たさなければ以降の検査に意味が無い）', () => {
    fc.assert(
      fc.property(stateArb, (state) => checkInvariants(STATE_INVARIANTS, state).length === 0),
      RUNS,
    );
  });

  it('宣言されたコマンドの種別をすべて生成する（足し忘れの検出）', () => {
    const produced = new Set<CommandType>();
    fc.assert(
      fc.property(commandArb, (command) => {
        produced.add(command.type);
        return true;
      }),
      RUNS,
    );
    expect([...produced].sort()).toEqual([...COMMAND_TYPES].sort());
  });
});

describe('apply が決して破らないこと', () => {
  it('通ったコマンドの結果は、必ず不変条件を満たす', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) =>
        run(state, commands).every((step) => checkInvariants(STATE_INVARIANTS, step.after).length === 0),
      ),
      RUNS,
    );
  });

  it('渡した状態を書き換えない（拒否されても通っても）', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) => {
        const snapshot = structuredClone(state);
        run(state, commands);
        expect(state).toStrictEqual(snapshot);
      }),
      RUNS,
    );
  });

  /**
   * **1 回の `apply` は、1 枚のチケットを最大 2 歩動かす。**
   *
   * コマンドの分と、そのあとに必ず走る割当の分である。たとえば「準備OK」は
   * `PAUSED → WAITING` と動かし、続く割当が空席を見つければ `WAITING → CALLED`
   * まで進む。前後の状態だけを見ると `PAUSED → CALLED` という表に無い遷移に
   * 見えるが、実際には宣言された 2 本を続けて通っている。
   *
   * ここを緩めて「到達できればよい」にすると検査が効かなくなるので、
   * **割当の一歩は `TicketCalled` が出ていることで見分け**、コマンドの一歩を
   * 表と突き合わせる。
   */
  it('チケットの状態が動いたなら、コマンドの一歩も割当の一歩も表に宣言されている', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) =>
        run(state, commands).every(everyMoveIsDeclared),
      ),
      RUNS,
    );
  });

  it('割当が使う一歩（WAITING → CALLED）は表に宣言されている', () => {
    expect(declaredMove('WAITING', 'CALLED')).toBe(true);
  });

  it('状態機械が動いたなら、必ずイベントが 1 つ以上出る', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) =>
        run(state, commands).every((step) => !machineMoved(step) || step.events.length > 0),
      ),
      RUNS,
    );
  });

  it('保留の出入りで順番が変わらない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) =>
        run(state, commands).every(
          (step) => checkTransition([priorityPreservedAcrossPause], step.before, step.after).length === 0,
        ),
      ),
      RUNS,
    );
  });

  it('同じコマンド列を 2 回流すと同じ状態になる（決定的である）', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) =>
        sameVenueState(finalState(state, commands), finalState(state, commands)),
      ),
      RUNS,
    );
  });

  it('イベントの時刻は、そのコマンドを適用した時刻と一致する', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) =>
        run(state, commands).every((step) => step.events.every((event) => event.at === step.at)),
      ),
      RUNS,
    );
  });
});

describe('受付が守ること（7.5）', () => {
  it('受け付けられた人は、待ちに入るか、その場で呼び出される（7.5 の 4）', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) =>
        run(state, commands).every(
          (step) => step.command.type !== 'JOIN' || joinedTicketIsQueued(step),
        ),
      ),
      RUNS,
    );
  });

  it('待ち行列の長さが上限を超えることはない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) => {
        const last = finalState(state, commands);
        const queued = last.tickets.filter((ticket) =>
          ['WAITING', 'PAUSED', 'CALLED'].includes(ticket.state),
        );
        return queued.length <= Math.max(last.policy.maxQueueLength, queuedAtStart(state));
      }),
      RUNS,
    );
  });

  it('生きているチケットの表示コードが重複しない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) => {
        const codes = finalState(state, commands)
          .tickets.filter((ticket) => !['DONE', 'CANCELLED', 'NO_SHOW', 'EXPIRED'].includes(ticket.state))
          .map((ticket) => ticket.code);
        return new Set(codes).size === codes.length;
      }),
      RUNS,
    );
  });

  it('人数が 1 未満、または上限を超えるチケットは生まれない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) =>
        finalState(state, commands).tickets.every(
          (ticket) => Number.isInteger(ticket.partySize) && ticket.partySize >= 1,
        ),
      ),
      RUNS,
    );
  });
});

describe('保留が守ること（7.7 の 7）', () => {
  /**
   * **「保留の合計時間が上限を超えない」は成り立たない。** ファズが反例を出した。
   *
   * 上限は期限という 1 つの仕掛けで守っている。持ち時間を使い切った人の期限は
   * 現在時刻になるが、期限切れにするのは `tick`（PR 6）なので、次の `tick` までの
   * あいだに本人が「準備OK」を押せば、その数十秒ぶんだけ合計が上限を超える。
   * 実運用の `tick` は 10 秒ごとなので超過はその範囲に収まる。
   *
   * `apply` が守れるのは「1 回に渡す持ち時間」までである。下がその性質。
   */
  it('保留に渡す持ち時間は、1 回分の上限と残りのどちらも超えない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) =>
        run(state, commands).every((step) => grantedPauseIsBounded(step)),
      ),
      RUNS,
    );
  });

  it('保留していない人に保留の起点が残らない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands }) =>
        finalState(state, commands).tickets.every(
          (ticket) => ticket.state === 'PAUSED' || ticket.pausedSince === null,
        ),
      ),
      RUNS,
    );
  });
});

// ---- 判定の助け ----

function declaredMove(from: TicketState, to: TicketState): boolean {
  return TICKET_TRANSITIONS.some((row) => row.from === from && row.to === to);
}

function everyMoveIsDeclared(step: Step): boolean {
  const before = ticketStates(step.before);
  const calledHere: ReadonlySet<string> = new Set(
    step.events.filter((event) => event.type === 'TicketCalled').map((event) => event.ticketId),
  );
  return step.after.tickets.every((ticket) => {
    const from = before.get(ticket.id);
    if (from === undefined) return true; // この手で生まれたチケット
    if (!calledHere.has(ticket.id)) return from === ticket.state || declaredMove(from, ticket.state);

    // 割当で呼ばれた人は、最後の一歩が WAITING → CALLED だったはず。
    if (ticket.state !== 'CALLED') return false;
    return from === 'WAITING' || declaredMove(from, 'WAITING');
  });
}

function joinedTicketIsQueued(step: Step): boolean {
  if (step.command.type !== 'JOIN') return true;
  const joined = findTicket(step.after, step.command.ticketId);
  return joined !== undefined && (joined.state === 'WAITING' || joined.state === 'CALLED');
}

function queuedAtStart(state: VenueState): number {
  return state.tickets.filter((ticket) => ['WAITING', 'PAUSED', 'CALLED'].includes(ticket.state)).length;
}

/** 保留に入れた 1 回で渡した持ち時間が、2 つの上限に収まっているか。 */
function grantedPauseIsBounded(step: Step): boolean {
  if (step.command.type !== 'PAUSE') return true;
  const before = findTicket(step.before, step.command.ticketId);
  const paused = findTicket(step.after, step.command.ticketId);
  if (before === undefined || paused?.pauseDeadline == null || paused.pausedSince === null) return true;

  const granted = paused.pauseDeadline - paused.pausedSince;
  const policy = step.after.policy;
  return granted <= minutes(policy.pauseStepMin) && granted <= remainingPauseBudget(before, policy);
}

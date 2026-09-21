/**
 * ランダムなコマンド列を流しても、書いたものが読み戻せるか。
 *
 * **手で書いた筋書きは、思いついた場面しか通らない。** 書き込みの順序の罠は、
 * 思いつかなかった組み合わせで出る。だから乱数で流す。
 *
 * 判定は 1 つだけである。**1 回記録するたびに、読み戻したものが手元と一致する。**
 * 不変条件そのものは `core` が見ている（`apply` と `tick` の出口）ので、ここで
 * 重ねて見ない。ここが見るのは**永続化が状態を歪めないこと**だけである。
 */

import { minutes, type Command, type Table, type Ticket, type VenueState } from '@openseat/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { harness, recorder, seed, VENUE_ID, type Recorder } from './fixtures.js';
import { loadVenueState, readTableSpans } from './repository.js';

/** 出すコマンドの種類。**`TICK` だけはコマンドではなく、時刻を進める。** */
const STEP_KINDS = [
  'JOIN',
  'JOIN',
  'JOIN',
  'TICK',
  'TICK',
  'CHECK_IN',
  'CHECK_OUT',
  'CANCEL',
  'PAUSE',
  'READY',
  'EXTEND',
  'PASS',
  'REPORT_TAKEN',
  'REPORT_IN_USE',
  'CONFIRM_FREE',
  'STILL_HERE',
  'CHANGE_PARTY_SIZE',
  'HEARTBEAT',
  'SWAP_TABLE',
  'CHECK_IN_EARLY',
  'WALK_IN',
  'DISABLE_TABLE',
  'ENABLE_TABLE',
  'RELEASE_ALL',
  'CLOSE',
  'OPEN',
] as const;

interface Step {
  readonly kind: (typeof STEP_KINDS)[number];
  /** どれを選ぶか。0 以上 1 未満。 */
  readonly pick: number;
  readonly partySize: number;
  /** 前の手からどれだけ進めるか（分）。 */
  readonly wait: number;
}

const stepArb: fc.Arbitrary<Step> = fc.record({
  kind: fc.constantFrom(...STEP_KINDS),
  pick: fc.double({ min: 0, max: 0.999, noNaN: true }),
  partySize: fc.integer({ min: 1, max: 6 }),
  wait: fc.integer({ min: 0, max: 12 }),
});

/** その中から 1 つ選ぶ。空なら `undefined`。 */
function choose<T>(candidates: readonly T[], pick: number): T | undefined {
  return candidates[Math.floor(pick * candidates.length)];
}

function ticketsIn(state: VenueState, ...states: readonly string[]): readonly Ticket[] {
  return state.tickets.filter((ticket) => states.includes(ticket.state));
}

function tablesIn(state: VenueState, ...statuses: readonly string[]): readonly Table[] {
  return state.tables.filter((table) => statuses.includes(table.status));
}

/**
 * いまの状態を見て、その手にあたるコマンドを組み立てる。
 *
 * **選べる相手がいなければ `null`。** 無理に出しても `core` が拒否するだけで、
 * 記録は何も起きない。時間の無駄なので出さない。
 */
function commandFor(state: VenueState, step: Step, seq: number): Command | null {
  const ticket = (...where: readonly string[]): Ticket | undefined =>
    choose(ticketsIn(state, ...where), step.pick);
  const table = (...where: readonly string[]): Table | undefined =>
    choose(tablesIn(state, ...where), step.pick);

  switch (step.kind) {
    case 'JOIN':
      return { type: 'JOIN', ticketId: `k-${String(seq)}`, partySize: step.partySize, requiredTags: [], hasNotificationChannel: step.pick < 0.5 };
    case 'CHECK_IN': {
      const called = ticket('CALLED');
      return called?.tableId === undefined || called.tableId === null
        ? null
        : { type: 'CHECK_IN', ticketId: called.id, tableId: called.tableId };
    }
    case 'CHECK_OUT': {
      const seated = ticket('SEATED');
      return seated === undefined ? null : { type: 'CHECK_OUT', ticketId: seated.id, by: 'user' };
    }
    case 'CANCEL': {
      const any = ticket('WAITING', 'PAUSED', 'CALLED');
      return any === undefined ? null : { type: 'CANCEL', ticketId: any.id, by: 'user', reason: 'leaving' };
    }
    case 'PAUSE': {
      const called = ticket('CALLED');
      return called === undefined ? null : { type: 'PAUSE', ticketId: called.id };
    }
    case 'READY': {
      const paused = ticket('PAUSED');
      return paused === undefined ? null : { type: 'READY', ticketId: paused.id };
    }
    case 'EXTEND': {
      const waiting = ticket('CALLED', 'PAUSED');
      return waiting === undefined ? null : { type: 'EXTEND', ticketId: waiting.id };
    }
    case 'PASS': {
      const called = ticket('CALLED');
      return called === undefined ? null : { type: 'PASS', ticketId: called.id };
    }
    case 'REPORT_TAKEN': {
      const called = ticket('CALLED');
      return called?.tableId === undefined || called.tableId === null
        ? null
        : { type: 'REPORT_TAKEN', ticketId: called.id, tableId: called.tableId };
    }
    case 'REPORT_IN_USE': {
      const uncertain = table('NEEDS_CHECK', 'FREE');
      return uncertain === undefined
        ? null
        : { type: 'REPORT_IN_USE', tableId: uncertain.id, ticketId: null };
    }
    case 'CONFIRM_FREE': {
      const uncertain = table('NEEDS_CHECK', 'OCCUPIED_UNKNOWN');
      return uncertain === undefined
        ? null
        : { type: 'CONFIRM_FREE', tableId: uncertain.id, by: 'staff' };
    }
    case 'STILL_HERE': {
      const seated = ticket('SEATED');
      return seated === undefined ? null : { type: 'STILL_HERE', ticketId: seated.id };
    }
    case 'CHANGE_PARTY_SIZE': {
      const waiting = ticket('WAITING');
      return waiting === undefined
        ? null
        : { type: 'CHANGE_PARTY_SIZE', ticketId: waiting.id, partySize: step.partySize };
    }
    case 'HEARTBEAT': {
      const any = ticket('WAITING', 'PAUSED', 'CALLED', 'SEATED');
      return any === undefined ? null : { type: 'HEARTBEAT', ticketId: any.id };
    }
    case 'SWAP_TABLE': {
      const called = ticket('CALLED');
      const free = table('FREE');
      return called === undefined || free === undefined
        ? null
        : { type: 'SWAP_TABLE', ticketId: called.id, tableId: free.id };
    }
    case 'CHECK_IN_EARLY': {
      const waiting = ticket('WAITING');
      const free = table('FREE');
      return waiting === undefined || free === undefined
        ? null
        : { type: 'CHECK_IN_EARLY', ticketId: waiting.id, tableId: free.id };
    }
    case 'WALK_IN': {
      const free = table('FREE');
      return free === undefined
        ? null
        : { type: 'WALK_IN', ticketId: `w-${String(seq)}`, tableId: free.id, partySize: step.partySize };
    }
    case 'DISABLE_TABLE': {
      const any = choose(state.tables, step.pick);
      return any === undefined ? null : { type: 'DISABLE_TABLE', tableId: any.id, by: 'staff' };
    }
    case 'ENABLE_TABLE': {
      const any = choose(state.tables, step.pick);
      return any === undefined ? null : { type: 'ENABLE_TABLE', tableId: any.id, by: 'staff' };
    }
    case 'RELEASE_ALL':
      return { type: 'RELEASE_ALL', by: 'staff' };
    case 'CLOSE':
      return { type: 'CLOSE', by: 'staff' };
    case 'OPEN':
      return { type: 'OPEN', closesAt: null, by: 'staff' };
    case 'TICK':
      return null;
  }
}

/** 1 手進める。`TICK` は時刻だけを進める。 */
function play(run: Recorder, step: Step, now: number, seq: number): void {
  if (step.kind === 'TICK') {
    run.advance(now);
    return;
  }
  const command = commandFor(run.state(), step, seq);
  if (command !== null) run.send(command, now);
}

describe('でたらめな 1 日の変化を、すべて書き留める', () => {
  it('1 回ごとに、手元にあったものがそのまま読み戻せる', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 20, maxLength: 60 }), (steps) => {
        const box = harness();
        try {
          const opened = Date.UTC(2027, 2, 6, 2, 0, 0);
          const run = recorder(box.db, seed(box.db, { capacities: [2, 2, 4, 6], now: opened }));
          run.send({ type: 'OPEN', closesAt: opened + minutes(240), by: 'staff' }, opened);

          const clock = steps.reduce((now, step, index) => {
            const next = now + minutes(step.wait);
            play(run, step, next, index);
            expect(loadVenueState(box.db, VENUE_ID)).toEqual(run.state());
            return next;
          }, opened);

          expectSpansCoverEverything(box.db, run.state(), clock);
        } finally {
          box.dispose();
        }
      }),
      { numRuns: 100 },
    );
  });
});

/** 席の姿の履歴が、最初から最後まで隙間なく続いていること。 */
function expectSpansCoverEverything(
  db: ReturnType<typeof harness>['db'],
  state: VenueState,
  clock: number,
): void {
  const spans = readTableSpans(db, VENUE_ID);
  for (const table of state.tables) {
    const mine = spans.filter((span) => span.tableId === table.id);
    const gaps = mine
      .slice(1)
      .map((span, index) => ({ until: mine[index]?.untilAt, from: span.fromAt }))
      .filter((joint) => joint.until !== joint.from);

    expect({ table: table.id, gaps, open: mine.filter((s) => s.untilAt === null).length }).toEqual({
      table: table.id,
      gaps: [],
      open: 1,
    });
    // 開いている区間の姿は、いまの席の姿と一致している。
    const open = mine.find((span) => span.untilAt === null);
    expect(open?.status).toBe(table.status);
    // 始まりは、席がいまの姿になった時刻。**ただし前に戻ることはない**
    // （`spanBoundary` の説明にある、呼び出しの期限を過ぎてから席を変えた場合）。
    expect(open?.fromAt).toBeGreaterThanOrEqual(table.statusSince);
    expect(table.statusSince).toBeLessThanOrEqual(clock);
  }
}

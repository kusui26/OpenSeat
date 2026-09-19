import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '../domain/policy.js';
import { createTable, type Table, type TableStatus } from '../domain/table.js';
import type { Ticket, TicketState } from '../domain/ticket.js';
import { createVenueState, findTable, findTicket, type VenueState } from '../domain/state.js';
import { minutes, type Timestamp } from '../time.js';
import { apply } from './apply.js';
import type { Command } from './command.js';
import { TABLE_TRANSITIONS, type TableEvent, type TableGuard, type TableTransition } from './table-machine.js';
import {
  TICKET_TRANSITIONS,
  type TicketEvent,
  type TicketGuard,
  type TicketTransition,
} from './ticket-machine.js';
import { tableTransitionRow, ticketTransitionRow } from './transition.js';
import { tick } from './tick.js';

/**
 * 遷移表の網羅性（Phase 1 プラン PR 12）。
 *
 * > **宣言した遷移は、全部動くか。**
 *
 * 遷移表はデータなので、書いただけでは誰も通らない行を作れてしまう。事象を
 * 起こす側が無い、先に並ぶ行に隠れている、ガードが決して成立しない —— どれも
 * 静かに死ぬ。ここでは **1 行につき 1 つ、実際に動かしてみせる証拠**を置く。
 *
 * 証拠は 2 つのことを同時に示す。
 *
 * 1. **その事象を起こす道がある。** `apply` か `tick` を 1 手動かして、
 *    対象が `from` から `to` へ動くことを見る
 * 2. **その行が採られる。** 同じ（状態、事象）に複数の行があっても、
 *    `ticketTransitionRow` / `tableTransitionRow` がまさにこの行を返す
 *
 * **証拠の無い行は落ちる。** 遷移を足したら、ここに証拠を足さないと通らない。
 */

const NOW: Timestamp = 1_700_000_000_000;

function at(elapsedMin: number): Timestamp {
  return NOW + minutes(elapsedMin);
}

/** 席。作った直後は対象外（運用開始で空席になる）。 */
function tbl(id: string, capacity: number, overrides: Partial<Table> = {}): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), ...overrides };
}

interface Step {
  readonly before: VenueState;
  readonly after: VenueState;
  readonly now: Timestamp;
}

function run(state: VenueState, command: Command, now: Timestamp): VenueState {
  const result = apply(state, command, now);
  if (!result.ok) throw new Error(`拒否された: ${result.error.code} ${result.error.describe}`);
  return result.value.state;
}

function advance(state: VenueState, now: Timestamp): VenueState {
  const result = tick(state, now);
  if (!result.ok) throw new Error(`tick が拒否された: ${result.error.code}`);
  return result.value.state;
}

/** コマンドを 1 手。前後を返す。 */
function byCommand(state: VenueState, command: Command, now: Timestamp): Step {
  return { before: state, after: run(state, command, now), now };
}

/** 時計を進めるのを 1 手。前後を返す。 */
function byClock(state: VenueState, now: Timestamp): Step {
  return { before: state, after: advance(state, now), now };
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

// ---- 筋書きの土台 ----

/** 運用を始めた施設。席は `OPEN` で自由席から戻る。 */
function opened(tables: readonly Table[], policy: Policy = DEFAULT_POLICY): VenueState {
  const closed = createVenueState({ venueId: 'v1', policy, tables });
  return run(closed, { type: 'OPEN', closesAt: null, by: 'staff' }, NOW);
}

function join(state: VenueState, id: string, partySize: number, now: Timestamp): VenueState {
  return run(
    state,
    { type: 'JOIN', ticketId: id, partySize, requiredTags: [], hasNotificationChannel: true },
    now,
  );
}

/** 1 卓だけの施設に 1 人。空席があるので、その場で呼び出される。 */
function called(policy: Policy = DEFAULT_POLICY): VenueState {
  return join(opened([tbl('tb-4', 4)], policy), 'k1', 3, at(1));
}

/** 呼ばれた人が着席した。 */
function seated(policy: Policy = DEFAULT_POLICY): VenueState {
  return run(called(policy), { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(2));
}

/** 1 卓が埋まっていて、次の人が待っている。 */
function waiting(policy: Policy = DEFAULT_POLICY): VenueState {
  return join(seated(policy), 'k2', 4, at(3));
}

/** 待っている人が保留に入った。 */
function paused(policy: Policy = DEFAULT_POLICY): VenueState {
  return run(waiting(policy), { type: 'PAUSE', ticketId: 'k2' }, at(4));
}

/**
 * 着席中の席が「確認要」に落ちた状態（7.11）。待っている人が 1 人いる。
 *
 * 上限モードを `soft`、問いかけと絶対上限を十分先へずらして、**超過だけ**で
 * 落ちるようにしてある。
 */
const UNCERTAIN_POLICY: Policy = {
  ...DEFAULT_POLICY,
  timeLimitMode: 'soft',
  stillHerePromptMin: 600,
  ticketMaxAgeMin: 600,
};

function uncertain(): VenueState {
  // 60 分の上限 ＋ 15 分の猶予。着席は 2 分なので 78 分で落ちている。
  const state = advance(waiting(UNCERTAIN_POLICY), at(78));
  expect(tableOf(state, 'tb-4').status).toBe('NEEDS_CHECK');
  expect(ticketOf(state, 'k1').state).toBe('SEATED');
  expect(ticketOf(state, 'k2').state).toBe('WAITING');
  return state;
}

// ---- チケットの証拠 ----

interface TicketWitness {
  readonly from: TicketState;
  readonly on: TicketEvent;
  readonly to: TicketState;
  readonly guard: TicketGuard | null;
  /** 何がこの事象を起こすか。コマンド名か、`tick` が見る期限の名前。 */
  readonly by: string;
  readonly ticketId: string;
  /** ガードが見る席。要らない遷移では null。 */
  readonly tableId: string | null;
  readonly step: () => Step;
}

const TICKET_WITNESSES: readonly TicketWitness[] = [
  {
    from: 'WAITING',
    on: 'CALL',
    to: 'CALLED',
    guard: 'fitsCapacity',
    by: '割当（席が空いたとき、出口で実行される）',
    ticketId: 'k2',
    tableId: 'tb-4',
    step: () => byCommand(waiting(), { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(10)),
  },
  {
    from: 'WAITING',
    on: 'CHECK_IN_EARLY',
    to: 'SEATED',
    guard: 'earlyCheckInAllowed',
    by: 'CHECK_IN_EARLY（確認要の席に案内された人が、空いていたので座る）',
    ticketId: 'k2',
    tableId: 'tb-4',
    step: () =>
      byCommand(uncertain(), { type: 'CHECK_IN_EARLY', ticketId: 'k2', tableId: 'tb-4' }, at(80)),
  },
  {
    from: 'WAITING',
    on: 'PAUSE',
    to: 'PAUSED',
    guard: null,
    by: 'PAUSE',
    ticketId: 'k2',
    tableId: null,
    step: () => byCommand(waiting(), { type: 'PAUSE', ticketId: 'k2' }, at(10)),
  },
  {
    from: 'WAITING',
    on: 'CANCEL',
    to: 'CANCELLED',
    guard: null,
    by: 'CANCEL',
    ticketId: 'k2',
    tableId: null,
    step: () =>
      byCommand(waiting(), { type: 'CANCEL', ticketId: 'k2', by: 'user', reason: null }, at(10)),
  },
  {
    from: 'WAITING',
    on: 'CLOSE',
    to: 'CANCELLED',
    guard: null,
    by: 'CLOSE（運用終了）',
    ticketId: 'k2',
    tableId: null,
    step: () => byCommand(waiting(), { type: 'CLOSE', by: 'staff' }, at(10)),
  },
  {
    from: 'WAITING',
    on: 'VENUE_RELEASE',
    to: 'CANCELLED',
    guard: null,
    by: 'RELEASE_ALL（全席解放）',
    ticketId: 'k2',
    tableId: null,
    step: () => byCommand(waiting(), { type: 'RELEASE_ALL', by: 'staff' }, at(10)),
  },
  {
    from: 'WAITING',
    on: 'ABANDON',
    to: 'EXPIRED',
    guard: 'noNotificationChannel',
    by: 'tick（放置の期限）',
    ticketId: 'k2',
    tableId: null,
    step: () => {
      const state = run(
        seated(),
        { type: 'JOIN', ticketId: 'k2', partySize: 4, requiredTags: [], hasNotificationChannel: false },
        at(3),
      );
      // abandon_timeout_min の既定は 10 分。
      return byClock(state, at(14));
    },
  },
  {
    from: 'WAITING',
    on: 'MAX_AGE',
    to: 'EXPIRED',
    guard: null,
    by: 'tick（受付からの絶対上限）',
    ticketId: 'k2',
    tableId: null,
    step: () => byClock(waiting(), at(95)),
  },
  {
    from: 'PAUSED',
    on: 'READY',
    to: 'WAITING',
    guard: null,
    by: 'READY',
    ticketId: 'k2',
    tableId: null,
    step: () => byCommand(paused(), { type: 'READY', ticketId: 'k2' }, at(10)),
  },
  {
    from: 'PAUSED',
    on: 'EXTEND',
    to: 'PAUSED',
    guard: null,
    by: 'EXTEND（保留の延長）',
    ticketId: 'k2',
    tableId: null,
    step: () => byCommand(paused(), { type: 'EXTEND', ticketId: 'k2' }, at(10)),
  },
  {
    from: 'PAUSED',
    on: 'CANCEL',
    to: 'CANCELLED',
    guard: null,
    by: 'CANCEL',
    ticketId: 'k2',
    tableId: null,
    step: () =>
      byCommand(paused(), { type: 'CANCEL', ticketId: 'k2', by: 'staff', reason: 'other' }, at(10)),
  },
  {
    from: 'PAUSED',
    on: 'CLOSE',
    to: 'CANCELLED',
    guard: null,
    by: 'CLOSE（運用終了）',
    ticketId: 'k2',
    tableId: null,
    step: () => byCommand(paused(), { type: 'CLOSE', by: 'staff' }, at(10)),
  },
  {
    from: 'PAUSED',
    on: 'VENUE_RELEASE',
    to: 'CANCELLED',
    guard: null,
    by: 'RELEASE_ALL（全席解放）',
    ticketId: 'k2',
    tableId: null,
    step: () => byCommand(paused(), { type: 'RELEASE_ALL', by: 'staff' }, at(10)),
  },
  {
    from: 'PAUSED',
    on: 'PAUSE_EXPIRE',
    to: 'EXPIRED',
    guard: null,
    by: 'tick（保留の期限）',
    ticketId: 'k2',
    tableId: null,
    // pause_step_min の既定は 10 分。保留に入ったのは 4 分。
    step: () => byClock(paused(), at(16)),
  },
  {
    from: 'PAUSED',
    on: 'MAX_AGE',
    to: 'EXPIRED',
    guard: null,
    by: 'tick（受付からの絶対上限。保留の期限より先に来る設定）',
    ticketId: 'k2',
    tableId: null,
    step: () => {
      const longPause: Policy = { ...DEFAULT_POLICY, pauseStepMin: 90, pauseMaxTotalMin: 90, ticketMaxAgeMin: 20 };
      return byClock(paused(longPause), at(25));
    },
  },
  {
    from: 'CALLED',
    on: 'CHECK_IN',
    to: 'SEATED',
    guard: 'isAssignedTable',
    by: 'CHECK_IN',
    ticketId: 'k1',
    tableId: 'tb-4',
    step: () => byCommand(called(), { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(2)),
  },
  {
    from: 'CALLED',
    on: 'EXTEND',
    to: 'CALLED',
    guard: 'underExtensionLimit',
    by: 'EXTEND（「向かっています」）',
    ticketId: 'k1',
    tableId: null,
    step: () => byCommand(called(), { type: 'EXTEND', ticketId: 'k1' }, at(2)),
  },
  {
    from: 'CALLED',
    on: 'SWAP_TABLE',
    to: 'CALLED',
    guard: 'swapAllowed',
    by: 'SWAP_TABLE（別の空席へ移る）',
    ticketId: 'k1',
    tableId: 'tb-4b',
    step: () => {
      const state = join(opened([tbl('tb-4', 4), tbl('tb-4b', 4)]), 'k1', 3, at(1));
      return byCommand(state, { type: 'SWAP_TABLE', ticketId: 'k1', tableId: 'tb-4b' }, at(2));
    },
  },
  {
    from: 'CALLED',
    on: 'PASS',
    to: 'PAUSED',
    guard: null,
    by: 'PASS（次の人に譲る）',
    ticketId: 'k1',
    tableId: null,
    step: () => byCommand(called(), { type: 'PASS', ticketId: 'k1' }, at(2)),
  },
  {
    from: 'CALLED',
    on: 'HOLD_EXPIRE',
    to: 'PAUSED',
    guard: 'requeueOnNoShow',
    by: 'tick（ホールドの期限。requeue_once の 1 回目）',
    ticketId: 'k1',
    tableId: null,
    // hold_min の既定は 7 分。呼ばれたのは 1 分。
    step: () => byClock(called(), at(10)),
  },
  {
    from: 'CALLED',
    on: 'HOLD_EXPIRE',
    to: 'WAITING',
    guard: 'requeueToBackOnNoShow',
    by: 'tick（ホールドの期限。requeue_back）',
    ticketId: 'k1',
    tableId: null,
    step: () => {
      // **後ろに 1 人並べておく。** 1 人だけだと、末尾へ戻った本人がその場で
      // 呼び直されて `CALLED` に戻り、待ちに戻ったことが見えない。
      const back: Policy = { ...DEFAULT_POLICY, noShowPolicy: 'requeue_back' };
      const state = join(called(back), 'k2', 3, at(2));
      return byClock(state, at(10));
    },
  },
  {
    from: 'CALLED',
    on: 'HOLD_EXPIRE',
    to: 'NO_SHOW',
    guard: 'finalNoShow',
    by: 'tick（ホールドの期限。cancel 方針）',
    ticketId: 'k1',
    tableId: null,
    step: () => byClock(called({ ...DEFAULT_POLICY, noShowPolicy: 'cancel' }), at(10)),
  },
  {
    from: 'CALLED',
    on: 'REPORT_TAKEN',
    to: 'WAITING',
    guard: null,
    by: 'REPORT_TAKEN（案内された席に誰かが座っていた）',
    ticketId: 'k1',
    tableId: 'tb-4',
    step: () =>
      byCommand(called(), { type: 'REPORT_TAKEN', ticketId: 'k1', tableId: 'tb-4' }, at(2)),
  },
  {
    from: 'CALLED',
    on: 'CANCEL',
    to: 'CANCELLED',
    guard: null,
    by: 'CANCEL',
    ticketId: 'k1',
    tableId: null,
    step: () =>
      byCommand(called(), { type: 'CANCEL', ticketId: 'k1', by: 'user', reason: 'found_seat' }, at(2)),
  },
  {
    from: 'CALLED',
    on: 'VENUE_RELEASE',
    to: 'CANCELLED',
    guard: null,
    by: 'RELEASE_ALL（全席解放）',
    ticketId: 'k1',
    tableId: null,
    step: () => byCommand(called(), { type: 'RELEASE_ALL', by: 'staff' }, at(2)),
  },
  {
    from: 'SEATED',
    on: 'CHECK_OUT',
    to: 'DONE',
    guard: null,
    by: 'CHECK_OUT（退席）',
    ticketId: 'k1',
    tableId: null,
    step: () => byCommand(seated(), { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(10)),
  },
  {
    from: 'SEATED',
    on: 'AUTO_RELEASE',
    to: 'DONE',
    guard: 'hardLimitMode',
    by: 'tick（着席時間の上限と猶予。hard モード）',
    ticketId: 'k1',
    tableId: null,
    step: () => {
      const hard: Policy = {
        ...UNCERTAIN_POLICY,
        timeLimitMode: 'hard',
        limitOnlyWhenWaiting: false,
      };
      // 上限 60 分 ＋ 猶予 15 分。着席は 2 分。
      return byClock(seated(hard), at(78));
    },
  },
  {
    from: 'SEATED',
    on: 'SEAT_RECLAIMED',
    to: 'DONE',
    guard: null,
    by: 'CONFIRM_FREE（確認要の席が空だと確かめられた）',
    ticketId: 'k1',
    tableId: null,
    step: () => byCommand(uncertain(), { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'staff' }, at(80)),
  },
  {
    from: 'SEATED',
    on: 'STILL_HERE',
    to: 'SEATED',
    guard: null,
    by: 'STILL_HERE（「まだ利用中」）',
    ticketId: 'k1',
    tableId: null,
    step: () => byCommand(seated(), { type: 'STILL_HERE', ticketId: 'k1' }, at(10)),
  },
  {
    from: 'SEATED',
    on: 'VENUE_RELEASE',
    to: 'DONE',
    guard: null,
    by: 'RELEASE_ALL（全席解放）',
    ticketId: 'k1',
    tableId: null,
    step: () => byCommand(seated(), { type: 'RELEASE_ALL', by: 'staff' }, at(10)),
  },
];

// ---------------------------------------------------------------------------

function keyOf(row: {
  readonly from: string;
  readonly on: string;
  readonly to: string;
  readonly guard: string | null;
}): string {
  return `${row.from} --${row.on}[${row.guard ?? '-'}]--> ${row.to}`;
}

describe('チケットの遷移表が、全行とも実際に通る', () => {
  it('宣言されている行と、証拠の行が 1 対 1 に対応する', () => {
    const declared = TICKET_TRANSITIONS.map(keyOf).sort();
    const witnessed = TICKET_WITNESSES.map(keyOf).sort();
    expect(witnessed).toEqual(declared);
  });

  it.each(TICKET_WITNESSES)('$from --$on--> $to は $by で起きる', (witness) => {
    const { before, after } = witness.step();
    expect(ticketOf(before, witness.ticketId).state).toBe(witness.from);
    expect(ticketOf(after, witness.ticketId).state).toBe(witness.to);
  });

  it.each(TICKET_WITNESSES)('$from --$on--> $to は、まさにその行が採られる', (witness) => {
    const { before, now } = witness.step();
    const row: TicketTransition | null = ticketTransitionRow(
      {
        state: before,
        ticket: ticketOf(before, witness.ticketId),
        now,
        table: witness.tableId === null ? null : tableOf(before, witness.tableId),
      },
      witness.on,
    );
    expect(row === null ? '採られる行が無い' : keyOf(row)).toBe(keyOf(witness));
  });
});

// ---- 席の証拠 ----

interface TableWitness {
  readonly from: TableStatus;
  readonly on: TableEvent;
  readonly to: TableStatus;
  readonly guard: TableGuard | null;
  readonly by: string;
  readonly tableId: string;
  readonly step: () => Step;
}

/** 片付けの猶予を持たせた設定。既定の 0 分だと `TURNOVER` が一瞬で終わる。 */
const TURNOVER_POLICY: Policy = { ...DEFAULT_POLICY, turnoverMin: 5 };

/** 誰かが使っているが、誰かは分からない席。 */
function unknownOccupancy(policy: Policy = DEFAULT_POLICY): VenueState {
  const state = opened([tbl('tb-4', 4)], policy);
  return run(state, { type: 'REPORT_IN_USE', tableId: 'tb-4', ticketId: null }, at(1));
}

/** 誰の記録も無い「確認要」の席。無断利用が時間で落ちてきた形。 */
function uncertainUnknown(): VenueState {
  // unknown_occupancy_to_check_min の既定は 40 分。自動解放はその 30 分後。
  const state = advance(unknownOccupancy(), at(42));
  expect(tableOf(state, 'tb-4').status).toBe('NEEDS_CHECK');
  return state;
}

/** 片付け中の席。 */
function inTurnover(): VenueState {
  const state = run(
    seated(TURNOVER_POLICY),
    { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' },
    at(10),
  );
  expect(tableOf(state, 'tb-4').status).toBe('TURNOVER');
  return state;
}

const TABLE_WITNESSES: readonly TableWitness[] = [
  {
    from: 'DISABLED',
    on: 'OPEN',
    to: 'FREE',
    guard: null,
    by: 'OPEN（運用開始）',
    tableId: 'tb-4',
    step: () => {
      const closed = createVenueState({ venueId: 'v1', policy: DEFAULT_POLICY, tables: [tbl('tb-4', 4)] });
      return byCommand(closed, { type: 'OPEN', closesAt: null, by: 'staff' }, NOW);
    },
  },
  {
    from: 'FREE',
    on: 'HOLD',
    to: 'HELD',
    guard: null,
    by: '割当（呼び出した人のために確保する）',
    tableId: 'tb-4',
    step: () =>
      byCommand(
        opened([tbl('tb-4', 4)]),
        { type: 'JOIN', ticketId: 'k1', partySize: 3, requiredTags: [], hasNotificationChannel: true },
        at(1),
      ),
  },
  {
    from: 'FREE',
    on: 'WALK_IN',
    to: 'OCCUPIED',
    guard: null,
    by: 'WALK_IN（飛び込み着席）',
    tableId: 'tb-4',
    step: () =>
      byCommand(
        opened([tbl('tb-4', 4)]),
        { type: 'WALK_IN', ticketId: 'w1', tableId: 'tb-4', partySize: 2 },
        at(1),
      ),
  },
  {
    from: 'FREE',
    on: 'REPORT_IN_USE',
    to: 'OCCUPIED_UNKNOWN',
    guard: null,
    by: 'REPORT_IN_USE（第三者やスタッフの「使用中」報告）',
    tableId: 'tb-4',
    step: () =>
      byCommand(opened([tbl('tb-4', 4)]), { type: 'REPORT_IN_USE', tableId: 'tb-4', ticketId: null }, at(1)),
  },
  {
    from: 'FREE',
    on: 'CLOSE',
    to: 'DISABLED',
    guard: null,
    by: 'CLOSE（運用終了）',
    tableId: 'tb-4',
    step: () => byCommand(opened([tbl('tb-4', 4)]), { type: 'CLOSE', by: 'staff' }, at(1)),
  },
  {
    from: 'FREE',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    by: 'RELEASE_ALL（全席解放）',
    tableId: 'tb-4',
    step: () => byCommand(opened([tbl('tb-4', 4)]), { type: 'RELEASE_ALL', by: 'staff' }, at(1)),
  },
  {
    from: 'HELD',
    on: 'CHECK_IN',
    to: 'OCCUPIED',
    guard: null,
    by: 'CHECK_IN（呼ばれた人が着席した）',
    tableId: 'tb-4',
    step: () => byCommand(called(), { type: 'CHECK_IN', ticketId: 'k1', tableId: 'tb-4' }, at(2)),
  },
  {
    from: 'HELD',
    on: 'RELEASE',
    to: 'FREE',
    guard: null,
    by: 'PASS（次の人に譲る。確保を解く）',
    tableId: 'tb-4',
    step: () => byCommand(called(), { type: 'PASS', ticketId: 'k1' }, at(2)),
  },
  {
    from: 'HELD',
    on: 'REPORT_TAKEN',
    to: 'OCCUPIED_UNKNOWN',
    guard: null,
    by: 'REPORT_TAKEN（案内された席に誰かが座っていた）',
    tableId: 'tb-4',
    step: () => byCommand(called(), { type: 'REPORT_TAKEN', ticketId: 'k1', tableId: 'tb-4' }, at(2)),
  },
  {
    from: 'HELD',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    by: 'RELEASE_ALL（全席解放）',
    tableId: 'tb-4',
    step: () => byCommand(called(), { type: 'RELEASE_ALL', by: 'staff' }, at(2)),
  },
  {
    from: 'OCCUPIED',
    on: 'CHECK_OUT',
    to: 'TURNOVER',
    guard: null,
    by: 'CHECK_OUT（退席。片付けの猶予に入る）',
    tableId: 'tb-4',
    step: () =>
      byCommand(seated(TURNOVER_POLICY), { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(10)),
  },
  {
    from: 'OCCUPIED',
    on: 'OVERSTAY',
    to: 'NEEDS_CHECK',
    guard: null,
    by: 'tick（着席時間の上限と猶予）',
    tableId: 'tb-4',
    step: () => byClock(waiting(UNCERTAIN_POLICY), at(78)),
  },
  {
    from: 'OCCUPIED',
    on: 'STILL_HERE_TIMEOUT',
    to: 'NEEDS_CHECK',
    guard: null,
    by: 'tick（「まだご利用中ですか」への無応答）',
    tableId: 'tb-4',
    step: () => {
      // 上限は切っておく。問いかけ（50 分）＋無応答（5 分）だけで落とす。
      const asking: Policy = { ...DEFAULT_POLICY, timeLimitMode: 'off', ticketMaxAgeMin: 600 };
      return byClock(seated(asking), at(58));
    },
  },
  {
    from: 'OCCUPIED',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    by: 'RELEASE_ALL（全席解放）',
    tableId: 'tb-4',
    step: () => byCommand(seated(), { type: 'RELEASE_ALL', by: 'staff' }, at(10)),
  },
  {
    from: 'OCCUPIED_UNKNOWN',
    on: 'UNKNOWN_AGED',
    to: 'NEEDS_CHECK',
    guard: null,
    by: 'tick（無断利用の想定滞在時間）',
    tableId: 'tb-4',
    step: () => byClock(unknownOccupancy(), at(42)),
  },
  {
    from: 'OCCUPIED_UNKNOWN',
    on: 'CONFIRM_FREE',
    to: 'FREE',
    guard: null,
    by: 'CONFIRM_FREE（空席だと確かめた）',
    tableId: 'tb-4',
    step: () =>
      byCommand(unknownOccupancy(), { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'staff' }, at(10)),
  },
  {
    from: 'OCCUPIED_UNKNOWN',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    by: 'RELEASE_ALL（全席解放）',
    tableId: 'tb-4',
    step: () => byCommand(unknownOccupancy(), { type: 'RELEASE_ALL', by: 'staff' }, at(10)),
  },
  {
    from: 'TURNOVER',
    on: 'TURNOVER_DONE',
    to: 'FREE',
    guard: 'stillManaged',
    by: 'tick（片付けの猶予が明けた）',
    tableId: 'tb-4',
    step: () => byClock(inTurnover(), at(16)),
  },
  {
    from: 'TURNOVER',
    on: 'TURNOVER_DONE',
    to: 'DISABLED',
    guard: 'disableAfterCurrent',
    by: 'tick（猶予が明け、対象外の予約が実行された）',
    tableId: 'tb-4',
    step: () => {
      const reserved = run(inTurnover(), { type: 'DISABLE_TABLE', tableId: 'tb-4', by: 'staff' }, at(11));
      return byClock(reserved, at(16));
    },
  },
  {
    from: 'TURNOVER',
    on: 'CLOSE',
    to: 'DISABLED',
    guard: null,
    by: 'CLOSE（運用終了。片付け中の席もすぐ外れる）',
    tableId: 'tb-4',
    step: () => byCommand(inTurnover(), { type: 'CLOSE', by: 'staff' }, at(11)),
  },
  {
    from: 'TURNOVER',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    by: 'RELEASE_ALL（全席解放）',
    tableId: 'tb-4',
    step: () => byCommand(inTurnover(), { type: 'RELEASE_ALL', by: 'staff' }, at(11)),
  },
  {
    from: 'NEEDS_CHECK',
    on: 'CONFIRM_FREE',
    to: 'FREE',
    guard: null,
    by: 'CONFIRM_FREE（空席だと確かめた）',
    tableId: 'tb-4',
    step: () =>
      byCommand(uncertainUnknown(), { type: 'CONFIRM_FREE', tableId: 'tb-4', by: 'staff' }, at(43)),
  },
  {
    from: 'NEEDS_CHECK',
    on: 'AUTO_FREE',
    to: 'FREE',
    guard: 'autoFreeEnabled',
    by: 'tick（確認要のまま放置された席の自動解放）',
    tableId: 'tb-4',
    step: () => byClock(uncertainUnknown(), at(75)),
  },
  {
    from: 'NEEDS_CHECK',
    on: 'STILL_HERE',
    to: 'OCCUPIED',
    guard: null,
    by: 'STILL_HERE（本人が「まだ利用中」と答えた）',
    tableId: 'tb-4',
    step: () => byCommand(uncertain(), { type: 'STILL_HERE', ticketId: 'k1' }, at(80)),
  },
  {
    from: 'NEEDS_CHECK',
    on: 'CHECK_OUT',
    to: 'TURNOVER',
    guard: null,
    by: 'CHECK_OUT（確認要に落ちた席でも退席できる）',
    tableId: 'tb-4',
    step: () => {
      const slow: Policy = { ...UNCERTAIN_POLICY, turnoverMin: 5 };
      const state = advance(waiting(slow), at(78));
      expect(tableOf(state, 'tb-4').status).toBe('NEEDS_CHECK');
      return byCommand(state, { type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, at(80));
    },
  },
  {
    from: 'NEEDS_CHECK',
    on: 'REPORT_IN_USE',
    to: 'OCCUPIED_UNKNOWN',
    guard: 'seatIsUnoccupied',
    by: 'REPORT_IN_USE（誰の記録も無い席が使われていた）',
    tableId: 'tb-4',
    step: () =>
      byCommand(uncertainUnknown(), { type: 'REPORT_IN_USE', tableId: 'tb-4', ticketId: null }, at(43)),
  },
  {
    from: 'NEEDS_CHECK',
    on: 'REPORT_IN_USE',
    to: 'OCCUPIED',
    guard: 'seatHasOccupant',
    by: 'REPORT_IN_USE（着席の記録が残っている席が使われていた）',
    tableId: 'tb-4',
    step: () =>
      byCommand(uncertain(), { type: 'REPORT_IN_USE', tableId: 'tb-4', ticketId: 'k2' }, at(80)),
  },
  {
    from: 'NEEDS_CHECK',
    on: 'CHECK_IN_EARLY',
    to: 'OCCUPIED',
    guard: null,
    by: 'CHECK_IN_EARLY（案内された人が、空いていたので座った）',
    tableId: 'tb-4',
    step: () =>
      byCommand(uncertain(), { type: 'CHECK_IN_EARLY', ticketId: 'k2', tableId: 'tb-4' }, at(80)),
  },
  {
    from: 'NEEDS_CHECK',
    on: 'CLOSE',
    to: 'DISABLED',
    guard: null,
    by: 'CLOSE（運用終了）',
    tableId: 'tb-4',
    step: () => byCommand(uncertainUnknown(), { type: 'CLOSE', by: 'staff' }, at(43)),
  },
  {
    from: 'NEEDS_CHECK',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    by: 'RELEASE_ALL（全席解放）',
    tableId: 'tb-4',
    step: () => byCommand(uncertainUnknown(), { type: 'RELEASE_ALL', by: 'staff' }, at(43)),
  },
];

/**
 * 宣言はあるが、**この版では通らない行**。
 *
 * 到達しない行を黙って残すと表が腐るので、**理由を書いて数え上げる**。
 * ここに無い行が到達しなくなったら、対応の検査が落ちる。
 */
interface Unreachable {
  readonly from: TableStatus;
  readonly on: TableEvent;
  readonly to: TableStatus;
  readonly guard: TableGuard | null;
  readonly why: string;
}

const TABLE_UNREACHABLE: readonly Unreachable[] = [
  {
    from: 'FREE',
    on: 'CHECK_IN_EARLY',
    to: 'OCCUPIED',
    guard: null,
    why:
      '**割当が出口で必ず走るので、「収まる空席」と「待っている人」は同時に存在しない**' +
      '（不変条件 `no_starvation`）。7.8 の 4 行目が想定する「空席の QR を読んだ待ち人」は、' +
      'その瞬間にはもう呼ばれていて `CHECK_IN` を使う。前倒しの着席が実際に要るのは' +
      '「確認要」の席のほう（7.11 の 3 層目）で、そちらは別の行として通っている。',
  },
];

describe('席の遷移表が、全行とも実際に通る', () => {
  it('宣言されている行が、証拠か「通らない理由」のどちらかを持つ', () => {
    const declared = TABLE_TRANSITIONS.map(keyOf).sort();
    const accounted = [...TABLE_WITNESSES.map(keyOf), ...TABLE_UNREACHABLE.map(keyOf)].sort();
    expect(accounted).toEqual(declared);
  });

  it('通らない行は 1 本だけで、理由が書かれている', () => {
    expect(TABLE_UNREACHABLE.map(keyOf)).toEqual(['FREE --CHECK_IN_EARLY[-]--> OCCUPIED']);
    expect(TABLE_UNREACHABLE.every((row) => row.why.length > 0)).toBe(true);
  });

  it.each(TABLE_WITNESSES)('$from --$on--> $to は $by で起きる', (witness) => {
    const { before, after } = witness.step();
    expect(tableOf(before, witness.tableId).status).toBe(witness.from);
    expect(tableOf(after, witness.tableId).status).toBe(witness.to);
  });

  it.each(TABLE_WITNESSES)('$from --$on--> $to は、まさにその行が採られる', (witness) => {
    const { before, now } = witness.step();
    const row: TableTransition | null = tableTransitionRow(
      { state: before, table: tableOf(before, witness.tableId), now },
      witness.on,
    );
    expect(row === null ? '採られる行が無い' : keyOf(row)).toBe(keyOf(witness));
  });
});

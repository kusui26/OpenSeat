import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '../domain/policy.js';
import { createTable, type Table } from '../domain/table.js';
import { createTicket, type Ticket } from '../domain/ticket.js';
import { createVenueState, type VenueState } from '../domain/state.js';
import { minutes, type Timestamp } from '../time.js';
import { apply } from '../machine/apply.js';
import type { Command, CommandType } from '../machine/command.js';
import { tick } from '../machine/tick.js';
import { resolveTableScan, type TableScanKind, type TableScanOutcome } from './resolve.js';

/**
 * **画面に出した操作は、必ず通る。**
 *
 * これが座席 QR の中心的な約束である。「押せます」と見せたものが拒否されたら、
 * 利用者は席の前で立ち往生する。PR 9 は画面とコマンドに同じガードを見せることで
 * 食い違いを防いだが、**ガードの外側にある拒否**（前提条件、遷移表、不変条件）は
 * それでは防げない。実際 PR 10 では、確認要に落ちた席に着席の記録が残っている
 * とき、画面が出した「空いています」が `INVARIANT_VIOLATED` で拒否された。
 *
 * ここでは、ランダムに動かした状態のすべての（席、人）の組について、画面が
 * 出した操作をそのまま `apply` に渡し、**1 つも拒否されない**ことを確かめる。
 */

const NOW: Timestamp = 1_700_000_000_000;
const TICKET_IDS: readonly string[] = ['k1', 'k2', 'k3'];
/** 出発点から席に着いている人。待ち行列のコマンドが使う ID とは分けてある。 */
const OCCUPANT_ID = 'k0';
const TABLE_IDS: readonly string[] = ['tb0', 'tb1', 'tb2'];
const RUNS = { numRuns: 200 };

// ---- 生成器 ----

const policyArb: fc.Arbitrary<Policy> = fc
  .record({
    holdMin: fc.integer({ min: 2, max: 8 }),
    turnoverMin: fc.integer({ min: 0, max: 3 }),
    timeLimitMin: fc.integer({ min: 5, max: 40 }),
    overstayGraceMin: fc.integer({ min: 0, max: 10 }),
    stillHerePromptMin: fc.integer({ min: 5, max: 40 }),
    stillHereTimeoutMin: fc.integer({ min: 1, max: 10 }),
    unknownOccupancyToCheckMin: fc.integer({ min: 5, max: 40 }),
    needsCheckAutoFreeMin: fc.oneof(fc.integer({ min: 5, max: 60 }), fc.constant(null)),
    assignNeedsCheck: fc.boolean(),
    ticketMaxAgeMin: fc.integer({ min: 30, max: 240 }),
  })
  .map((chosen) => ({
    ...DEFAULT_POLICY,
    ...chosen,
    holdReminderBeforeMin: Math.min(1, chosen.holdMin - 1),
  }));

const stateArb: fc.Arbitrary<VenueState> = fc
  .record({
    capacities: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 3 }),
    policy: policyArb,
    uncertain: fc.boolean(),
  })
  .map(({ capacities, policy, uncertain }) => {
    const opened: VenueState = {
      ...createVenueState({
        venueId: 'v1',
        policy,
        tables: capacities.map((capacity, index) => table(`tb${index}`, capacity)),
      }),
      operating: true,
      joinOpen: true,
    };
    return uncertain ? withUncertainSeat(opened) : opened;
  });

function table(id: string, capacity: number): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE' };
}

/**
 * **着席の記録が残ったまま「確認要」に落ちた席**を最初から持たせる（7.11 の 2 層目）。
 *
 * 問いかけへの無応答でこの形になるが、**ランダムなコマンドではめったに作れない。**
 * 呼び出し・着席・時間の経過がすべて噛み合う必要があるためで、実測では 200 回
 * まわして 1 度も出なかった。ここが空だと、7.11 の 3 層目の画面（いちばん判断が
 * 込み入っているところ）が 1 度も試されない。出発点に置いて確実に踏ませる。
 */
function withUncertainSeat(state: VenueState): VenueState {
  const first: Table | undefined = state.tables[0];
  if (first === undefined) return state;

  const occupant: Ticket = {
    ...createTicket({ id: OCCUPANT_ID, code: 'Z-01', partySize: 1, now: NOW }),
    state: 'SEATED',
    tableId: first.id,
    seatedAt: NOW,
  };
  return {
    ...state,
    tables: [
      { ...first, status: 'NEEDS_CHECK', statusSince: NOW, occupantTicketId: occupant.id },
      ...state.tables.slice(1),
    ],
    tickets: [occupant],
  };
}

const ticketIdArb: fc.Arbitrary<string> = fc.constantFrom(...TICKET_IDS);
const tableIdArb: fc.Arbitrary<string> = fc.constantFrom(...TABLE_IDS);

/**
 * 状態をいろいろな形へ動かすためのコマンド。
 *
 * **画面が出す操作をここで作らない。** 画面が出したものを試すのがこの検査の
 * 目的なので、前提を作る側と確かめる側を混ぜない。
 */
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ ticketId: ticketIdArb, partySize: fc.integer({ min: 1, max: 4 }) }).map(
    ({ ticketId, partySize }): Command => ({
      type: 'JOIN',
      ticketId,
      partySize,
      requiredTags: [],
      hasNotificationChannel: true,
    }),
  ),
  fc.record({ ticketId: ticketIdArb, tableId: tableIdArb }).map(
    ({ ticketId, tableId }): Command => ({ type: 'CHECK_IN', ticketId, tableId }),
  ),
  ticketIdArb.map((ticketId): Command => ({ type: 'CHECK_OUT', ticketId, by: 'user' })),
  ticketIdArb.map((ticketId): Command => ({ type: 'PAUSE', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'READY', ticketId })),
  ticketIdArb.map((ticketId): Command => ({ type: 'STILL_HERE', ticketId })),
  fc.record({ ticketId: ticketIdArb, tableId: tableIdArb }).map(
    ({ ticketId, tableId }): Command => ({ type: 'REPORT_TAKEN', ticketId, tableId }),
  ),
  tableIdArb.map((tableId): Command => ({ type: 'REPORT_IN_USE', tableId, ticketId: null })),
);

const scenarioArb = fc.record({
  state: stateArb,
  commands: fc.array(commandArb, { minLength: 1, maxLength: 20 }),
  stepMin: fc.integer({ min: 1, max: 15 }),
});

// ---- 実行 ----

/** ランダムなコマンドと時間の経過で、状態をあちこちへ動かす。 */
function play(initial: VenueState, commands: readonly Command[], stepMin: number): VenueState {
  let state: VenueState = initial;
  let now: Timestamp = NOW;

  for (const command of commands) {
    now += minutes(stepMin);
    const applied = apply(state, command, now);
    if (applied.ok) state = applied.value.state;
    const ticked = tick(state, now);
    if (ticked.ok) state = ticked.value.state;
  }
  return state;
}

/**
 * 画面が出した操作を、そのまま渡せるコマンドにする。
 *
 * 引数は画面が組み立てる約束なので（`TableScanOutcome.actions`）、ここが
 * その画面の代わりをする。**コマンドの種別を鍵にした総当たりの表**にしてあり、
 * 種別を足したらここも埋めなければ型が通らない。画面が出しうる操作を
 * 組み立て損ねて、検査がすり抜けることが起こらない。
 *
 * `null` は「座席 QR の画面には出ない操作」。出てきたら検査が落ちる。
 */
type CommandBuilder = (tableId: string, ticketId: string | null) => Command | null;

const COMMAND_BUILDERS: Readonly<Record<CommandType, CommandBuilder>> = {
  // 座席 QR から出るもの。
  CHECK_IN: (tableId, ticketId) =>
    ticketId === null ? null : { type: 'CHECK_IN', ticketId, tableId },
  CHECK_IN_EARLY: (tableId, ticketId) =>
    ticketId === null ? null : { type: 'CHECK_IN_EARLY', ticketId, tableId },
  CHECK_OUT: (_tableId, ticketId) =>
    ticketId === null ? null : { type: 'CHECK_OUT', ticketId, by: 'user' },
  READY: (_tableId, ticketId) => (ticketId === null ? null : { type: 'READY', ticketId }),
  SWAP_TABLE: (tableId, ticketId) =>
    ticketId === null ? null : { type: 'SWAP_TABLE', ticketId, tableId },
  REPORT_TAKEN: (tableId, ticketId) =>
    ticketId === null ? null : { type: 'REPORT_TAKEN', ticketId, tableId },
  REPORT_IN_USE: (tableId, ticketId) => ({ type: 'REPORT_IN_USE', tableId, ticketId }),
  CONFIRM_FREE: (tableId) => ({ type: 'CONFIRM_FREE', tableId, by: 'user' }),
  // 飛び込み着席だけは新しいチケットを作る。読み取った人のチケット（終わって
  // いるはず）とは別の ID を渡す。
  WALK_IN: (tableId) => ({ type: 'WALK_IN', ticketId: 'walkin', tableId, partySize: 1 }),

  // 座席 QR の画面には出ないもの。施設の開閉と席の設定はスタッフ・管理者の操作で、
  // 座席 QR からは触れない（7.8 の表に無い）。
  JOIN: () => null,
  CANCEL: () => null,
  PAUSE: () => null,
  EXTEND: () => null,
  PASS: () => null,
  STILL_HERE: () => null,
  CHANGE_PARTY_SIZE: () => null,
  HEARTBEAT: () => null,
  OPEN: () => null,
  CLOSE: () => null,
  RELEASE_ALL: () => null,
  DISABLE_TABLE: () => null,
  ENABLE_TABLE: () => null,
};

function commandFor(action: CommandType, tableId: string, ticketId: string | null): Command | null {
  return COMMAND_BUILDERS[action](tableId, ticketId);
}

/** すべての（席、人）の組について、画面が出した操作を 1 つずつ試す。 */
function rejectionsOf(state: VenueState): readonly string[] {
  const readers: readonly (string | null)[] = [null, ...state.tickets.map((ticket) => ticket.id)];
  const problems: string[] = [];
  const now: Timestamp = NOW + minutes(1000);

  for (const tableItem of state.tables) {
    for (const reader of readers) {
      const seen: TableScanOutcome | null = resolveTableScan(state, tableItem.id, reader);
      if (seen === null) continue;
      // 終わったチケットを持つ人は、持たない人として扱う（7.7 の 8）。
      const actor: string | null = seen.staleTicket ? null : reader;
      for (const action of seen.actions) {
        const command = commandFor(action, tableItem.id, actor);
        if (command === null) {
          problems.push(`${seen.kind}/${action}: コマンドに組み立てられない`);
          continue;
        }
        const applied = apply(state, command, now);
        if (!applied.ok) problems.push(`${seen.kind}/${action}: ${applied.error.code}`);
      }
    }
  }
  return problems;
}

// ---- 性質 ----

describe('画面に出した操作は必ず通る（7.8、7.11）', () => {
  it('どんな状態でも、出した操作が拒否されない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands, stepMin }) => {
        expect(rejectionsOf(play(state, commands, stepMin))).toEqual([]);
      }),
      RUNS,
    );
  });

  /**
   * **操作を 1 つも出さない画面ばかりでは、上の性質は空回りする。**
   * どんな画面が、どれだけ試されているかを数えておく。
   *
   * **ここだけ種を固定してある。** 上の性質は「どんな状態でも」を見るので
   * 種を振るのが正しいが、こちらは生成器そのものの点検なので、結果が走らせる
   * たびに変わっては点検にならない。
   */
  it('その検査は、7.8 と 7.11 の主な画面をひととおり通る', () => {
    const seen = new Set<TableScanKind>();
    let tried = 0;

    fc.assert(
      fc.property(scenarioArb, ({ state, commands, stepMin }) => {
        const played = play(state, commands, stepMin);
        for (const tableItem of played.tables) {
          for (const reader of [null, ...played.tickets.map((ticket) => ticket.id)]) {
            const outcome = resolveTableScan(played, tableItem.id, reader);
            if (outcome === null || outcome.actions.length === 0) continue;
            seen.add(outcome.kind);
            tried += outcome.actions.length;
          }
        }
      }),
      { ...RUNS, seed: 20260919 },
    );

    expect(tried).toBeGreaterThan(300);
    for (const kind of ['check_in', 'walk_in_offer', 'in_use', 'seated_here', 'needs_check'] as const) {
      expect([...seen]).toContain(kind);
    }
  });
});

/**
 * **空席の QR を読んだ人には、いつでも「この席を使う」を出せる。**
 *
 * 7.8 の 7 行目（空席だが待ちがいるので受付へ誘導）は、`apply` と `tick` を
 * 通った状態では起こらない。そこでの「待ちがいる」は **「その席に収まる待ちが
 * いる」** と読むところ、割当がコマンドのたびに必ず走るので、**収まる人が
 * 待っている空席が残らない**ためである（不変条件 `no_starvation`）。
 *
 * PR 12 が 7.8 の 4 行目（空席への前倒し着席）について置いた性質と対になる。
 * どちらも「宣言は残し、到達しないことを性質で見張る」という同じ扱いである。
 * 割当の走らせ方を変えて 7 行目が生き返れば、ここが落ちて気づける。
 */
describe('空席の QR には、いつでも飛び込み着席を出せる（7.8 の 6・7 行目）', () => {
  it('どんな状態でも、空席を読んだチケットなしの人が受付へ回されない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands, stepMin }) => {
        const played = play(state, commands, stepMin);
        for (const seat of played.tables.filter((item) => item.status === 'FREE')) {
          expect(resolveTableScan(played, seat.id, null)).toMatchObject({
            kind: 'walk_in_offer',
            actions: ['WALK_IN'],
          });
        }
      }),
      RUNS,
    );
  });

  /**
   * **空席が 1 つも出ない筋書きばかりでは、上の性質は空回りする。**
   * 何席ぶん確かめているかを数えておく。**ここだけ種を固定してある**のは、
   * 生成器そのものの点検だからである（上の性質は種を振る）。
   */
  it('その検査は、空回りしていない', () => {
    let seats = 0;

    fc.assert(
      fc.property(scenarioArb, ({ state, commands, stepMin }) => {
        seats += play(state, commands, stepMin).tables.filter(
          (item) => item.status === 'FREE',
        ).length;
      }),
      { ...RUNS, seed: 20260921 },
    );

    expect(seats).toBeGreaterThan(100);
  });
});

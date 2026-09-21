import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from './domain/policy.js';
import { createTable, type Table } from './domain/table.js';
import { comparePriority, type Ticket } from './domain/ticket.js';
import { createVenueState, type VenueState } from './domain/state.js';
import { minutes, type Timestamp } from './time.js';
import { apply } from './machine/apply.js';
import type { Command } from './machine/command.js';
import { tick } from './machine/tick.js';
import { estimateForJoin, estimateForTicket, type WaitEstimate } from './eta.js';

/**
 * 待ち時間の推定が、決して破らないこと（全体プラン 7.13）。
 *
 * 手で書いたテール（`eta.test.ts`）は式の各項を確かめるもので、こちらは
 * **並び方の約束**を見る。目安は時間とともに短くなり、後ろに並ぶ人ほど長く、
 * 幅は必ず目安を含む。どれも利用者が画面を見ていて気づく性質である。
 */

const NOW: Timestamp = 1_700_000_000_000;
const TICKET_IDS: readonly string[] = ['k1', 'k2', 'k3', 'k4'];
const TABLE_IDS: readonly string[] = ['tb0', 'tb1', 'tb2'];
const RUNS = { numRuns: 200 };

const policyArb: fc.Arbitrary<Policy> = fc
  .record({
    assumedStayMin: fc.integer({ min: 5, max: 60 }),
    etaBucketMin: fc.integer({ min: 1, max: 15 }),
    holdMin: fc.integer({ min: 2, max: 10 }),
    turnoverMin: fc.integer({ min: 0, max: 5 }),
    unknownOccupancyToCheckMin: fc.integer({ min: 5, max: 60 }),
    needsCheckAutoFreeMin: fc.oneof(fc.integer({ min: 5, max: 60 }), fc.constant(null)),
    stillHerePromptMin: fc.integer({ min: 5, max: 40 }),
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
    /**
     * 席が最初から埋まっているか。
     *
     * **これが無いと、待っている人がほとんど出ない。** 空席のある施設では受付が
     * そのまま呼び出しになるので、列に並ぶ人が生まれない（実測で 200 回まわして
     * 38 人）。「後から並んだ人ほど目安が長い」を確かめるには列が要る。
     */
    crowded: fc.boolean(),
  })
  .map(({ capacities, policy, crowded }) => {
    const seats: readonly Table[] = capacities.map((capacity, index) =>
      table(`tb${index}`, capacity),
    );
    return {
      ...createVenueState({
        venueId: 'v1',
        policy,
        tables: crowded ? seats.map(occupiedByStranger) : seats,
      }),
      operating: true,
      joinOpen: true,
    };
  });

/** 登録せずに使われている席。誰の記録も持たないので、チケットと矛盾しない。 */
function occupiedByStranger(seat: Table): Table {
  return { ...seat, status: 'OCCUPIED_UNKNOWN', statusSince: NOW };
}

function table(id: string, capacity: number): Table {
  return { ...createTable({ id, label: id, capacity, now: NOW }), status: 'FREE' };
}

const ticketIdArb: fc.Arbitrary<string> = fc.constantFrom(...TICKET_IDS);
const tableIdArb: fc.Arbitrary<string> = fc.constantFrom(...TABLE_IDS);

const joinArb: fc.Arbitrary<Command> = fc
  .record({ ticketId: ticketIdArb, partySize: fc.integer({ min: 1, max: 4 }) })
  .map(
    ({ ticketId, partySize }): Command => ({
      type: 'JOIN',
      ticketId,
      partySize,
      requiredTags: [],
      hasNotificationChannel: true,
    }),
  );

/**
 * 状態をいろいろな形へ動かすためのコマンド。
 *
 * **受付を厚くしてある。** ここで確かめたいのは列の並び方なので、列が立たないと
 * 何も試せない。ほかのコマンドは席の状態を散らすために混ぜている。
 */
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  { arbitrary: joinArb, weight: 4 },
  {
    arbitrary: fc
      .record({ ticketId: ticketIdArb, tableId: tableIdArb })
      .map(({ ticketId, tableId }): Command => ({ type: 'CHECK_IN', ticketId, tableId })),
    weight: 1,
  },
  {
    arbitrary: ticketIdArb.map((ticketId): Command => ({ type: 'CHECK_OUT', ticketId, by: 'user' })),
    weight: 1,
  },
  { arbitrary: ticketIdArb.map((ticketId): Command => ({ type: 'PAUSE', ticketId })), weight: 1 },
  { arbitrary: ticketIdArb.map((ticketId): Command => ({ type: 'READY', ticketId })), weight: 1 },
  {
    arbitrary: tableIdArb.map((tableId): Command => ({ type: 'REPORT_IN_USE', tableId, ticketId: null })),
    weight: 2,
  },
);

const scenarioArb = fc.record({
  state: stateArb,
  commands: fc.array(commandArb, { minLength: 1, maxLength: 15 }),
  stepMin: fc.integer({ min: 1, max: 12 }),
  /** 目安を求める組の人数。 */
  partySize: fc.integer({ min: 1, max: 4 }),
  /** 目安を求め直すまでに進める時間。 */
  laterMin: fc.integer({ min: 1, max: 90 }),
});

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

/** 筋書きを流し終えた時刻。 */
function endOf(commands: readonly Command[], stepMin: number): Timestamp {
  return NOW + minutes(commands.length * stepMin);
}

function joinEstimate(state: VenueState, partySize: number, now: Timestamp): WaitEstimate {
  return estimateForJoin(state, { partySize, requiredTags: [] }, now);
}

// ---------------------------------------------------------------------------

describe('待ち時間の目安が守ること（7.13）', () => {
  /**
   * **状態が変わらないまま時間が進むと、目安は短くなるか変わらない。**
   *
   * 画面のカウントダウンがこれを前提にしている。増えると「待たされている」
   * 感覚が強くなるので、利用者にいちばん効く性質である。
   */
  it('時間が進むだけなら、目安は増えない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands, stepMin, partySize, laterMin }) => {
        const built = play(state, commands, stepMin);
        const now: Timestamp = endOf(commands, stepMin);
        const before = joinEstimate(built, partySize, now);
        const after = joinEstimate(built, partySize, now + minutes(laterMin));
        if (before.kind !== 'estimate' || after.kind !== 'estimate') return true;
        return after.minutes <= before.minutes;
      }),
      RUNS,
    );
  });

  /** 幅は必ず目安を含み、刻みの倍数から 1 刻みぶんである（7.16 の `eta_display`）。 */
  it('目安は必ず幅の中に入る', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands, stepMin, partySize }) => {
        const built = play(state, commands, stepMin);
        const seen = joinEstimate(built, partySize, endOf(commands, stepMin));
        if (seen.kind !== 'estimate') return true;
        const bucket: number = built.policy.etaBucketMin;
        return (
          seen.fromMin <= seen.minutes &&
          seen.minutes <= seen.toMin &&
          seen.fromMin % bucket === 0 &&
          seen.toMin - seen.fromMin === bucket
        );
      }),
      RUNS,
    );
  });

  /**
   * **後から並んだ人の目安は、先に並んだ人より短くならない。**
   *
   * 順番が数字に映っていることの確認である。破れていたら、後から来た人の画面
   * のほうが短く出る。同じ人数・同じ希望の組どうしで比べる（席の候補が同じに
   * なるため）。
   */
  it('後から並んだ人ほど、目安が長い', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands, stepMin }) => {
        const built = play(state, commands, stepMin);
        const now: Timestamp = endOf(commands, stepMin);
        return queuedPairs(built).every(([first, second]) => {
          const earlier = estimateForTicket(built, first, now);
          const later = estimateForTicket(built, second, now);
          if (earlier.kind !== 'estimate' || later.kind !== 'estimate') return true;
          return earlier.minutes <= later.minutes;
        });
      }),
      RUNS,
    );
  });

  /**
   * **これから登録する人の目安は、すでに並んでいる人より短くならない。**
   *
   * 受付の前に出す数字（7.5 の 5）が、並んでいる人より甘く出ないこと。
   */
  it('これから並ぶ人の目安が、並んでいる人より短くならない', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands, stepMin }) => {
        const built = play(state, commands, stepMin);
        const now: Timestamp = endOf(commands, stepMin);
        return queued(built).every((item) => {
          const mine = estimateForTicket(built, item, now);
          const fresh = joinEstimate(built, item.partySize, now);
          if (mine.kind !== 'estimate' || fresh.kind !== 'estimate') return true;
          return mine.minutes <= fresh.minutes;
        });
      }),
      RUNS,
    );
  });

  /** 席が 1 つも無い施設では、どんな人数でも目安を返さない。 */
  it('使える席が無ければ、必ず「席が無い」と答える', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, commands, stepMin, partySize }) => {
        const built = play(state, commands, stepMin);
        const closed: VenueState = {
          ...built,
          tables: built.tables.map((item) => ({ ...item, status: 'DISABLED' as const })),
        };
        return joinEstimate(closed, partySize, endOf(commands, stepMin)).kind === 'no_seat';
      }),
      RUNS,
    );
  });

  /**
   * **空回りしていないこと。** 目安が返らない筋書きばかりでは、上の性質は
   * 何も確かめていない。**ここだけ種を固定してある**（生成器そのものの点検）。
   */
  it('その検査は、空回りしていない', () => {
    let estimates = 0;
    let queuedSeen = 0;

    fc.assert(
      fc.property(scenarioArb, ({ state, commands, stepMin, partySize }) => {
        const built = play(state, commands, stepMin);
        const now: Timestamp = endOf(commands, stepMin);
        if (joinEstimate(built, partySize, now).kind === 'estimate') estimates += 1;
        queuedSeen += queued(built).length;
      }),
      { ...RUNS, seed: 20260921 },
    );

    // 実測は 200 回で目安 144 回、並んでいる人 145 人。半分を下回ったら、
    // 生成器が列を立てられなくなっている。
    expect(estimates).toBeGreaterThan(70);
    expect(queuedSeen).toBeGreaterThan(70);
  });
});

/** 並んでいる（順番を持っている）チケット。 */
function queued(state: VenueState): readonly Ticket[] {
  return state.tickets.filter((item) => item.state === 'WAITING' || item.state === 'PAUSED');
}

/** 同じ人数で並んでいる組を、順番の早い順に 2 つずつ組にする。 */
function queuedPairs(state: VenueState): readonly (readonly [Ticket, Ticket])[] {
  const sorted = queued(state).toSorted(comparePriority);
  return sorted.flatMap((first, index) =>
    sorted
      .slice(index + 1)
      .filter((second) => second.partySize === first.partySize)
      .map((second) => [first, second] as const),
  );
}

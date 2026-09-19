/**
 * イベントループ。仮想の時計を進めながら、core にコマンドを投入する。
 *
 * ## 進め方
 *
 * 10 秒刻みで時計を進め、各刻みで
 *
 * 1. その時刻までに予定されている利用者の行動を、**予定の時刻の順に**投入する
 * 2. `tick` を呼ぶ
 * 3. 出てきたイベントを見て、次の行動を予定に入れる
 *
 * 利用者が出すコマンドは 5 つ。受付（`JOIN`）、向かっています（`EXTEND`）、
 * 準備OK（`READY`）、着席（`CHECK_IN`）、退席（`CHECK_OUT`）。譲る（`PASS`）は
 * 8.1 に率が無いので出さない。
 *
 * **利用者はイベントに反応する。** 呼び出されたことを知るのは `TicketCalled`
 * が出たときで、それは Phase 2 のサーバが通知を出すのと同じ形である。
 * シミュレータだけが知っている事実（誰がいつ呼ばれたか）を覗かないので、
 * 現実に起こりうる筋書きから外れない。
 *
 * ## 何を返すか
 *
 * 状態・イベントの列・欠陥の一覧。**指標（待ち時間、稼働率）は PR 14 の責務**で、
 * ここではイベントを素のまま返す。イベントから計算できるものを先に固めると、
 * 指標の定義を変えるたびにシミュレータを触ることになる。
 *
 * ## 欠陥
 *
 * `tick` は業務上の理由で拒否しない（PR 6）。拒否が返ったら実装の誤りなので、
 * 握り潰さず `defects` に積む。`apply` の拒否は、利用者の操作としてありうる
 * もの（もう終わっている、間に合わなかった）が大半なので、`isDefect` が真の
 * ものだけを積む。
 */

import type {
  Command,
  DomainEvent,
  Rejection,
  Table,
  Timestamp,
  VenueState,
} from '../src/index.js';
import {
  apply,
  createTable,
  createVenueState,
  findTicket,
  isDefect,
  minutes,
  seconds,
  tick,
} from '../src/index.js';
import { createParty, decidesNoShow, type Party } from './agent.js';
import { arrivalTimes } from './distributions.js';
import { streamFor } from './rng.js';
import type { Scenario, TableSpec } from './scenario.js';

/** `tick` を呼ぶ間隔。全体プラン 9.4 が定める 10 秒に合わせる。 */
export const TICK_INTERVAL = seconds(10);

/** 仮想の開始時刻。実時刻との対応には意味が無いので、読みやすい定数を置く。 */
export const SIM_EPOCH: Timestamp = 1_700_000_000_000;

export interface RunOptions {
  readonly scenario: Scenario;
  readonly seed: number;
  /**
   * 受付を閉じたあと、どれだけ見届けるか。
   *
   * 閉店後も着席中の人は帰るし、呼び出しの期限も切れる。既定の 60 分は
   * 「最後の組が席を使い終わるまで」を見るための余白である。
   */
  readonly cooldown?: number;
}

/** 走らせた結果。 */
export interface RunResult {
  readonly scenario: string;
  readonly seed: number;
  readonly state: VenueState;
  readonly events: readonly DomainEvent[];
  /** 到着した組。到着しなかった（受付時間外の）組は含まない。 */
  readonly parties: readonly Party[];
  /** 投入したコマンドの数。 */
  readonly commands: number;
  /** `tick` を呼んだ回数。 */
  readonly ticks: number;
  /** 実装の誤りを示す拒否。**空でなければ失敗である。** */
  readonly defects: readonly Rejection[];
  /**
   * コマンドを投入した時刻を、投入した順に並べたもの。
   *
   * **仮想の時計が巻き戻らないこと**を外から確かめられるようにしてある。
   * `apply` は「`now` は呼び出しのたびに進む」ことを前提にしている（9.4）ので、
   * ここが単調でなければシミュレータの側の誤りである。
   */
  readonly appliedAt: readonly Timestamp[];
  /** 最後に進めた仮想時刻。 */
  readonly endedAt: Timestamp;
}

/** 予定されている行動。 */
interface Scheduled {
  readonly at: Timestamp;
  /** 同じ時刻に並んだときの順序。予定に入れた順を保つ。 */
  readonly order: number;
  readonly command: Command;
}

// ---- 施設の組み立て ----

function tablesOf(specs: readonly TableSpec[], now: Timestamp): readonly Table[] {
  return specs.flatMap((spec, group) =>
    Array.from({ length: spec.count }, (_unused, seat) => {
      const id = `t${String(group)}-${String(seat)}`;
      return {
        ...createTable({
          id,
          label: `T-${String(spec.capacity)}-${String(seat + 1)}`,
          capacity: spec.capacity,
          now,
          tags: spec.tags ?? [],
          adminRank: group,
        }),
        status: 'FREE' as const,
      };
    }),
  );
}

/** シナリオから、運用が始まった状態を作る。 */
export function openVenue(scenario: Scenario, now: Timestamp = SIM_EPOCH): VenueState {
  return {
    ...createVenueState({
      venueId: scenario.name,
      policy: scenario.policy,
      tables: tablesOf(scenario.tables, now),
    }),
    operating: true,
    joinOpen: true,
  };
}

// ---- 予定表 ----

/**
 * 予定表。時刻の順、同じ時刻なら入れた順に取り出す。
 *
 * 組数は数百なので、素朴な配列で足りる。**順序が決まっていることだけが要件**で、
 * 速さは求めない。
 */
class Schedule {
  private items: Scheduled[] = [];
  private next = 0;

  add(at: Timestamp, command: Command): void {
    this.items.push({ at, order: this.next, command });
    this.next += 1;
  }

  /** `until` までに予定されているものを、順に取り出す。取り出した分は消える。 */
  take(until: Timestamp): readonly Scheduled[] {
    const due = this.items.filter((item) => item.at <= until);
    this.items = this.items.filter((item) => item.at > until);
    return [...due].sort((a, b) => (a.at === b.at ? a.order - b.order : a.at - b.at));
  }
}

// ---- 走らせる ----

/**
 * シナリオを 1 回走らせる。
 *
 * 同じ `(scenario, seed)` からは必ず同じ結果が出る。
 */
export function run(options: RunOptions): RunResult {
  const { scenario, seed } = options;
  const cooldown: number = options.cooldown ?? minutes(60);
  const endsAt: Timestamp = SIM_EPOCH + scenario.joinOpenFor + cooldown;

  const parties: readonly Party[] = plannedParties(scenario, seed);
  const schedule = new Schedule();
  for (const party of parties) schedule.add(party.arriveAt, joinCommand(party));

  const world = new World(scenario, parties, schedule);
  for (let now: Timestamp = SIM_EPOCH; now <= endsAt; now += TICK_INTERVAL) {
    world.step(now);
  }
  return world.finish(seed, endsAt);
}

/** 到着する組を、シナリオの到着率から作る。 */
function plannedParties(scenario: Scenario, seed: number): readonly Party[] {
  const offsets = arrivalTimes(streamFor(seed, 'arrivals', 0), scenario.arrivals, scenario.joinOpenFor);
  return offsets.map((offset, index) => createParty(seed, index, SIM_EPOCH + offset, scenario));
}

function joinCommand(party: Party): Command {
  return {
    type: 'JOIN',
    ticketId: party.ticketId,
    partySize: party.partySize,
    requiredTags: [],
    hasNotificationChannel: party.hasNotificationChannel,
  };
}

/**
 * 走っているあいだの状態をまとめて持つ。
 *
 * 可変なのはここだけにしてある。core はどこまでも純粋で、変わるのは
 * 「いまの状態」「予定表」「積み上げた記録」の 3 つだけである。
 */
class World {
  private state: VenueState;
  private readonly log: DomainEvent[] = [];
  private readonly defects: Rejection[] = [];
  private readonly appliedAt: Timestamp[] = [];
  /** 呼ばれたときに「行かない」と決めた人。保留に戻されても呼び直しを求めない。 */
  private readonly givenUp = new Set<string>();
  private ticks = 0;

  constructor(
    private readonly scenario: Scenario,
    private readonly parties: readonly Party[],
    private readonly schedule: Schedule,
  ) {
    this.state = openVenue(scenario);
  }

  /** 1 刻み進める。予定されている行動を出してから、時計を進める。 */
  step(now: Timestamp): void {
    for (const item of this.schedule.take(now)) {
      this.send(item.command, item.at);
    }
    this.advance(now);
  }

  private send(command: Command, at: Timestamp): void {
    const result = apply(this.state, command, at);
    this.appliedAt.push(at);
    if (!result.ok) {
      if (isDefect(result.error)) this.defects.push(result.error);
      return;
    }
    this.state = result.value.state;
    this.absorb(result.value.events, at);
  }

  private advance(now: Timestamp): void {
    const result = tick(this.state, now);
    this.ticks += 1;
    if (!result.ok) {
      // `tick` の拒否は理由によらず実装の誤りである（PR 6）。
      this.defects.push(result.error);
      return;
    }
    this.state = result.value.state;
    this.absorb(result.value.events, now);
  }

  /** 起きたことを記録し、利用者の反応を予定に入れる。 */
  private absorb(events: readonly DomainEvent[], now: Timestamp): void {
    this.log.push(...events);
    for (const event of events) this.react(event, now);
  }

  private react(event: DomainEvent, now: Timestamp): void {
    if (event.type === 'TicketCalled') this.onCalled(event.ticketId, now);
    if (event.type === 'TicketReminded') this.onReminded(event.ticketId, now);
    if (event.type === 'TicketPaused' && event.reason === 'no_show') this.onMissed(event.ticketId, now);
    if (event.type === 'TicketSeated') this.onSeated(event.ticketId, now);
  }

  /**
   * 呼ばれた。ノーショーするか決め、しないなら席へ向かう。
   *
   * ノーショーする人は **何もしない**。ホールドの期限が切れるのを待つだけで、
   * 「行かない」というコマンドは存在しない（7.7 の 6）。決めたことは覚えておく。
   * あとで保留に戻されたときに「準備OK」を押すかどうかが、これで決まる。
   */
  private onCalled(ticketId: string, now: Timestamp): void {
    const party = this.partyOf(ticketId);
    if (party === undefined) return;

    if (decidesNoShow(party, now - party.arriveAt, this.scenario)) {
      this.givenUp.add(ticketId);
      return;
    }
    this.schedule.add(now + party.walk, { type: 'CHECK_IN', ticketId, tableId: this.seatOf(ticketId) });
  }

  /**
   * 「あと 2 分」の知らせが届いた。向かっている人は「向かっています」を押す
   * （7.7 の 3、4）。
   *
   * 押す人と押さない人を分ける率は 8.1 に無い。**まだ着いていなくて、来る気が
   * ある人は押す**とみなしている。画面に出ているボタンを、来る気のある人が
   * 押さない理由は無い。
   */
  private onReminded(ticketId: string, now: Timestamp): void {
    if (this.givenUp.has(ticketId)) return;
    this.schedule.add(now, { type: 'EXTEND', ticketId });
  }

  /**
   * 間に合わなかった。来る気がある人は「準備OK」を押して呼び直してもらう
   * （7.7 の 6「本人が「準備OK」を押すまで呼び出さない」）。
   *
   * 何度でも繰り返すわけではない。既定の `requeue_once` では 2 回目の期限切れで
   * 終わるので、挑戦は 2 回までに収まる。
   */
  private onMissed(ticketId: string, now: Timestamp): void {
    if (this.givenUp.has(ticketId)) return;
    this.schedule.add(now, { type: 'READY', ticketId });
  }

  /** 着席した。滞在が終わったら退席を申告する（申告する人だけ）。 */
  private onSeated(ticketId: string, now: Timestamp): void {
    const party = this.partyOf(ticketId);
    if (party === undefined || !party.reportsCheckout) return;
    this.schedule.add(now + party.stay, { type: 'CHECK_OUT', ticketId, by: 'user' });
  }

  /** そのチケットにいま割り当てられている席。無ければ空文字（拒否される）。 */
  private seatOf(ticketId: string): string {
    return findTicket(this.state, ticketId)?.tableId ?? '';
  }

  private partyOf(ticketId: string): Party | undefined {
    return this.parties.find((party) => party.ticketId === ticketId);
  }

  finish(seed: number, endedAt: Timestamp): RunResult {
    return {
      scenario: this.scenario.name,
      seed,
      state: this.state,
      events: this.log,
      parties: this.parties,
      commands: this.appliedAt.length,
      ticks: this.ticks,
      defects: this.defects,
      appliedAt: this.appliedAt,
      endedAt,
    };
  }
}


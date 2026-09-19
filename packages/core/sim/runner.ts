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
 * 利用者が出すコマンドは 10 個。受付（`JOIN`）、向かっています（`EXTEND`）、
 * 準備OK（`READY`）、着席（`CHECK_IN`）、退席（`CHECK_OUT`）、飛び込み着席
 * （`WALK_IN`）、誰かが座っていた（`REPORT_TAKEN`）、まだ利用中（`STILL_HERE`）、
 * 確認要の席に座る（`CHECK_IN_EARLY`）、使用中だった（`REPORT_IN_USE`）。
 * 譲る（`PASS`）と席の変更（`SWAP_TABLE`）は 8.1 に率が無いので出さない。
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
  suggestNeedsCheck,
  tick,
} from '../src/index.js';
import { createParty, createSitter, decidesNoShow, type Party, type Sitter } from './agent.js';
import { arrivalTimes } from './distributions.js';
import { streamFor } from './rng.js';
import type { Scenario, TableSpec } from './scenario.js';
import type { DurationMs } from '../src/index.js';

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
  /** 登録せずに席へ向かった人のうち、実際に席に着けた人（8.1「無断利用」）。 */
  readonly sitters: readonly Sitter[];
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

/** 確認要の席を見に行く人。着いた時点で、空いているかどうかが分かる。 */
interface Visit {
  readonly at: Timestamp;
  readonly ticketId: string;
  readonly tableId: string;
}

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
  const sitters: readonly Sitter[] = plannedSitters(scenario, seed, endsAt - SIM_EPOCH);
  const schedule = new Schedule();
  for (const party of parties) schedule.add(party.arriveAt, joinCommand(party));

  const world = new World(scenario, parties, sitters, schedule);
  for (let now: Timestamp = SIM_EPOCH; now <= endsAt; now += TICK_INTERVAL) {
    world.step(now);
  }
  return world.finish(seed, endsAt);
}

/**
 * 登録せずに席へ向かう人を、シナリオの率から作る（8.1「無断利用」）。
 *
 * 率は 1 卓 1 時間あたりなので、卓数を掛けて施設全体の率にする。
 * **空席があるかどうかは、そのときになってみないと分からない**ので、ここでは
 * 候補の時刻だけを並べ、席が見つかるかは走らせながら決める。
 */
function plannedSitters(scenario: Scenario, seed: number, until: DurationMs): readonly Sitter[] {
  const tables: number = scenario.tables.reduce((sum, spec) => sum + spec.count, 0);
  const perHour: number = scenario.unregisteredPerTableHour * tables;
  if (perHour <= 0) return [];

  const rng = streamFor(seed, 'sitters', 0);
  const offsets = arrivalTimes(rng, [{ from: 0, perHour }], until);
  return offsets.map((offset, index) => createSitter(seed, index, SIM_EPOCH + offset, scenario));
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
  /** 登録せずに来て、実際に席に着けた人。 */
  private readonly seated: Sitter[] = [];
  private ticks = 0;

  /**
   * システムから見えないまま使われている席と、空くまでの時刻。
   *
   * **シミュレータだけが知っている事実**である。core には現れない。ここに
   * 載っている席へ案内された人は「誰かが座っています」と報告することになる
   * （7.8 の 10 行目）。
   */
  private readonly ghosts = new Map<string, Timestamp>();
  /** まだ席を探していない、登録せずに来た人。 */
  private pendingSitters: readonly Sitter[];

  /**
   * 席に着いた人が、実際に立ち上がる時刻。
   *
   * **シミュレータだけが知っている事実**である。退席を申告しない人の席は、
   * core から見れば使用中のままだが、現実にはこの時刻に空いている。
   * 「確認要の席を見に行ったら空いていたか」を、ここで判定する。
   */
  private readonly leavesAt = new Map<string, Timestamp>();
  /** 確認要の席を見に行く人。歩いている途中の人がここに入る。 */
  private visits: readonly Visit[] = [];
  /** 一度見に行った（人、席）の組。同じ席を何度も往復させない。 */
  private readonly checked = new Set<string>();

  constructor(
    private readonly scenario: Scenario,
    private readonly parties: readonly Party[],
    sitters: readonly Sitter[],
    private readonly schedule: Schedule,
  ) {
    this.state = openVenue(scenario);
    this.pendingSitters = sitters;
  }

  /** 1 刻み進める。予定されている行動を出してから、時計を進める。 */
  step(now: Timestamp): void {
    for (const item of this.schedule.take(now)) {
      this.send(item.command, item.at);
    }
    this.releaseGhosts(now);
    this.seatSitters(now);
    this.arriveAtUncertain(now);
    this.advance(now);
    this.followSuggestions(now);
  }

  /**
   * 「空いている可能性が高い席」を知らされた人が、見に行く（7.11 の 3 層目）。
   *
   * **誰が案内されるかは core に聞く。** シミュレータが独自に選ぶと、画面が
   * 出すものと違う筋書きを試してしまう。歩く時間は呼び出しのときと同じ。
   *
   * 来る気のある人は行くものとしている（`onReminded` と同じ考え方で、画面に
   * 出ているものを、待っている人が無視する理由が無い）。**一度見た席には
   * 戻らない。** 使用中だったと報告した席が、また案内されて往復になるのを
   * 避けるためである。
   */
  private followSuggestions(now: Timestamp): void {
    for (const suggestion of suggestNeedsCheck(this.state)) {
      const key = `${suggestion.ticketId}:${suggestion.tableId}`;
      if (this.checked.has(key) || this.givenUp.has(suggestion.ticketId)) continue;
      const party = this.partyOf(suggestion.ticketId);
      if (party === undefined) continue;

      this.checked.add(key);
      this.visits = [...this.visits, { at: now + party.walk, ...suggestion }];
    }
  }

  /**
   * 見に行った人が席に着く。**そこで初めて、空いているかどうかが分かる。**
   *
   * 歩いているあいだに席の状態は変わりうる（自動解放された、ほかの人が確かめた、
   * 本人が別の席へ呼ばれた）。着いた時点で確かめ直す。
   */
  private arriveAtUncertain(now: Timestamp): void {
    const arrived = this.visits.filter((visit) => visit.at <= now);
    this.visits = this.visits.filter((visit) => visit.at > now);
    for (const visit of arrived) this.lookAtSeat(visit, now);
  }

  private lookAtSeat(visit: Visit, now: Timestamp): void {
    const table = this.state.tables.find((item) => item.id === visit.tableId);
    if (table === undefined || table.status !== 'NEEDS_CHECK') return;
    if (findTicket(this.state, visit.ticketId)?.state !== 'WAITING') return;

    const command: Command = this.stillThere(table, now)
      ? { type: 'REPORT_IN_USE', ticketId: visit.ticketId, tableId: table.id }
      : { type: 'CHECK_IN_EARLY', ticketId: visit.ticketId, tableId: table.id };
    this.send(command, now);
  }

  /** その席に、いま実際に人が座っているか。シミュレータだけが知っている。 */
  private stillThere(table: Table, now: Timestamp): boolean {
    if (this.ghosts.has(table.id)) return true;
    const occupant: string | null = table.occupantTicketId;
    if (occupant === null) return false;
    const leaves: Timestamp | undefined = this.leavesAt.get(occupant);
    return leaves !== undefined && leaves > now;
  }

  /**
   * 登録せずに来た人を、空いている席に座らせる（8.1「無断利用」、7.12）。
   *
   * 座席 QR を読む人は飛び込み着席として登録され、読まない人はシステムから
   * 見えないまま座る。**空席が無ければ、その人は諦めて去る**（待ち行列には
   * 並ばない。並ぶ人は `parties` の側でモデル化している）。
   */
  private seatSitters(now: Timestamp): void {
    const due = this.pendingSitters.filter((sitter) => sitter.arriveAt <= now);
    this.pendingSitters = this.pendingSitters.filter((sitter) => sitter.arriveAt > now);
    for (const sitter of due) this.seatSitter(sitter, now);
  }

  private seatSitter(sitter: Sitter, now: Timestamp): void {
    const table = this.state.tables.find(
      (item) =>
        item.enabled &&
        item.status === 'FREE' &&
        !this.ghosts.has(item.id) &&
        sitter.partySize <= item.capacity,
    );
    if (table === undefined) return;

    if (sitter.scans) {
      this.send(
        { type: 'WALK_IN', ticketId: sitter.ticketId, tableId: table.id, partySize: sitter.partySize },
        now,
      );
      this.seated.push(sitter);
      return;
    }
    // 読まない人。システムからは空席のまま、実際には使われている。
    this.ghosts.set(table.id, now + sitter.stay);
    this.seated.push(sitter);
  }

  /** 見えないまま使われていた席から人が去る。席の記録はそのまま残る。 */
  private releaseGhosts(now: Timestamp): void {
    for (const [tableId, until] of [...this.ghosts]) {
      if (until <= now) this.ghosts.delete(tableId);
    }
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
    if (event.type === 'StillHereAsked') this.onAsked(event.ticketId, now);
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
    const tableId: string = this.seatOf(ticketId);
    // 席に着いてみて、誰かが座っていれば報告する（7.8 の 10 行目）。
    const command: Command = this.ghosts.has(tableId)
      ? { type: 'REPORT_TAKEN', ticketId, tableId }
      : { type: 'CHECK_IN', ticketId, tableId };
    this.schedule.add(now + party.walk, command);
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

  /**
   * 着席した。滞在が終わったら退席を申告する（申告する人だけ）。
   *
   * 並んで着席した人も、飛び込んだ人も同じように扱う。申告しない人の席は、
   * 整合性の回復（7.11）が拾うまで埋まったままになる。
   */
  private onSeated(ticketId: string, now: Timestamp): void {
    const occupant = this.occupantOf(ticketId);
    if (occupant === undefined) return;
    // 申告するかどうかに関わらず、この時刻には立ち上がっている。
    this.leavesAt.set(ticketId, now + occupant.stay);
    if (!occupant.reportsCheckout) return;
    this.schedule.add(now + occupant.stay, { type: 'CHECK_OUT', ticketId, by: 'user' });
  }

  /**
   * 「まだご利用中ですか」が届いた（7.11 の 2 層目）。
   *
   * **退席を申告する人は答える。申告しない人は答えない。** 8.1 が
   * 「申告なしは p90 の問いかけ → 無応答 → 確認要の経路を通る」と書いている
   * とおりで、同じ「アプリに反応するかどうか」がどちらも決めている。
   */
  private onAsked(ticketId: string, now: Timestamp): void {
    const occupant = this.occupantOf(ticketId);
    if (occupant === undefined || !occupant.reportsCheckout) return;
    this.schedule.add(now, { type: 'STILL_HERE', ticketId });
  }

  /** 席に着いている人。並んだ人でも、飛び込んだ人でもよい。 */
  private occupantOf(ticketId: string): { readonly stay: number; readonly reportsCheckout: boolean } | undefined {
    return this.partyOf(ticketId) ?? this.seated.find((sitter) => sitter.ticketId === ticketId);
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
      sitters: this.seated,
      commands: this.appliedAt.length,
      ticks: this.ticks,
      defects: this.defects,
      appliedAt: this.appliedAt,
      endedAt,
    };
  }
}


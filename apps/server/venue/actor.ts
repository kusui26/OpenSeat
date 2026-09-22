/**
 * 施設アクター（開発プラン 9.4）。
 *
 * **施設ごとに 1 つ。** 状態を手元に持ち、コマンドを 1 件ずつ順に適用し、
 * 同じトランザクションで記録してから配信する。
 *
 * ## ここが守るもの
 *
 * | | どうやって |
 * |---|---|
 * | **1 件ずつ順に** | 列に積む（`serialiser.ts`）。並行に来ても割り込ませない |
 * | **送り直しで二度適用しない** | 鍵の控えを見てから適用する（[ADR-0015](../../../docs/adr/0015-idempotency-key.md)） |
 * | **壊れた状態を書き込まない** | `core` が不変条件で弾き、DB の制約が二重に受ける。書けなければ何も変わらない |
 * | **落ちても取り戻せる** | 起動時に行から組み立てる（[ADR-0013](../../../docs/adr/0013-what-we-record.md)） |
 *
 * ## 時刻
 *
 * **サーバ時刻だけを信じる**（9.4、CLAUDE.md 3.4）。時計は外から渡す ——
 * テストで偽装するためであり、`core` が時刻を引数で受け取るのと同じ理由である。
 *
 * **時計が戻ったら `core` が断る**（`CLOCK_WENT_BACKWARD`）。握り潰さず、欠陥として
 * 記録する。
 *
 * ## 止まっていたあいだ
 *
 * `tick` は 10 秒ごとに呼ぶ（9.4）。**個別のタイマーは持たない。** 期限は状態に
 * 書いてある絶対時刻なので、**止まっていて時間が飛んでも、来ている期限は次の
 * 1 回ですべて片づく。** ただし**呼び出しは遡らない** —— 席が空いた時刻はその期限で
 * 刻まれるが、次の人を呼ぶのは再開した時点である（9.4、Phase 1 の PR 12）。
 */

import {
  dispatch,
  isDefect,
  tick,
  type Actor,
  type Command,
  type DomainEvent,
  type Rejection,
  type Timestamp,
  type VenueState,
} from '@openseat/core';
import type { Db } from '../db/client.js';
import {
  commit,
  findRecord,
  lastEventSeq,
  loadVenueState,
  pruneRecords,
  recordRejection,
  type CommandRecord,
  type TicketIdentity,
} from '../db/repository.js';
import { serialiser } from './serialiser.js';

/** 控えを覚えておく時間（ADR-0015）。実証実験は 1 日単位である（12.2）。 */
export const RECORD_TTL_MS = 24 * 60 * 60 * 1000;

/** 古い控えを捨てる間隔。毎回の刻みで走らせるほどのものではない。 */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** コマンド 1 件の申し出。 */
export interface CommandRequest {
  readonly actor: Actor;
  readonly command: Command;
  /**
   * 送り直しを見分ける鍵（9.4）。**画面が作る。**
   *
   * 省ける形にしない。**付け忘れると二度適用される**ので、型で必ず書かせる。
   */
  readonly key: string;
  /**
   * 新しく作られるチケットに付ける、`core` が持たない欄（9.8）。
   *
   * **受付（`JOIN`）と飛び込み（`WALK_IN`）のときだけ要る。** ほかは `null`。
   * 付け忘れると**秘密パラメータの無いチケット**ができ、本人が触れなくなるので、
   * ここも省ける形にしない。
   */
  readonly identity: TicketIdentity | null;
}

/** コマンド 1 件の結末。 */
export type CommandOutcome =
  | { readonly kind: 'applied'; readonly state: VenueState; readonly events: readonly DomainEvent[] }
  | { readonly kind: 'rejected'; readonly rejection: Rejection }
  /** 同じ鍵をすでに受け取っていた。**適用していない。** */
  | { readonly kind: 'replayed'; readonly record: CommandRecord };

/**
 * 記録が終わった 1 回ぶん。
 *
 * **配信（9.5）も通知（PR 16）も、ここから先を読む。**
 */
export interface Change {
  readonly events: readonly DomainEvent[];
  readonly state: VenueState;
  /**
   * いまの版（9.5、[ADR-0018](../../../docs/adr/0018-server-sent-events.md)）。
   *
   * 最後に書いたイベントの位置。**イベントが出なければ 1 つ前のまま**である。
   */
  readonly revision: number;
}

/** 記録が終わったことを知らせる。 */
export type Committed = (change: Change) => void;

export interface VenueActor {
  readonly venueId: string;
  /** いまの状態。**読むだけ。** */
  readonly state: () => VenueState;
  /** コマンドを 1 件、順番に適用する。 */
  readonly send: (request: CommandRequest) => Promise<CommandOutcome>;
  /**
   * 画面が開いていることを伝える（9.5、7.9 の放置判定）。
   *
   * **`send` と分けてある。** 心拍は操作ではなく、生きている合図だからである。
   * 扱いが 2 つ違う。
   *
   * - **控えを取らない。** 控え（[ADR-0015](../../../docs/adr/0015-idempotency-key.md)）は
   *   二度適用すると困るもののためにある。心拍は何度届いても結果が同じで、
   *   守るものが無い
   * - **配信を起こさない。** 心拍が変えるのは `lastSeenAt` だけで、これは
   *   誰の画面にも現れない（放置の判定にしか使わない。7.9）
   *
   * 数十秒ごとに**全接続から**届くので、どちらも開けておくと、接続の数だけ
   * 無駄が積み上がる。控えは `command_log` を埋め、配信は接続数の二乗で
   * 仕事を増やす。
   *
   * **断りは投げない。** 終わったチケットの画面が開いたままでも、心拍が
   * 通らないだけで何も起きてほしくない。
   */
  readonly touch: (actor: Actor, ticketId: string) => Promise<void>;
  /** 時刻を進める。10 秒ごとに呼ぶ（9.4）。 */
  readonly advance: () => Promise<void>;
  /** 記録が終わったことを知らせてもらう。 */
  readonly onCommitted: (listener: Committed) => void;
  /** いまの版（9.5）。**つないだ相手に、どこまで見たかを伝える。** */
  readonly revision: () => number;
  /**
   * 最後に**うまく**時刻を進めた実時刻。**監視が `tick` の遅れを見る**（CLAUDE.md 8）。
   *
   * 断られた刻みでは更新しない。**動いているのに何も進んでいない**状態を、
   * 遅れとして見えるようにするためである。
   */
  readonly lastTickAt: () => Timestamp | null;
  /** 刻みが断られた回数。**0 でないなら実装の誤りが出ている。** */
  readonly tickFailures: () => number;
}

/**
 * 施設 1 つぶんの持ち物。
 *
 * **書き換わるのはここだけである。** 状態そのものは `core` が新しい値を返すので、
 * ここが持っているのは「いまどれを指しているか」にすぎない。
 *
 * **列に積むのはこの外側である**（`openVenueActor`）。中のメソッドは、自分が
 * 1 件ずつ呼ばれることを前提にしてよい。
 */
class Venue {
  state: VenueState;
  lastTick: Timestamp | null = null;
  failures = 0;
  /** いまの版（9.5）。**イベントを書くたびに進む。** */
  revision: number;

  private lastPrune: Timestamp | null = null;
  private readonly listeners: Committed[] = [];

  constructor(
    private readonly db: Db,
    readonly id: string,
    restored: VenueState,
    revision: number,
  ) {
    this.state = restored;
    this.revision = revision;
  }

  listen(listener: Committed): void {
    this.listeners.push(listener);
  }

  /** コマンドを 1 件。**控えを見てから適用する。** */
  apply(request: CommandRequest, now: Timestamp): CommandOutcome {
    const seen: CommandRecord | null = findRecord(this.db, this.id, request.key);
    if (seen !== null) return { kind: 'replayed', record: seen };

    const decided = dispatch(this.state, request.actor, request.command, now);
    return decided.ok
      ? this.keep(request, decided.value.state, decided.value.events, now)
      : this.refuse(request, decided.error, now);
  }

  /** 通った。**状態・イベント・履歴・控えを、1 つのトランザクションで。** */
  private keep(
    request: CommandRequest,
    next: VenueState,
    events: readonly DomainEvent[],
    now: Timestamp,
  ): CommandOutcome {
    this.write({
      next,
      events,
      actor: request.actor,
      now,
      record: recordOf(request, true, null, now),
      identity: request.identity,
    });
    return { kind: 'applied', state: next, events };
  }

  /**
   * 断られた。**状態は変わっていない**ので、控えだけを書く。
   *
   * **欠陥は控えない。** 実装の誤り（時計の巻き戻り、名乗りの食い違い）は、
   * 送り直しに同じ答えを返しても意味が無い。直したあとに通ってほしい。
   */
  private refuse(request: CommandRequest, rejection: Rejection, now: Timestamp): CommandOutcome {
    if (!isDefect(rejection)) {
      recordRejection(this.db, this.id, recordOf(request, false, rejection.code, now));
    }
    return { kind: 'rejected', rejection };
  }

  /** 時刻を進める。 */
  advance(now: Timestamp): void {
    const decided = tick(this.state, now);
    this.prune(now);
    if (!decided.ok) {
      this.failures += 1;
      throw new TickFailed(this.id, decided.error);
    }
    this.lastTick = now;
    if (decided.value.events.length === 0 && decided.value.state === this.state) return;
    this.write({
      next: decided.value.state,
      events: decided.value.events,
      actor: null,
      now,
      record: null,
      identity: null,
    });
  }

  /**
   * 画面が開いていることを記録する（9.5、7.9）。
   *
   * **控えも取らず、知らせも出さない**（`VenueActor.touch` に理由がある）。
   * 断られても黙って捨てる —— 終わったチケットの画面が開いたままでも、
   * ここで何かが起きてほしくない。
   */
  sign(actor: Actor, ticketId: string, now: Timestamp): void {
    const decided = dispatch(this.state, actor, { type: 'HEARTBEAT', ticketId }, now);
    if (!decided.ok) return;
    this.store(decided.value.state, decided.value.events, null, now, null, null);
    this.state = decided.value.state;
  }

  /** 記録してから配信する。**順番を入れ替えない**（9.4）。 */
  private write(change: Written): void {
    const seq: number | null = this.store(
      change.next,
      change.events,
      change.actor,
      change.now,
      change.record,
      change.identity,
    );
    this.state = change.next;
    if (seq !== null) this.revision = seq;
    const told: Change = { events: change.events, state: change.next, revision: this.revision };
    for (const listener of this.listeners) listener(told);
  }

  /** 1 つのトランザクションに収める。**書いた最後のイベントの位置を返す。** */
  private store(
    next: VenueState,
    events: readonly DomainEvent[],
    actor: Actor | null,
    now: Timestamp,
    record: CommandRecord | null,
    identity: TicketIdentity | null,
  ): number | null {
    return commit(this.db, {
      before: this.state,
      after: next,
      events,
      actor,
      at: now,
      record,
      identity,
    }).lastSeq;
  }

  /** 古い控えを捨てる（24 時間。ADR-0015）。 */
  private prune(now: Timestamp): void {
    if (this.lastPrune !== null && now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    pruneRecords(this.db, now - RECORD_TTL_MS);
  }
}

/** 1 回ぶんの書き込み。引数が増えてきたのでまとめてある。 */
interface Written {
  readonly next: VenueState;
  readonly events: readonly DomainEvent[];
  readonly actor: Actor | null;
  readonly now: Timestamp;
  readonly record: CommandRecord | null;
  readonly identity: TicketIdentity | null;
}

export interface OpenActorParams {
  readonly db: Db;
  readonly venueId: string;
  /** サーバの時計。**テストでは偽装する。** */
  readonly clock: () => Timestamp;
}

/**
 * 施設アクターを起こす。
 *
 * **起動時の復元はここで終わる。** 行から状態を組み立てるだけで、イベントは
 * 読まない（ADR-0013）。
 */
export function openVenueActor(params: OpenActorParams): VenueActor {
  const restored: VenueState | null = loadVenueState(params.db, params.venueId);
  if (restored === null) throw new Error(`施設 ${params.venueId} が見つかりません`);

  const seq: number = lastEventSeq(params.db, params.venueId);
  return serve(new Venue(params.db, params.venueId, restored, seq), params.clock);
}

/**
 * 持ち物を、外から触れる形にする。
 *
 * **入口はすべて列を通る**（`serialiser`）。読むだけのものは通さない ——
 * 待たせる理由が無く、いちばん新しいものが欲しいだけだからである。
 */
function serve(venue: Venue, clock: () => Timestamp): VenueActor {
  const queue = serialiser();
  /** 返しの要らないものを、列に積む。 */
  const run = (work: () => void): Promise<void> => queue(work);
  return {
    venueId: venue.id,
    state: () => venue.state,
    revision: () => venue.revision,
    lastTickAt: () => venue.lastTick,
    tickFailures: () => venue.failures,
    onCommitted: (listener) => {
      venue.listen(listener);
    },
    send: (request) => queue(() => venue.apply(request, clock())),
    touch: (actor, ticketId) => run(() => venue.sign(actor, ticketId, clock())),
    advance: () => run(() => venue.advance(clock())),
  };
}

function recordOf(
  request: CommandRequest,
  ok: boolean,
  rejectionCode: CommandRecord['rejectionCode'],
  at: Timestamp,
): CommandRecord {
  return {
    key: request.key,
    at,
    commandType: request.command.type,
    ok,
    rejectionCode,
    ticketId: 'ticketId' in request.command ? request.command.ticketId : null,
  };
}

/**
 * `tick` が断られた。
 *
 * **時刻が進むことを業務上の理由で拒否することはない**ので、これは必ず実装の
 * 誤りである（`core` の `Tick`）。握り潰さずに投げ、呼んだ側が記録する。
 */
export class TickFailed extends Error {
  readonly rejection: Rejection;

  constructor(venueId: string, rejection: Rejection) {
    super(`施設 ${venueId} の tick が拒否されました: ${rejection.code}`);
    this.name = 'TickFailed';
    this.rejection = rejection;
  }
}

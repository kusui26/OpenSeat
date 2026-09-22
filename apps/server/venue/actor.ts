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
  loadVenueState,
  pruneRecords,
  recordRejection,
  type CommandRecord,
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
}

/** コマンド 1 件の結末。 */
export type CommandOutcome =
  | { readonly kind: 'applied'; readonly state: VenueState; readonly events: readonly DomainEvent[] }
  | { readonly kind: 'rejected'; readonly rejection: Rejection }
  /** 同じ鍵をすでに受け取っていた。**適用していない。** */
  | { readonly kind: 'replayed'; readonly record: CommandRecord };

/** 記録が終わったあとに呼ばれる。**配信はここから先の仕事**（PR 7）。 */
export type Committed = (events: readonly DomainEvent[], state: VenueState) => void;

export interface VenueActor {
  readonly venueId: string;
  /** いまの状態。**読むだけ。** */
  readonly state: () => VenueState;
  /** コマンドを 1 件、順番に適用する。 */
  readonly send: (request: CommandRequest) => Promise<CommandOutcome>;
  /** 時刻を進める。10 秒ごとに呼ぶ（9.4）。 */
  readonly advance: () => Promise<void>;
  /** 記録が終わったことを知らせてもらう。 */
  readonly onCommitted: (listener: Committed) => void;
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

  private lastPrune: Timestamp | null = null;
  private readonly listeners: Committed[] = [];

  constructor(
    private readonly db: Db,
    private readonly venueId: string,
    restored: VenueState,
  ) {
    this.state = restored;
  }

  listen(listener: Committed): void {
    this.listeners.push(listener);
  }

  /** コマンドを 1 件。**控えを見てから適用する。** */
  apply(request: CommandRequest, now: Timestamp): CommandOutcome {
    const seen: CommandRecord | null = findRecord(this.db, this.venueId, request.key);
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
    this.write(next, events, request.actor, now, recordOf(request, true, null, now));
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
      recordRejection(this.db, this.venueId, recordOf(request, false, rejection.code, now));
    }
    return { kind: 'rejected', rejection };
  }

  /** 時刻を進める。 */
  advance(now: Timestamp): void {
    const decided = tick(this.state, now);
    this.prune(now);
    if (!decided.ok) {
      this.failures += 1;
      throw new TickFailed(this.venueId, decided.error);
    }
    this.lastTick = now;
    if (decided.value.events.length === 0 && decided.value.state === this.state) return;
    this.write(decided.value.state, decided.value.events, null, now, null);
  }

  /** 記録してから配信する。**順番を入れ替えない**（9.4）。 */
  private write(
    next: VenueState,
    events: readonly DomainEvent[],
    actor: Actor | null,
    now: Timestamp,
    record: CommandRecord | null,
  ): void {
    commit(this.db, { before: this.state, after: next, events, actor, at: now, record });
    this.state = next;
    for (const listener of this.listeners) listener(events, next);
  }

  /** 古い控えを捨てる（24 時間。ADR-0015）。 */
  private prune(now: Timestamp): void {
    if (this.lastPrune !== null && now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    pruneRecords(this.db, now - RECORD_TTL_MS);
  }
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

  const venue = new Venue(params.db, params.venueId, restored);
  const queue = serialiser();

  return {
    venueId: params.venueId,
    state: () => venue.state,
    send: (request) => queue(() => venue.apply(request, params.clock())),
    advance: () =>
      queue(() => {
        venue.advance(params.clock());
      }),
    onCommitted: (listener) => {
      venue.listen(listener);
    },
    lastTickAt: () => venue.lastTick,
    tickFailures: () => venue.failures,
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

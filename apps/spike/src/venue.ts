/**
 * 施設 1 つぶんの単一ライター（開発プラン 9.4）。
 *
 * **業務の判断をしない。** `core` の `apply` と `tick` を 1 件ずつ順に呼び、
 * 通ったものを記録に書き足すだけである（CLAUDE.md 3 章）。ここに
 * `if (ticket.state === 'CALLED')` のような分岐が現れたら、それは設計の誤り。
 *
 * Phase 2 の `VenueActor` はこれが育ったものになるが、**キューイング・冪等キー・
 * 配信・権限はまだ無い。** どれも Phase 2 で決める（Phase 1 プラン 11 章）。
 */

import type {
  Command,
  DomainEvent,
  Rejection,
  Result,
  Timestamp,
  VenueState,
} from '@openseat/core';
import { apply, tick } from '@openseat/core';
import type { Input, Store } from './store.js';

/** 1 回のコマンド適用の結果。 */
export type Applied = Result<readonly DomainEvent[], Rejection>;

export class Venue {
  private current: VenueState;

  private constructor(
    private readonly store: Store,
    initial: VenueState,
  ) {
    this.current = initial;
  }

  /**
   * 記録を流し直して、落ちる前の状態に戻す。
   *
   * **同じ入力からは必ず同じ状態が出る**ので（ADR-0004）、これだけで取り戻せる。
   * 記録が空なら、渡された初期状態から始まる。
   */
  static restore(store: Store, initial: VenueState): Venue {
    const venue = new Venue(store, initial);
    for (const input of store.replay()) venue.replayOne(input);
    return venue;
  }

  /** 記録に残さずに 1 件だけ流す（取り戻しのときだけ使う）。 */
  private replayOne(input: Input): void {
    if (input.kind === 'tick') {
      const ticked = tick(this.current, input.at);
      if (ticked.ok) this.current = ticked.value.state;
      return;
    }
    const applied = apply(this.current, input.command, input.at);
    if (applied.ok) this.current = applied.value.state;
  }

  /**
   * コマンドを 1 件適用する。
   *
   * **通ったものだけを記録する。** 拒否されたコマンドは状態を変えないので、
   * 流し直しても同じところで拒否されるだけである。
   */
  dispatch(command: Command, now: Timestamp): Applied {
    const applied = apply(this.current, command, now);
    if (!applied.ok) return applied;
    this.current = applied.value.state;
    this.store.append({ kind: 'command', at: now, command });
    return { ok: true, value: applied.value.events };
  }

  /**
   * 期限を進める（9.4 の 10 秒ごと）。
   *
   * **何も起きなかった刻みは記録しない。** 状態が変わっていないので、流し直す
   * 必要が無い。そのぶん記録が小さく保たれる。
   */
  advance(now: Timestamp): readonly DomainEvent[] {
    const ticked = tick(this.current, now);
    if (!ticked.ok) return [];
    this.current = ticked.value.state;
    if (ticked.value.events.length > 0) this.store.append({ kind: 'tick', at: now });
    return ticked.value.events;
  }

  get state(): VenueState {
    return this.current;
  }
}

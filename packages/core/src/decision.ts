/**
 * ドメインロジックの呼び出し規約。
 *
 * すべての状態変化は `Apply` か `Tick` を通る。どちらも純粋関数で、
 * 新しい状態と、発生したイベントを返す（ADR-0004）。
 */

import type { Timestamp } from './time.js';

/** 状態変化の結果。状態を破壊的に更新せず、新しい状態を返す。 */
export interface Decision<State, Event> {
  readonly state: State;
  readonly events: readonly Event[];
}

/** コマンドの適用。呼び出し側は結果を永続化してからイベントを配信する。 */
export type Apply<State, Command, Event> = (
  state: State,
  command: Command,
  now: Timestamp,
) => Decision<State, Event>;

/**
 * 時刻起因の遷移。ホールド期限・リマインド・保留期限・上限超過を、
 * 状態のタイムスタンプから計算して適用する。個別のタイマーを持たない。
 */
export type Tick<State, Event> = (state: State, now: Timestamp) => Decision<State, Event>;

/** 何も起きなかったことを表す。 */
export function unchanged<State, Event>(state: State): Decision<State, Event> {
  return { state, events: [] };
}

/** 状態変化とイベントを表す。 */
export function decided<State, Event>(
  state: State,
  events: readonly Event[],
): Decision<State, Event> {
  return { state, events };
}

/** 2 つの決定を順に適用した結果に畳み込む。イベントは順序を保って連結する。 */
export function sequence<State, Event>(
  first: Decision<State, Event>,
  next: (state: State) => Decision<State, Event>,
): Decision<State, Event> {
  const second: Decision<State, Event> = next(first.state);
  return { state: second.state, events: [...first.events, ...second.events] };
}

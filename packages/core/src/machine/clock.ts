/**
 * 時計。**状態が知っている「最後の時刻」を守る層**（全体プラン 9.4）。
 *
 * 9.4 は「時刻はサーバ時刻のみを信頼する」と書いている。コアはその時刻を
 * 引数で受け取るだけなので、**渡された時刻が前より戻っていないことを、
 * コア自身が確かめられるようにしておく**。
 *
 * なぜ要るか。期限の判定はすべて「状態に書いてある絶対時刻」と `now` の比較で
 * できている（`deadlines.ts`）。時計が戻ると、**いったん過ぎた期限がまた
 * 「これから」に戻る**。ホールドが切れて保留に戻った人に、もう一度ホールドの
 * 期限が生えるようなことが起こりうる。壊れ方が静かなので、入口で落とす。
 *
 * **これは実装の誤りであって、利用者の操作の誤りではない。** サーバの時計が
 * ずれた、`tick` の呼び出し順が入れ替わった、といった原因しかない。だから
 * `isDefect` が真を返す側に置いてある（`rejection.ts`）。
 */

import type { VenueState } from '../domain/state.js';
import type { Timestamp } from '../time.js';
import { rejection, type Rejection } from './rejection.js';

/**
 * その時刻で進めてよいか。戻っていれば理由を返す。
 *
 * **同じ時刻は通す。** 同じ時刻の `tick` を何度呼んでも状態が変わらないこと
 * （9.12 の 5）は保ちたい性質なので、等しい場合を弾いてはいけない。
 */
export function checkClock(state: VenueState, now: Timestamp): Rejection | null {
  if (state.clockAt === null || now >= state.clockAt) return null;
  return rejection('CLOCK_WENT_BACKWARD', '渡された時刻が、状態が知っている時刻より前である');
}

/** 状態に「ここまで進んだ」を刻む。`apply` と `tick` の出口で通る。 */
export function withClock(state: VenueState, now: Timestamp): VenueState {
  return state.clockAt === now ? state : { ...state, clockAt: now };
}

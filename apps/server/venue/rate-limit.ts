/**
 * 受付の回数制限（7.16 の `join_rate_limit_per_hour`）。
 *
 * **1 つの端末が、1 時間に何回まで並べるか。** 悪用の抑止であって、利用者を
 * 困らせるためのものではない。既定は 5 回で、**ふつうに使っていて当たることは無い。**
 *
 * ## なぜ `core` に置かないのか
 *
 * **`core` は履歴を持たないからである。** 状態は「いまどうなっているか」だけを
 * 持ち、「この端末が 1 時間に何回受け付けたか」は持っていない（持たせると、
 * 終わったチケットを捨てられなくなる）。数えるには記録を引く必要があり、
 * それは境界の仕事である（ADR-0004）。
 *
 * **上限そのものは運用パラメータから取る。** 数字をここに書かない。
 */

import type { Timestamp } from '@openseat/core';
import type { Db } from '../db/client.js';
import { joinsSince } from '../db/repository.js';

/** 1 時間。 */
const WINDOW_MS = 60 * 60 * 1000;

export interface RateLimitParams {
  readonly db: Db;
  readonly venueId: string;
  readonly clientTokenHash: string;
  /** 7.16 の `join_rate_limit_per_hour`。 */
  readonly limitPerHour: number;
  readonly now: Timestamp;
}

/** その端末が、いま受付を出せるか。 */
export function mayJoin(params: RateLimitParams): boolean {
  const recent: number = joinsSince(
    params.db,
    params.venueId,
    params.clientTokenHash,
    params.now - WINDOW_MS,
  );
  return recent < params.limitPerHour;
}

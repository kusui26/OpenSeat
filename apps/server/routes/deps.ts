/**
 * ハンドラが外に頼るもの。
 *
 * **ここに並んでいるのが、ルート層から見える世界のすべてである。** 永続化にも
 * ORM にも直接は触らない（CLAUDE.md 3.1、`pnpm check:arch`）。
 *
 * 組み立てるのは `index.ts` で、**テストは偽物を差し込める。**
 */

import type { Timestamp, VenueState } from '@openseat/core';
import type { VenueActor } from '../venue/actor.js';

/** 名前で引き当てた施設。 */
export interface VenueHandle {
  readonly actor: VenueActor;
  /** URL に出る短い名前（9.6）。 */
  readonly slug: string;
  readonly name: string;
  /** 表示に使うタイムゾーン。**保存は常に UTC**（CLAUDE.md 6）。 */
  readonly timezone: string;
  /** 文言を作るのに使う（施設の設定。9.6）。 */
  readonly locale: string;
}

/** チケットで引き当てた施設。**本人かどうかを確かめる材料も一緒に返す。** */
export interface TicketHandle extends VenueHandle {
  /** そのチケットの秘密パラメータのハッシュ。**生の値は持たない。** */
  readonly secretHash: string | null;
}

export interface Deps {
  /** サーバの時計。**クライアントの時計は信じない**（9.4）。 */
  readonly clock: () => Timestamp;
  /** 新しいチケットの識別子。**`core` は乱数を持てない**ので境界が作る（ADR-0004）。 */
  readonly newId: () => string;
  readonly findVenue: (slug: string) => VenueHandle | null;
  readonly findTicket: (ticketId: string) => TicketHandle | null;
  /** その端末が、いま受付を出せるか（7.16 の `join_rate_limit_per_hour`）。 */
  readonly mayJoin: (state: VenueState, clientTokenHash: string) => boolean;
  /**
   * 座席 QR のトークンから、席を引く（7.8）。
   *
   * **外から席を指せるのはトークンだけである。** 内部 ID を受け取ると、QR を
   * 読まずに他人の席を指せてしまう。
   */
  readonly findTable: (venueId: string, token: string) => string | null;
  /** 施設が引けなかったときの文言に使う。 */
  readonly defaultLocale: string;
}

/**
 * コマンド。施設の状態に対する「こうしてほしい」という申し出。
 *
 * **命令形で名づける。** 起きたこと（過去形）は `events.ts` のイベントで表す。
 * 混ぜない（Phase 1 プラン 7.5）。
 *
 * **ID は外から渡す。** 生成には乱数が要り、`core` は乱数を持てない（ADR-0004）。
 * `JOIN` は `ticketId` を含み、生成はシミュレータとサーバの責務になる。例外は
 * 表示コードで、状態から決定的に導けるため `core` が採番する。
 *
 * コマンドは PR ごとに増える。この版（PR 5）が扱うのは、受付・キャンセル・保留と、
 * 状態を変えない 2 つ（人数の変更、心拍）である。呼び出しとホールド（PR 6）、
 * 着席と退席（PR 7）、座席 QR の分岐（PR 9）は後続で足す。
 */

import type { Tag, TicketId } from '../domain/ids.js';
import type { EndReason } from '../domain/ticket.js';

/**
 * コマンドを出した人。
 *
 * `core` が区別するのは「本人か、スタッフか」だけで、それ以上の役割
 * （owner / admin / staff）と権限表は Phase 2 の責務である（Phase 1 プラン 2）。
 * 権限はサーバ側の実行者の概念に依存するため、ここでは先取りしない。
 */
export const ACTORS = ['user', 'staff'] as const;

export type Actor = (typeof ACTORS)[number];

/**
 * キャンセルの理由（全体プラン 7.9）。統計に使う。
 *
 * 利用者には任意選択で出す。スタッフの操作では必須にする（監査のため）。
 */
export const CANCEL_REASONS = ['found_seat', 'leaving', 'too_long', 'other'] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

/**
 * 誰が取り消したかと、記録される終わり方の対応。
 *
 * 分岐ではなく表として宣言する。実行者を足したときに、どの終わり方で記録するかを
 * 必ず決めさせるため（CLAUDE.md 3.2）。
 */
export const CANCEL_END_REASONS = {
  user: 'user_cancel',
  staff: 'staff_cancel',
} as const satisfies Record<Actor, EndReason>;

/** 受付（全体プラン 7.5）。入口の受付 QR から人数を登録する。 */
export interface JoinCommand {
  readonly type: 'JOIN';
  readonly ticketId: TicketId;
  readonly partySize: number;
  /** 車いす対応席など。候補を絞るだけで、順番は早めない（7.6）。 */
  readonly requiredTags: readonly Tag[];
  /** Web Push や LINE のように、画面を閉じても届く手段を持つか。 */
  readonly hasNotificationChannel: boolean;
}

/** 取り消し（全体プラン 7.9）。 */
export interface CancelCommand {
  readonly type: 'CANCEL';
  readonly ticketId: TicketId;
  readonly by: Actor;
  /** 本人は任意、スタッフは必須。 */
  readonly reason: CancelReason | null;
}

/** 呼び出しの保留（全体プラン 7.7 の 5）。順番は保持される。 */
export interface PauseCommand {
  readonly type: 'PAUSE';
  readonly ticketId: TicketId;
}

/** 「準備OK」（全体プラン 7.7 の 6）。保留から待ちへ戻る。 */
export interface ReadyCommand {
  readonly type: 'READY';
  readonly ticketId: TicketId;
}

/** 人数の変更（全体プラン 7.6 のエッジケース）。待っている間だけできる。 */
export interface ChangePartySizeCommand {
  readonly type: 'CHANGE_PARTY_SIZE';
  readonly ticketId: TicketId;
  readonly partySize: number;
}

/**
 * 心拍（全体プラン 7.9 の「暗黙のキャンセル」）。
 *
 * 利用者の画面が開いていることを知らせる。通知手段が無い人の放置判定
 * （`abandonTimeoutMin`）の起点になる。状態は変えない。
 */
export interface HeartbeatCommand {
  readonly type: 'HEARTBEAT';
  readonly ticketId: TicketId;
}

export type Command =
  | JoinCommand
  | CancelCommand
  | PauseCommand
  | ReadyCommand
  | ChangePartySizeCommand
  | HeartbeatCommand;

export type CommandType = Command['type'];

/**
 * この版が受け付けるコマンドの種別。
 *
 * ファズの生成器が、増えたコマンドを取りこぼしていないかを照合するために使う
 * （Phase 1 プラン 6.2「新しいコマンドを足したら、ファズの生成器にも足す」）。
 */
export const COMMAND_TYPES = [
  'JOIN',
  'CANCEL',
  'PAUSE',
  'READY',
  'CHANGE_PARTY_SIZE',
  'HEARTBEAT',
] as const satisfies readonly CommandType[];

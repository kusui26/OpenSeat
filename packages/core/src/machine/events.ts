/**
 * ドメインイベント。起きたことの記録。
 *
 * **Phase 1 では誰も読まない。** 消費者は Phase 2 の永続化・配信・通知である
 * （Phase 1 プラン 7.5）。それでも今から出しておく。後から足すと、状態変化と
 * イベントの対応に漏れが出るためである。
 *
 * 漏れを防ぐ仕掛けは、イベントを先回りして宣言することではなく
 * **「状態が変わったら必ずイベントが出る」を性質テストで押さえること**にした。
 * 宣言だけ先に並べても、出し忘れは止められない。だからこのファイルには、
 * いま実際に出しているイベントだけを置く。
 *
 * 名前は過去形にする。コマンド（命令形）と混ぜない。
 */

import type { TableId, TicketCode, TicketId } from '../domain/ids.js';
import type { EndReason } from '../domain/ticket.js';
import type { Timestamp } from '../time.js';
import type { Actor, CancelReason } from './command.js';

/** 受付が済んだ（全体プラン 7.5）。 */
export interface TicketJoined {
  readonly type: 'TicketJoined';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  /** ボードと口頭の呼び出しに使う短いコード。 */
  readonly code: TicketCode;
  readonly partySize: number;
}

/** 呼び出しを保留にした（全体プラン 7.7 の 5）。 */
export interface TicketPaused {
  readonly type: 'TicketPaused';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  /** この時刻を過ぎて操作が無ければ期限切れになる。画面の残り時間の元になる。 */
  readonly until: Timestamp;
}

/** 「準備OK」で待ちに戻った（全体プラン 7.7 の 6）。 */
export interface TicketResumed {
  readonly type: 'TicketResumed';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
}

/** 取り消された（全体プラン 7.9）。 */
export interface TicketCancelled {
  readonly type: 'TicketCancelled';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  readonly by: Actor;
  readonly reason: CancelReason | null;
  readonly endReason: EndReason;
}

/** 人数が変わった（全体プラン 7.6 のエッジケース）。 */
export interface PartySizeChanged {
  readonly type: 'PartySizeChanged';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  readonly from: number;
  readonly to: number;
  /** 増やした場合は現在時刻に更新される。減らした場合は元のまま。 */
  readonly priorityAt: Timestamp;
}

/**
 * 席が空いた。
 *
 * この版では、確保していた人が取り消したときにだけ出る。退席（PR 7）や
 * ノーショー（PR 6）でも出るようになる。
 */
export interface TableFreed {
  readonly type: 'TableFreed';
  readonly at: Timestamp;
  readonly tableId: TableId;
  /** 誰の確保が解けたか。空席になった理由の説明に使う。 */
  readonly releasedTicketId: TicketId;
}

export type DomainEvent =
  | TicketJoined
  | TicketPaused
  | TicketResumed
  | TicketCancelled
  | PartySizeChanged
  | TableFreed;

export type DomainEventType = DomainEvent['type'];

/**
 * この版が発行するイベントの種別。
 *
 * 種別を足したときに、どこかに書き忘れていないかを照合するために使う。
 */
export const DOMAIN_EVENT_TYPES = [
  'TicketJoined',
  'TicketPaused',
  'TicketResumed',
  'TicketCancelled',
  'PartySizeChanged',
  'TableFreed',
] as const satisfies readonly DomainEventType[];

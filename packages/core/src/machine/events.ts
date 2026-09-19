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
 *
 * **チケットの終わりは `TicketEnded` 1 つにまとめてある。** 終わり方は 10 通り
 * （`END_REASONS`）あるが、消費者が知りたいのは「終わった」ことと「なぜ」で、
 * そこは `endReason` が語る。終わり方ごとにイベントを分けると、終わり方を足す
 * たびに消費者側の分岐が増え、書き忘れが起きる。
 */

import type { TableId, TicketCode, TicketId } from '../domain/ids.js';
import type { EndReason } from '../domain/ticket.js';
import type { TicketOrigin } from './ticket-machine.js';
import type { AssignmentReason } from '../allocation/choose.js';
import type { Timestamp } from '../time.js';
import type { Actor, CancelReason } from './command.js';

/**
 * チケットが作られた（全体プラン 7.5、7.12）。
 *
 * 入口の受付から並んだ場合（`JOIN`）と、空席の QR から直接座った場合
 * （`WALK_IN`）の 2 つがある。後者は待ち行列を経ずに `SEATED` から始まる。
 */
export interface TicketJoined {
  readonly type: 'TicketJoined';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  /** ボードと口頭の呼び出しに使う短いコード。 */
  readonly code: TicketCode;
  readonly partySize: number;
  readonly origin: TicketOrigin;
}

/**
 * 呼び出した（全体プラン 7.7 の 1）。
 *
 * このイベントが通知（画面・Web Push・LINE・入口ボード）の起点になる。
 * `reason` は「なぜこの人が選ばれたか」で、利用者への説明に使う（7.6）。
 */
export interface TicketCalled {
  readonly type: 'TicketCalled';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  readonly tableId: TableId;
  readonly holdDeadline: Timestamp;
  readonly reason: AssignmentReason;
}

/** 席を確保した。 */
export interface TableHeld {
  readonly type: 'TableHeld';
  readonly at: Timestamp;
  readonly tableId: TableId;
  readonly heldForTicketId: TicketId;
}

/** 「あと 2 分で呼び出しが無効になります」を出す時刻になった（全体プラン 7.7 の 3）。 */
export interface TicketReminded {
  readonly type: 'TicketReminded';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  readonly tableId: TableId;
  readonly holdDeadline: Timestamp;
}

/**
 * 期限を延ばした（全体プラン 7.7 の 4、7 の 7）。
 *
 * ホールドの延長（「向かっています」）と保留の延長（「まだ待っています」）の
 * 両方で出る。`from` がどちらかを語る。
 */
export interface TicketExtended {
  readonly type: 'TicketExtended';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  /** どちらの期限を延ばしたか。 */
  readonly from: 'CALLED' | 'PAUSED';
  readonly deadline: Timestamp;
}

/** なぜ保留になったか。利用者への通知の文面と、統計に使う。 */
export const PAUSE_REASONS = ['user_pause', 'passed', 'no_show'] as const;

export type PauseReason = (typeof PAUSE_REASONS)[number];

/** 保留に入った（全体プラン 7.7 の 5〜7）。 */
export interface TicketPaused {
  readonly type: 'TicketPaused';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  /** この時刻を過ぎて操作が無ければ期限切れになる。画面の残り時間の元になる。 */
  readonly until: Timestamp;
  readonly reason: PauseReason;
}

/** 「準備OK」で待ちに戻った（全体プラン 7.7 の 6）。 */
export interface TicketResumed {
  readonly type: 'TicketResumed';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
}

/** なぜ待ちへ戻ったか。順番の扱いが逆になるので、必ず区別する。 */
export const REQUEUE_REASONS = ['no_show', 'seat_taken'] as const;

export type RequeueReason = (typeof REQUEUE_REASONS)[number];

/**
 * 保留を挟まずに待ちへ戻った。
 *
 * | 理由 | 出典 | 順番 |
 * |---|---|---|
 * | `no_show` | 7.7 の 6 の `requeue_back` | **末尾へ**。受付時刻をやり直す |
 * | `seat_taken` | 7.8 の 10 行目、7.11 の 3 層目 | **先頭へ**。受付時刻を保ち、さらに繰り上げる |
 *
 * 同じ「待ちへ戻る」でも向きが正反対なので、`priorityAt` だけでなく理由も
 * 持たせてある。案内した側の落ち度で戻った人を、遅れた人と同じに扱わない。
 */
export interface TicketRequeued {
  readonly type: 'TicketRequeued';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  readonly priorityAt: Timestamp;
  readonly reason: RequeueReason;
}

/**
 * 案内する席を変えた（全体プラン 7.8 の 2 行目）。
 *
 * 呼び出しは続いたまま、席だけが移る。**期限は動かさない。** すでにその席の
 * 前に立っている人が、さらに時間を得る理由が無いためである。
 */
export interface TicketSwapped {
  readonly type: 'TicketSwapped';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  readonly fromTableId: TableId;
  readonly toTableId: TableId;
}

/**
 * 席が「使用中」と報告された（全体プラン 7.8 の 10 行目、7.11 の 3 層目）。
 *
 * 案内された席に誰かが座っていた場合と、「空いている可能性が高い席」が
 * 実際には使われていた場合の両方で出る。誰が使っているかは分からない。
 */
export interface TableReportedInUse {
  readonly type: 'TableReportedInUse';
  readonly at: Timestamp;
  readonly tableId: TableId;
  /** 報告した人。第三者やスタッフからの報告なら `null`。 */
  readonly reportedByTicketId: TicketId | null;
}

/** 着席した（全体プラン 7.8 の 1 行目）。 */
export interface TicketSeated {
  readonly type: 'TicketSeated';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  readonly tableId: TableId;
}

/** 席に人が着いた。 */
export interface TableOccupied {
  readonly type: 'TableOccupied';
  readonly at: Timestamp;
  readonly tableId: TableId;
  readonly occupantTicketId: TicketId;
}

/**
 * 席が使い終わった（全体プラン 7.6 の片付けの猶予）。
 *
 * まだ空席ではない。`freeAt` を過ぎると `TableFreed` が出て次の人に渡る。
 * 猶予が 0 分の施設では、同じ処理のうちに両方が出る。
 */
export interface TableVacated {
  readonly type: 'TableVacated';
  readonly at: Timestamp;
  readonly tableId: TableId;
  readonly vacatedByTicketId: TicketId;
  readonly freeAt: Timestamp;
}

/**
 * 着席時間の目安に達した（全体プラン 7.10）。
 *
 * 「目安時間になりました。次の方のためにご協力をお願いします」を出すための
 * 合図。**席はまだ動かない。** 猶予（`overstayGraceMin`）を過ぎてから
 * `TableNeedsCheck` になる。
 */
export interface TimeLimitReached {
  readonly type: 'TimeLimitReached';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  readonly tableId: TableId;
  /** いま何組が待っているか。「現在 3 組がお待ちです」に使う。 */
  readonly waitingCount: number;
}

/**
 * 「まだご利用中ですか」を出した（全体プラン 7.11 の 2 層目）。
 *
 * 退席ボタンの押し忘れを拾うための問いかけ。**1 人につき 1 回だけ出す。**
 * 答えが無いまま `stillHereTimeoutMin` が過ぎると、席は「確認要」になる。
 */
export interface StillHereAsked {
  readonly type: 'StillHereAsked';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  readonly tableId: TableId;
  readonly answerBy: Timestamp;
}

/** 「まだご利用中ですか」に答えた。 */
export interface StillHereAnswered {
  readonly type: 'StillHereAnswered';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  readonly tableId: TableId;
}

/** なぜ席が「確認要」になったか。スタッフ画面の並べ方と統計に使う。 */
export const NEEDS_CHECK_REASONS = ['overstay', 'no_answer', 'unknown_aged'] as const;

export type NeedsCheckReason = (typeof NEEDS_CHECK_REASONS)[number];

/**
 * 席が「たぶん空いているが確証がない」になった（全体プラン 7.10、7.11）。
 *
 * | 理由 | いつ |
 * |---|---|
 * | `overstay` | 着席時間の上限と猶予を過ぎた（7.10） |
 * | `no_answer` | 「まだご利用中ですか」に答えが無かった（7.11 の 2 層目） |
 * | `unknown_aged` | 無断利用の想定滞在時間が過ぎた（7.11 の 5 層目） |
 */
export interface TableNeedsCheck {
  readonly type: 'TableNeedsCheck';
  readonly at: Timestamp;
  readonly tableId: TableId;
  readonly reason: NeedsCheckReason;
  /** まだ着席中のチケットが結びついていれば、その ID。 */
  readonly occupantTicketId: TicketId | null;
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
 * チケットが終わった。**終わり方によらず、このイベント 1 つで表す。**
 *
 * `by` と `cancelReason` は、人の操作で終わったときだけ埋まる。時刻が来て
 * 終わったもの（ノーショー・保留の期限切れ・絶対上限・放置）では `null`。
 */
export interface TicketEnded {
  readonly type: 'TicketEnded';
  readonly at: Timestamp;
  readonly ticketId: TicketId;
  readonly endReason: EndReason;
  readonly by: Actor | null;
  readonly cancelReason: CancelReason | null;
}

/**
 * 席が空いた。**次の人に案内できる状態になったことを表す。**
 *
 * 取り消し・パス・ノーショーで確保が解けたときと、片付けの猶予が明けたときに出る。
 * 後者では解ける確保が無いので `releasedTicketId` は `null` になる。
 */
export interface TableFreed {
  readonly type: 'TableFreed';
  readonly at: Timestamp;
  readonly tableId: TableId;
  /** 誰の確保が解けたか。片付けの猶予が明けた場合は `null`。 */
  readonly releasedTicketId: TicketId | null;
}

/**
 * 席が管理対象から外れた。
 *
 * 対象外にする操作が保留されていた席が利用の終了とともに外れたとき（7.6）、
 * 運用が終わったとき、全席解放のとき（7.14、7.9）に出る。
 */
export interface TableDisabled {
  readonly type: 'TableDisabled';
  readonly at: Timestamp;
  readonly tableId: TableId;
}

// ---- 施設の開閉（全体プラン 7.14、7.9） ----

/** なぜ運用が終わったか。 */
export const CLOSE_REASONS = ['schedule', 'manual', 'release_all'] as const;

export type CloseReason = (typeof CLOSE_REASONS)[number];

/**
 * 運用が始まった。
 *
 * `closesAt` はこの営業回が終わる時刻（`null` なら手動で閉じるまで続く）。
 * 画面はこれを見て「本日の運用は 14:30 まで」を出せる。
 */
export interface VenueOpened {
  readonly type: 'VenueOpened';
  readonly at: Timestamp;
  readonly closesAt: Timestamp | null;
}

/**
 * 新規の受付を止めた（全体プラン 7.14 の `join_cutoff_before_close_min`）。
 *
 * 運用は続いている。**すでに並んでいる人はそのまま案内される。**
 */
export interface JoinClosed {
  readonly type: 'JoinClosed';
  readonly at: Timestamp;
  /** この時刻に運用が終わる。 */
  readonly closesAt: Timestamp;
}

/**
 * 運用が終わった。
 *
 * **誰が取り消されたかはここに載せない。** それぞれ `TicketEnded`
 * （`endReason` は `venue_closed`）として出ており、二重に持つと片方だけが
 * 正しい状態を作ってしまう。数えたい側はそちらを読む。
 */
export interface VenueClosed {
  readonly type: 'VenueClosed';
  readonly at: Timestamp;
  readonly reason: CloseReason;
}

export type DomainEvent =
  | TicketJoined
  | TicketCalled
  | TableHeld
  | TicketReminded
  | TicketExtended
  | TicketPaused
  | TicketResumed
  | TicketRequeued
  | TicketSwapped
  | TableReportedInUse
  | TimeLimitReached
  | StillHereAsked
  | StillHereAnswered
  | TableNeedsCheck
  | TicketSeated
  | TableOccupied
  | TableVacated
  | PartySizeChanged
  | TicketEnded
  | TableFreed
  | TableDisabled
  | VenueOpened
  | JoinClosed
  | VenueClosed;

export type DomainEventType = DomainEvent['type'];

/**
 * この版が発行するイベントの種別。
 *
 * 種別を足したときに、どこかに書き忘れていないかを照合するために使う。
 */
export const DOMAIN_EVENT_TYPES = [
  'TicketJoined',
  'TicketCalled',
  'TableHeld',
  'TicketReminded',
  'TicketExtended',
  'TicketPaused',
  'TicketResumed',
  'TicketRequeued',
  'TicketSwapped',
  'TableReportedInUse',
  'TimeLimitReached',
  'StillHereAsked',
  'StillHereAnswered',
  'TableNeedsCheck',
  'TicketSeated',
  'TableOccupied',
  'TableVacated',
  'PartySizeChanged',
  'TicketEnded',
  'TableFreed',
  'TableDisabled',
  'VenueOpened',
  'JoinClosed',
  'VenueClosed',
] as const satisfies readonly DomainEventType[];

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
 * コマンドは PR ごとに増える。この版（PR 7）で **受付から退席までの一周が閉じた**。
 * 残るのは座席 QR の分岐（PR 9）、整合性の回復（PR 10）、運用時間帯（PR 11）。
 *
 * **呼び出し（`CALL`）はコマンドに無い。** 誰をいつ呼ぶかは施設が決めることでは
 * なく、空席と待ちの状況から決まる。`apply` と `tick` が最後に必ず割当を実行する
 * （`allocate.ts`）。
 */

import type { TableId, Tag, TicketId } from '../domain/ids.js';
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

/**
 * 誰が退席を申告したかと、記録される終わり方の対応。
 *
 * スタッフの申告に理由は求めない。取り消し（7.9）と違い、席を空けることは
 * 利用者の不利益にならず、監査で問われるのは「誰が」だけである。
 */
export const CHECKOUT_END_REASONS = {
  user: 'checked_out',
  staff: 'staff_checkout',
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

/**
 * 期限の延長（全体プラン 7.7 の 4、7 の 7）。
 *
 * 呼び出し中は「向かっています」、保留中は「まだ待っています」にあたる。
 * **利用者から見れば同じ「延長」なので、1 つのコマンドにしてある。** どちらの
 * 期限を延ばすかは、いまの状態が決める（遷移表に `CALLED → CALLED` と
 * `PAUSED → PAUSED` の 2 本がある）。
 */
export interface ExtendCommand {
  readonly type: 'EXTEND';
  readonly ticketId: TicketId;
}

/**
 * 呼び出しを次の人へ譲る（全体プラン 7.7 の 5）。
 *
 * まだ料理を待っているときに使う。席は即座に空席へ戻り、本人は順番を保ったまま
 * 保留になる。「準備OK」で待ちに戻れる。
 */
export interface PassCommand {
  readonly type: 'PASS';
  readonly ticketId: TicketId;
}

/**
 * 着席の確認（全体プラン 7.8 の 1 行目）。
 *
 * 座席 QR を読むか、卓上の 4 桁コードを入力すると出る。**「その席にいる証拠」
 * を求めるのは着席確認だけ**で、退席は画面のボタンだけで済ませる（7.8 の末尾）。
 *
 * `tableId` は読み取った席。トークンから ID への解決は境界側の責務で、
 * `core` は解決済みの ID を受け取る。自分の席かどうかは `isAssignedTable` が見る。
 */
export interface CheckInCommand {
  readonly type: 'CHECK_IN';
  readonly ticketId: TicketId;
  readonly tableId: TableId;
}

/**
 * 退席の申告（全体プラン 7.8、7.11 の 1 層目）。
 *
 * **席の読み取りを求めない。** 手間を減らすほど申告率が上がり、退席を偽る動機は
 * 無いためである。スタッフが代わりに申告することもできる。
 */
export interface CheckOutCommand {
  readonly type: 'CHECK_OUT';
  readonly ticketId: TicketId;
  readonly by: Actor;
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
  | ExtendCommand
  | PassCommand
  | CheckInCommand
  | CheckOutCommand
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
  'EXTEND',
  'PASS',
  'CHECK_IN',
  'CHECK_OUT',
  'CHANGE_PARTY_SIZE',
  'HEARTBEAT',
] as const satisfies readonly CommandType[];

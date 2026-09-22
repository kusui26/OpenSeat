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
 * **Phase 1 の語彙はここで出そろっている。** 利用者の操作（受付・保留・延長・
 * 着席・退席・報告）と、スタッフと管理者の操作（運用の開始と終了・全席解放・
 * 席の設定）で 22 種類。誰がどれを出せるかという権限の判定は、実行者の概念を
 * 持つ Phase 2 の権限表が受け持つ（CLAUDE.md 3.2 の 4）。
 *
 * 座席 QR を読んだ人に何を見せ、どの操作を出すかは `scan/resolve.ts` が決める
 * （全体プラン 7.8 の分岐表）。
 *
 * **呼び出し（`CALL`）はコマンドに無い。** 誰をいつ呼ぶかは施設が決めることでは
 * なく、空席と待ちの状況から決まる。`apply` と `tick` が最後に必ず割当を実行する
 * （`allocate.ts`）。
 */

import type { Side } from '../domain/actor.js';
import type { TableId, Tag, TicketId } from '../domain/ids.js';
import type { EndReason } from '../domain/ticket.js';
import type { Timestamp } from '../time.js';

/**
 * その操作を、どちら側が行ったか。**宣言は [`domain/actor.ts`](../domain/actor.ts)** に
 * ある。役割（誰か）との違いも、そちらに書いてある。
 */
export type { Side } from '../domain/actor.js';

/**
 * キャンセルの理由（全体プラン 7.9）。統計に使う。
 *
 * 利用者には任意選択で出す。スタッフの操作では必須にする（監査のため）。
 */
export const CANCEL_REASONS = ['found_seat', 'leaving', 'too_long', 'other'] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

/**
 * どちら側が取り消したかと、記録される終わり方の対応。
 *
 * 分岐ではなく表として宣言する。側を足したときに、どの終わり方で記録するかを
 * 必ず決めさせるため（CLAUDE.md 3.2）。
 */
export const CANCEL_END_REASONS = {
  user: 'user_cancel',
  staff: 'staff_cancel',
} as const satisfies Record<Side, EndReason>;

/**
 * 誰が退席を申告したかと、記録される終わり方の対応。
 *
 * スタッフの申告に理由は求めない。取り消し（7.9）と違い、席を空けることは
 * 利用者の不利益にならず、監査で問われるのは「誰が」だけである。
 */
export const CHECKOUT_END_REASONS = {
  user: 'checked_out',
  staff: 'staff_checkout',
} as const satisfies Record<Side, EndReason>;

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
  readonly by: Side;
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
  readonly by: Side;
}

/**
 * 席の変更（全体プラン 7.8 の 2 行目）。
 *
 * 呼び出された人が、案内された席とは別の空席の QR を読んだとき。
 * `allowTableSwap`（既定 ON）が立っていて、その席に人数が収まるなら移れる。
 * 元の席は空席に戻り、次の人へ渡る。
 */
export interface SwapTableCommand {
  readonly type: 'SWAP_TABLE';
  readonly ticketId: TicketId;
  readonly tableId: TableId;
}

/**
 * 前倒しの着席（全体プラン 7.8 の 4 行目）。
 *
 * 待っている人が空席の QR を読んだとき。**待ち順序を崩さない条件つき**で、
 * 呼び出しを待たずに座れる。条件は `earlyCheckInAllowed` が見る。
 */
export interface CheckInEarlyCommand {
  readonly type: 'CHECK_IN_EARLY';
  readonly ticketId: TicketId;
  readonly tableId: TableId;
}

/**
 * 飛び込み着席（全体プラン 7.12、7.8 の 6 行目）。
 *
 * チケットを持たない人が、待ちのいない空席の QR を読んで人数を入れたとき。
 * **登録を経ずにチケットが作られ、いきなり `SEATED` から始まる。**
 * これで (a) 待ちがない時間帯でも占有状況が正確になり、(b) 登録した人が
 * 守られ、(c)「待ちがいるのに席が空いている」矛盾がなくなる（7.12）。
 */
export interface WalkInCommand {
  readonly type: 'WALK_IN';
  readonly ticketId: TicketId;
  readonly tableId: TableId;
  readonly partySize: number;
}

/**
 * 案内された席に誰かが座っていた（全体プラン 7.8 の 10 行目）。
 *
 * 席は「誰かが使っているが誰かは分からない」状態になり、本人は待ちに戻る。
 * **受付時刻はそのまま**で、さらに同時刻の他者より前に出る（`conflictPriority`）。
 * 案内した側の落ち度なので、順番で埋め合わせる。
 */
export interface ReportTakenCommand {
  readonly type: 'REPORT_TAKEN';
  readonly ticketId: TicketId;
  readonly tableId: TableId;
}

/**
 * この席は使用中だ、という報告（全体プラン 7.11 の 3 層目、7.4）。
 *
 * 「空いている可能性が高い席」（`NEEDS_CHECK`）に案内された人が押す
 * 「使用中」がこれにあたる。第三者やスタッフからの報告でも使う。
 *
 * `ticketId` がある場合、その人は席が塞がっていた人として扱われ、
 * 次の席へ最優先で案内される（`REPORT_TAKEN` と同じ埋め合わせ）。
 */
export interface ReportInUseCommand {
  readonly type: 'REPORT_IN_USE';
  readonly tableId: TableId;
  readonly ticketId: TicketId | null;
}

/**
 * この席は空いている、という報告（全体プラン 7.8 の 9 行目、7.11 の 3〜4 層目）。
 *
 * 「使用中」と記録されている席が実際には空だったときに押す。
 * **誰が座っているか分かっている席（`OCCUPIED`）には使えない。** 遷移表に
 * 宣言が無く、第三者が着席中の人を追い出せないようにしてある。
 *
 * **「確認要」に落ちた席でも、着席の記録が残っているならスタッフだけが押せる**
 * （7.11 の 3 層目）。その記録の人のチケットを終わらせる操作だからである。
 * 記録の無い席は誰でも押せる。
 */
export interface ConfirmFreeCommand {
  readonly type: 'CONFIRM_FREE';
  readonly tableId: TableId;
  readonly by: Side;
}

/**
 * 「まだご利用中です」（全体プラン 7.11 の 2 層目、7.8 の 5 行目）。
 *
 * 問いかけへの答え。**答えたことを記録するだけで、利用は続く。** 席が
 * すでに「確認要」に落ちていれば、使用中に戻す。
 */
export interface StillHereCommand {
  readonly type: 'STILL_HERE';
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

// ---- 施設の操作（全体プラン 7.14、7.9） ----

/**
 * 運用の開始（全体プラン 7.14）。
 *
 * 対象席を自由席から取り戻し、受付を開く。スケジュールによる開始も、スタッフの
 * 手動 ON も、どちらもこのコマンドで表す。**どちらが優先かは呼ぶ側が決める**
 * （7.14「スタッフの手動 ON/OFF を優先させる」）。core から見れば同じ操作である。
 *
 * `closesAt` は **この営業回が終わる時刻**。曜日と時間帯の設定（`managed_schedule`）を
 * 施設のタイムゾーンで評価するのは境界側の責務で（9.4）、`schedule.ts` の
 * `closesAtOf()` がその計算を提供する。`null` を渡すと運用終了を持たない
 * （スタッフが手動で閉じるまで続く）。
 */
export interface OpenCommand {
  readonly type: 'OPEN';
  readonly closesAt: Timestamp | null;
  readonly by: Side;
}

/**
 * 運用の終了（全体プラン 7.14）。
 *
 * 待っている人（`WAITING` / `PAUSED`）を施設都合で取り消し、使っていない席を
 * 対象外に戻す。**席を確保した人（`CALLED`）と着席中の人（`SEATED`）はそのまま**
 * で、その席は現在の利用が終わってから外れる（`disableAfterCurrent`、7.4）。
 *
 * 時間が来て終わる場合は `tick` が同じ手続きを踏む。これはスタッフが手で
 * 閉じるときの入口である。
 */
export interface CloseCommand {
  readonly type: 'CLOSE';
  readonly by: Side;
}

/**
 * 全席解放（全体プラン 7.9 の「施設都合」、12.6）。
 *
 * **緊急時にすべてを自由席へ戻す操作。** 生きているチケットをすべて終わらせ、
 * すべての席を対象外にする。着席中の人も対象になるが、着席した分は利用として
 * 扱う（`DONE`）。
 *
 * **この操作はいつでも動かなければならない**（CLAUDE.md 8 章）。障害時に掲示を
 * 出して自由席へ戻す手順が、システムの復旧より優先される。
 */
export interface ReleaseAllCommand {
  readonly type: 'RELEASE_ALL';
  readonly by: Side;
}

/**
 * 席を対象から外す（全体プラン 7.6 のエッジケース）。
 *
 * **いま使われている席なら、現在の利用が終わってから外れる**（`disableAfterCurrent`）。
 * 空いている席はその場で外れる。呼び出し中の人を追い出さないための順序である。
 */
export interface DisableTableCommand {
  readonly type: 'DISABLE_TABLE';
  readonly tableId: TableId;
  readonly by: Side;
}

/**
 * 席を対象に戻す（全体プラン 7.6 のエッジケース）。
 *
 * 外す操作の裏返し。外れるのを待っている予約も取り消す。運用中なら、その場で
 * 空席として使えるようになる。
 */
export interface EnableTableCommand {
  readonly type: 'ENABLE_TABLE';
  readonly tableId: TableId;
  readonly by: Side;
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
  | SwapTableCommand
  | CheckInEarlyCommand
  | WalkInCommand
  | ReportTakenCommand
  | ReportInUseCommand
  | ConfirmFreeCommand
  | StillHereCommand
  | ChangePartySizeCommand
  | HeartbeatCommand
  | OpenCommand
  | CloseCommand
  | ReleaseAllCommand
  | DisableTableCommand
  | EnableTableCommand;

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
  'SWAP_TABLE',
  'CHECK_IN_EARLY',
  'WALK_IN',
  'REPORT_TAKEN',
  'REPORT_IN_USE',
  'CONFIRM_FREE',
  'STILL_HERE',
  'CHANGE_PARTY_SIZE',
  'HEARTBEAT',
  'OPEN',
  'CLOSE',
  'RELEASE_ALL',
  'DISABLE_TABLE',
  'ENABLE_TABLE',
] as const satisfies readonly CommandType[];

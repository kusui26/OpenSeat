/**
 * 文言の鍵と、その穴の宣言。
 *
 * **文字列そのものはここに無い。** ここにあるのは「どんな文言があって、どんな穴が
 * 空いているか」だけである。中身は言語ごとの束（`ja.ts`）にある。
 *
 * **Phase 2 で書くのは日本語だけである**（11.5）。英語は Phase 3 だが、**そのとき
 * 足すのは文字列だけ**で、この宣言も呼ぶ側も変わらない。
 *
 * ## 穴と引数は、ずれない
 *
 * 文言の `{code}` と、ここに宣言した引数は **`i18n.test.ts` が突き合わせる**。
 * 片方だけ直すと落ちる。**穴が埋まらないまま利用者に出る**のがいちばん困るので、
 * そこを機械に見てもらう。
 */

import type { TableScanKind } from '@openseat/core';

/**
 * 文言の鍵と、その文言が受け取る引数。
 *
 * 引数の名前は文言の中の `{...}` と一致させる。並びは関係ない。
 */
export const MESSAGES = {
  // ---- 通知（17.3） ----
  'notify.joined': ['code', 'ahead', 'etaFrom', 'etaTo'],
  'notify.called': ['table', 'capacity', 'holdMin'],
  'notify.remind': ['minutes', 'extendMin'],
  'notify.noShowFirst': [],
  'notify.conflict': [],
  'notify.timeLimitSoon': ['limitMin', 'waiting'],
  'notify.stillHere': [],
  'notify.checkedOut': [],

  // ---- 座席 QR の分岐（7.8 の 63 通りを 15 の見せ方にまとめたもの） ----
  'scan.check_in': ['table'],
  'scan.swap_offer': ['table', 'assigned'],
  'scan.other_table': ['table', 'assigned'],
  'scan.early_check_in': ['table'],
  'scan.keep_waiting': ['ahead'],
  'scan.resume_first': [],
  'scan.seated_here': ['table'],
  'scan.seated_elsewhere': ['assigned'],
  'scan.walk_in_offer': ['table', 'capacity'],
  'scan.queue_first': ['waiting'],
  'scan.held_for_other': [],
  'scan.in_use': [],
  'scan.needs_check': [],
  'scan.turnover': [],
  'scan.not_managed': [],

  // ---- 画面の骨組み ----
  'venue.closed': [],
  'venue.joinClosed': [],
  'ticket.staleCall': [],
  'ticket.longWaitConfirm': ['minutes'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type MessageKey = keyof typeof MESSAGES;

/** その文言が要る引数。**穴が無い文言には `{}` を渡す。** */
export type ParamsOf<K extends MessageKey> = Readonly<
  Record<(typeof MESSAGES)[K][number], string | number>
>;

/**
 * 座席 QR の分岐 1 つずつに、見せる文言。
 *
 * **`core` の `TableScanKind` を漏れなく覆う。** 15 通りのうち 1 つでも文言が
 * 無ければ、ここが型エラーになる（画面が黙るより先に、編集中に気づく）。
 * 値のほうも `MessageKey` なので、綴り違いも落ちる。
 */
export const SCAN_MESSAGE_KEYS = {
  check_in: 'scan.check_in',
  swap_offer: 'scan.swap_offer',
  other_table: 'scan.other_table',
  early_check_in: 'scan.early_check_in',
  keep_waiting: 'scan.keep_waiting',
  resume_first: 'scan.resume_first',
  seated_here: 'scan.seated_here',
  seated_elsewhere: 'scan.seated_elsewhere',
  walk_in_offer: 'scan.walk_in_offer',
  queue_first: 'scan.queue_first',
  held_for_other: 'scan.held_for_other',
  in_use: 'scan.in_use',
  needs_check: 'scan.needs_check',
  turnover: 'scan.turnover',
  not_managed: 'scan.not_managed',
} as const satisfies Readonly<Record<TableScanKind, MessageKey>>;

/**
 * 開発プラン 17.3 の「通知文言の例」9 行と、実際の鍵の対応。
 *
 * **1 行でも文言が無いと、その場面で利用者に何も伝わらない。** 突き合わせは
 * `i18n.test.ts` が見ている。
 *
 * 「別の席に来た」だけは通知ではなく**座席 QR を読んだ画面**に出る。読んだ本人に
 * その場で見せるもので、通知として飛ばす相手がいないためである。
 */
export const PLAN_NOTIFICATIONS = {
  受付完了: 'notify.joined',
  呼び出し: 'notify.called',
  リマインド: 'notify.remind',
  '期限切れ（1 回目）': 'notify.noShowFirst',
  別の席に来た: 'scan.other_table',
  席が塞がっていた: 'notify.conflict',
  '上限 10 分前': 'notify.timeLimitSoon',
  'まだ利用中？': 'notify.stillHere',
  退席: 'notify.checkedOut',
} as const satisfies Readonly<Record<string, MessageKey>>;

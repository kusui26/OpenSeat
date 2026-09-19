/**
 * チケットの状態機械（全体プラン 7.3）。
 *
 * 7.3 の状態遷移図を、コードの分岐ではなくデータの表として宣言する。
 * 各行の `source` が全体プランのどの節に由来するかを示す。**この表が仕様との
 * 照合点である。**
 *
 * ガードは名前だけを宣言し、判定の実装は振る舞いの PR（5 以降）で埋める。
 * 宣言されたガードがすべて実装されていることは PR 12 で閉じる。
 */

import { ACTIVE_TICKET_STATES, type TicketState } from '../domain/ticket.js';
import type { Transition } from './transit.js';

/**
 * チケットに起きる事象。
 *
 * 利用者やスタッフの操作（`CANCEL`、`CHECK_IN`）と、時刻が来たことで起きるもの
 * （`HOLD_EXPIRE`、`MAX_AGE`）の両方を含む。後者は `tick` が発火させる。
 */
export const TICKET_EVENTS = [
  'CALL',
  'CHECK_IN',
  'CHECK_IN_EARLY',
  'SWAP_TABLE',
  'EXTEND',
  'PASS',
  'HOLD_EXPIRE',
  'REPORT_TAKEN',
  'PAUSE',
  'READY',
  'PAUSE_EXPIRE',
  'MAX_AGE',
  'ABANDON',
  'CANCEL',
  'CHECK_OUT',
  'AUTO_RELEASE',
  'SEAT_RECLAIMED',
  'STILL_HERE',
  'VENUE_RELEASE',
] as const;

export type TicketEvent = (typeof TICKET_EVENTS)[number];

/**
 * 遷移の条件。名前だけを宣言する。
 *
 * | ガード | 成立する条件 |
 * |---|---|
 * | `fitsCapacity` | 割り当てようとする席の定員に人数が収まり、希望タグを満たす |
 * | `isAssignedTable` | 読み取った席が、自分に割り当てられた席である |
 * | `earlyCheckInAllowed` | 席が空いていて人数が収まり、その席を待つ人が他にいない |
 * | `swapAllowed` | `allowTableSwap` が真で、移動先が空席かつ人数が収まる |
 * | `underExtensionLimit` | 延長の回数が `maxExtensions` 未満 |
 * | `requeueOnNoShow` | `noShowPolicy` が `requeue_once` で、期限切れが 1 回目 |
 * | `requeueToBackOnNoShow` | `noShowPolicy` が `requeue_back` |
 * | `finalNoShow` | `noShowPolicy` が `cancel`、または `requeue_once` の 2 回目 |
 * | `noNotificationChannel` | 通知手段を持っていない（接続が切れてからの時間は期限が見る） |
 * | `hardLimitMode` | `timeLimitMode` が `hard` |
 */
export const TICKET_GUARDS = [
  'fitsCapacity',
  'isAssignedTable',
  'earlyCheckInAllowed',
  'swapAllowed',
  'underExtensionLimit',
  'requeueOnNoShow',
  'requeueToBackOnNoShow',
  'finalNoShow',
  'noNotificationChannel',
  'hardLimitMode',
] as const;

export type TicketGuard = (typeof TICKET_GUARDS)[number];

export type TicketTransition = Transition<TicketState, TicketEvent, TicketGuard>;

/**
 * チケットが生まれるときの状態。
 *
 * 生成は状態間の遷移ではないので表には入れず、ここで宣言する。
 * 到達可能性の検査はこの 2 つを出発点にする。
 */
export const TICKET_INITIAL_STATES = {
  /** 入口の受付 QR から順番待ちに入る（7.5）。 */
  JOIN: 'WAITING',
  /** 空席の座席 QR から、待たずに直接着席する（7.12）。 */
  WALK_IN: 'SEATED',
} as const satisfies Readonly<Record<string, TicketState>>;

/** チケットがどこから生まれたか。 */
export type TicketOrigin = keyof typeof TICKET_INITIAL_STATES;

/**
 * 全体プラン 7.3 の状態遷移図の全矢印。
 *
 * 表に無い（状態、事象）の組み合わせは起こせない。
 */
export const TICKET_TRANSITIONS = [
  // ---- WAITING（順番待ち中） ----
  {
    from: 'WAITING',
    on: 'CALL',
    to: 'CALLED',
    guard: 'fitsCapacity',
    source: '7.6',
    note: '空席が出て割り当てられた',
  },
  {
    from: 'WAITING',
    on: 'CHECK_IN_EARLY',
    to: 'SEATED',
    guard: 'earlyCheckInAllowed',
    source: '7.8',
    note: '空席の座席 QR を読み、待ち順序を崩さない条件で前倒し着席した',
  },
  {
    from: 'WAITING',
    on: 'PAUSE',
    to: 'PAUSED',
    guard: null,
    source: '7.7',
    note: '料理待ちなどで呼び出しを保留にした',
  },
  {
    from: 'WAITING',
    on: 'CANCEL',
    to: 'CANCELLED',
    guard: null,
    source: '7.9',
    note: '本人またはスタッフが取り消した',
  },
  {
    from: 'WAITING',
    on: 'VENUE_RELEASE',
    to: 'CANCELLED',
    guard: null,
    source: '7.9',
    note: '施設都合の全席解放',
  },
  {
    from: 'WAITING',
    on: 'ABANDON',
    to: 'EXPIRED',
    guard: 'noNotificationChannel',
    source: '7.9',
    note: '通知手段が無いまま、画面の接続が途絶えて放置の期限が過ぎた',
  },
  {
    from: 'WAITING',
    on: 'MAX_AGE',
    to: 'EXPIRED',
    guard: null,
    source: '7.7',
    note: '受付からの絶対上限を超えた（幽霊チケットの防止）',
  },

  // ---- PAUSED（保留中。順番は保持している） ----
  {
    from: 'PAUSED',
    on: 'READY',
    to: 'WAITING',
    guard: null,
    source: '7.7',
    note: '「準備OK」で呼び出しの対象に戻った',
  },
  {
    from: 'PAUSED',
    on: 'EXTEND',
    to: 'PAUSED',
    guard: null,
    source: '7.7',
    note: '「まだ待っていますか」に応えて保留の期限を延ばした。合計の上限までしか延びない',
  },
  {
    from: 'PAUSED',
    on: 'CANCEL',
    to: 'CANCELLED',
    guard: null,
    source: '7.9',
    note: '本人またはスタッフが取り消した',
  },
  {
    from: 'PAUSED',
    on: 'VENUE_RELEASE',
    to: 'CANCELLED',
    guard: null,
    source: '7.9',
    note: '施設都合の全席解放',
  },
  {
    from: 'PAUSED',
    on: 'PAUSE_EXPIRE',
    to: 'EXPIRED',
    guard: null,
    source: '7.7',
    note: '保留の上限を超え、延長の操作も無かった',
  },
  {
    from: 'PAUSED',
    on: 'MAX_AGE',
    to: 'EXPIRED',
    guard: null,
    source: '7.7',
    note: '受付からの絶対上限を超えた',
  },

  // ---- CALLED（席が確保されている） ----
  {
    from: 'CALLED',
    on: 'CHECK_IN',
    to: 'SEATED',
    guard: 'isAssignedTable',
    source: '7.8',
    note: '割り当てられた席の QR を読んで着席した',
  },
  {
    from: 'CALLED',
    on: 'EXTEND',
    to: 'CALLED',
    guard: 'underExtensionLimit',
    source: '7.7',
    note: '「向かっています」を押してホールドを延長した',
  },
  {
    from: 'CALLED',
    on: 'SWAP_TABLE',
    to: 'CALLED',
    guard: 'swapAllowed',
    source: '7.8',
    note: '別の空席の QR を読み、そちらへ席を変更した',
  },
  {
    from: 'CALLED',
    on: 'PASS',
    to: 'PAUSED',
    guard: null,
    source: '7.7',
    note: 'まだ行けないので次の人に譲った。順番は保持される',
  },
  {
    from: 'CALLED',
    on: 'HOLD_EXPIRE',
    to: 'PAUSED',
    guard: 'requeueOnNoShow',
    source: '7.7',
    note: 'ホールドの期限切れ 1 回目。順番を保持したまま保留に戻す',
  },
  {
    from: 'CALLED',
    on: 'HOLD_EXPIRE',
    to: 'WAITING',
    guard: 'requeueToBackOnNoShow',
    source: '7.7',
    note: 'ホールドの期限切れ。緩い設定では順番を末尾に戻す',
  },
  {
    from: 'CALLED',
    on: 'HOLD_EXPIRE',
    to: 'NO_SHOW',
    guard: 'finalNoShow',
    source: '7.7',
    note: 'ホールドの期限切れ。厳しい設定、または 2 回目で終了',
  },
  {
    from: 'CALLED',
    on: 'REPORT_TAKEN',
    to: 'WAITING',
    guard: null,
    source: '7.8',
    note: '案内された席に誰かが座っていた。最優先で次の席へ',
  },
  {
    from: 'CALLED',
    on: 'CANCEL',
    to: 'CANCELLED',
    guard: null,
    source: '7.9',
    note: '本人またはスタッフが取り消した',
  },
  {
    from: 'CALLED',
    on: 'VENUE_RELEASE',
    to: 'CANCELLED',
    guard: null,
    source: '7.9',
    note: '施設都合の全席解放',
  },

  // ---- SEATED（着席中） ----
  {
    from: 'SEATED',
    on: 'CHECK_OUT',
    to: 'DONE',
    guard: null,
    source: '7.8',
    note: '本人またはスタッフが退席を申告した',
  },
  {
    from: 'SEATED',
    on: 'AUTO_RELEASE',
    to: 'DONE',
    guard: 'hardLimitMode',
    source: '7.10',
    note: '着席時間の上限を超え、hard モードで自動的に終了した',
  },
  {
    from: 'SEATED',
    on: 'SEAT_RECLAIMED',
    to: 'DONE',
    guard: null,
    source: '7.11',
    note: '確認要のまま時間が過ぎ、席が空席に戻された。申告せずに去ったものとして扱う',
  },
  {
    from: 'SEATED',
    on: 'STILL_HERE',
    to: 'SEATED',
    guard: null,
    source: '7.11',
    note: '「まだご利用中ですか」に答えた。利用は続く',
  },
  {
    from: 'SEATED',
    on: 'VENUE_RELEASE',
    to: 'DONE',
    guard: null,
    source: '7.9',
    note: '施設都合の全席解放。着席していた分は利用として扱う',
  },
] as const satisfies readonly TicketTransition[];

/**
 * `CALLED` から `MAX_AGE` の遷移を意図的に置いていない。
 *
 * 受付からの絶対上限（`ticketMaxAgeMin`）は幽霊チケットを防ぐためのもので、
 * 呼び出しに至っていない人を対象にする。すでに席が確保されている人を上限で
 * 打ち切ると、確保した席を無駄にしたうえで利用者にも不親切になる。呼び出し後は
 * ホールドの期限（最長でも `holdMin + holdExtensionMin`）が働くので、
 * 幽霊チケットにはならない。
 */
export const MAX_AGE_APPLIES_TO: readonly TicketState[] = ['WAITING', 'PAUSED'];

// ---- 状態を変えないコマンドの適用範囲 ----
//
// **遷移表には入れない。** 表は状態が変わる矢印だけを語る。心拍と人数の変更は
// 状態を変えず、チケットの欄だけを書き換える。それでも「どの状態で受け付けるか」は
// 分岐ではなくデータとして宣言する（CLAUDE.md 3.2）。`MAX_AGE_APPLIES_TO` と
// 同じ形にしてある。

/**
 * 心拍（利用者の画面が生きていることの通知）を受け付ける状態。
 *
 * 生きているチケットすべて。終端に達したチケットの `lastSeenAt` には意味が無い。
 */
export const HEARTBEAT_APPLIES_TO: readonly TicketState[] = [...ACTIVE_TICKET_STATES];

/**
 * 人数を変更できる状態（全体プラン 7.6「人数の変更（待ち中）」）。
 *
 * 待っている間だけ。`CALLED` と `SEATED` を含めないのは、席がすでにその人数向けに
 * 確保されているためである。増やせば定員を超え、`assigned_party_fits_capacity` が
 * 破れる。席を持ったまま人数を変えたい人は、いったん譲るか取り消す。
 */
export const PARTY_SIZE_CHANGE_APPLIES_TO: readonly TicketState[] = ['WAITING', 'PAUSED'];

/**
 * 「使用中」の報告で繰り上げを受けられる状態（全体プラン 7.11 の 3 層目）。
 *
 * 「空いている可能性が高い席」に案内された人が、そこが使われていたと報告した
 * とき。**状態は待ちのまま変わらず、順番の繰り上げだけが起きる**ので、遷移表
 * ではなくここで宣言する。呼び出された人（`CALLED`）の報告は席を持っているぶん
 * 扱いが違い、`REPORT_TAKEN` として遷移表にある。
 */
export const CONFLICT_PRIORITY_APPLIES_TO: readonly TicketState[] = ['WAITING'];

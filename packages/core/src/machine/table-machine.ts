/**
 * テーブルの状態機械（全体プラン 7.4）。
 *
 * 7.4 の状態遷移図を、コードの分岐ではなくデータの表として宣言する。
 * 事象の名前は、同じ操作を指すものについてはチケット側（`ticket-machine.ts`）と
 * 揃えてある。1 つの操作が両方の状態を動かすことが読み取れるようにするため。
 */

import type { TableStatus } from '../domain/table.js';
import type { Transition } from './transit.js';

/**
 * テーブルに起きる事象。
 *
 * `OPEN` / `CLOSE` は運用時間帯の切り替え（7.14）、`VENUE_RELEASE` は緊急時の
 * 全席解放。両者は別の操作で、扱いが違う（下記）。
 */
export const TABLE_EVENTS = [
  'OPEN',
  'CLOSE',
  'HOLD',
  'CHECK_IN',
  'CHECK_IN_EARLY',
  'WALK_IN',
  'RELEASE',
  'REPORT_TAKEN',
  'REPORT_IN_USE',
  'CHECK_OUT',
  'TURNOVER_DONE',
  'OVERSTAY',
  'STILL_HERE_TIMEOUT',
  'STILL_HERE',
  'UNKNOWN_AGED',
  'CONFIRM_FREE',
  'AUTO_FREE',
  'VENUE_RELEASE',
] as const;

export type TableEvent = (typeof TABLE_EVENTS)[number];

/**
 * 遷移の条件。名前だけを宣言する。
 *
 * | ガード | 成立する条件 |
 * |---|---|
 * | `disableAfterCurrent` | 対象外にする操作が保留されている（7.6 のエッジケース） |
 * | `stillManaged` | 対象外の予約が無く、引き続き管理対象である |
 * | `autoFreeEnabled` | `needsCheckAutoFreeMin` が設定されている（null なら自動解放しない） |
 */
export const TABLE_GUARDS = ['disableAfterCurrent', 'stillManaged', 'autoFreeEnabled'] as const;

export type TableGuard = (typeof TABLE_GUARDS)[number];

export type TableTransition = Transition<TableStatus, TableEvent, TableGuard>;

/**
 * テーブルが作られたときの状態。
 *
 * 運用が始まるまでは管理対象外なので `DISABLED`。到達可能性の検査はここから始める。
 */
export const TABLE_INITIAL_STATE: TableStatus = 'DISABLED';

/**
 * 全体プラン 7.4 の状態遷移図の全矢印。
 */
export const TABLE_TRANSITIONS = [
  // ---- DISABLED（対象外・運用時間外） ----
  {
    from: 'DISABLED',
    on: 'OPEN',
    to: 'FREE',
    guard: null,
    source: '7.14',
    note: '運用が始まり、管理対象になった',
  },

  // ---- FREE（確実に空いている） ----
  {
    from: 'FREE',
    on: 'HOLD',
    to: 'HELD',
    guard: null,
    source: '7.6',
    note: '呼び出した人のために確保した',
  },
  {
    from: 'FREE',
    on: 'WALK_IN',
    to: 'OCCUPIED',
    guard: null,
    source: '7.12',
    note: 'チケットを持たない人が座席 QR から直接着席した',
  },
  {
    from: 'FREE',
    on: 'CHECK_IN_EARLY',
    to: 'OCCUPIED',
    guard: null,
    source: '7.8',
    note: '待っていた人が前倒しで着席した',
  },
  {
    from: 'FREE',
    on: 'REPORT_IN_USE',
    to: 'OCCUPIED_UNKNOWN',
    guard: null,
    source: '7.4',
    note: '第三者やスタッフから「使用中」の報告があった',
  },
  {
    from: 'FREE',
    on: 'CLOSE',
    to: 'DISABLED',
    guard: null,
    source: '7.14',
    note: '運用が終わった、または対象席から外された',
  },
  {
    from: 'FREE',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    source: '7.9',
    note: '緊急時の全席解放',
  },

  // ---- HELD（呼び出し中の人のために確保している） ----
  {
    from: 'HELD',
    on: 'CHECK_IN',
    to: 'OCCUPIED',
    guard: null,
    source: '7.8',
    note: '呼び出した人が着席した',
  },
  {
    from: 'HELD',
    on: 'RELEASE',
    to: 'FREE',
    guard: null,
    source: '7.7',
    note: 'ノーショー・パス・キャンセル・席の変更で確保を解いた',
  },
  {
    from: 'HELD',
    on: 'REPORT_TAKEN',
    to: 'OCCUPIED_UNKNOWN',
    guard: null,
    source: '7.8',
    note: '案内した席に別の人が座っていた',
  },
  {
    from: 'HELD',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    source: '7.9',
    note: '緊急時の全席解放',
  },

  // ---- OCCUPIED（着席が確認されている） ----
  {
    from: 'OCCUPIED',
    on: 'CHECK_OUT',
    to: 'TURNOVER',
    guard: null,
    source: '7.8',
    note: '退席が申告された。片付けの猶予に入る',
  },
  {
    from: 'OCCUPIED',
    on: 'OVERSTAY',
    to: 'NEEDS_CHECK',
    guard: null,
    source: '7.10',
    note: '着席時間の上限と猶予を超えた。空いている可能性がある',
  },
  {
    from: 'OCCUPIED',
    on: 'STILL_HERE_TIMEOUT',
    to: 'NEEDS_CHECK',
    guard: null,
    source: '7.11',
    note: '「まだご利用中ですか」への応答が無かった',
  },
  {
    from: 'OCCUPIED',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    source: '7.9',
    note: '緊急時の全席解放',
  },

  // ---- OCCUPIED_UNKNOWN（誰かが使っているが、誰かは分からない） ----
  {
    from: 'OCCUPIED_UNKNOWN',
    on: 'UNKNOWN_AGED',
    to: 'NEEDS_CHECK',
    guard: null,
    source: '7.11',
    note: '無断利用の想定滞在時間が過ぎた',
  },
  {
    from: 'OCCUPIED_UNKNOWN',
    on: 'CONFIRM_FREE',
    to: 'FREE',
    guard: null,
    source: '7.11',
    note: 'スタッフが巡回して空席であることを確認した',
  },
  {
    from: 'OCCUPIED_UNKNOWN',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    source: '7.9',
    note: '緊急時の全席解放',
  },

  // ---- TURNOVER（退席直後の片付け猶予） ----
  {
    from: 'TURNOVER',
    on: 'TURNOVER_DONE',
    to: 'FREE',
    guard: 'stillManaged',
    source: '7.6',
    note: '片付けの猶予が過ぎ、次の人に案内できるようになった',
  },
  {
    from: 'TURNOVER',
    on: 'TURNOVER_DONE',
    to: 'DISABLED',
    guard: 'disableAfterCurrent',
    source: '7.6',
    note: '対象外にする操作が保留されていたので、利用の終了とともに外した',
  },
  {
    from: 'TURNOVER',
    on: 'CLOSE',
    to: 'DISABLED',
    guard: null,
    source: '7.14',
    note: '運用が終わった',
  },
  {
    from: 'TURNOVER',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    source: '7.9',
    note: '緊急時の全席解放',
  },

  // ---- NEEDS_CHECK（たぶん空いているが確証がない） ----
  {
    from: 'NEEDS_CHECK',
    on: 'CONFIRM_FREE',
    to: 'FREE',
    guard: null,
    source: '7.11',
    note: 'スタッフ、または次に案内された人が空席であることを確かめた',
  },
  {
    from: 'NEEDS_CHECK',
    on: 'AUTO_FREE',
    to: 'FREE',
    guard: 'autoFreeEnabled',
    source: '7.11',
    note: '確認されないまま時間が過ぎたので自動で空席に戻した',
  },
  {
    from: 'NEEDS_CHECK',
    on: 'STILL_HERE',
    to: 'OCCUPIED',
    guard: null,
    source: '7.11',
    note: '利用者が「まだ利用中」と答えた',
  },
  {
    from: 'NEEDS_CHECK',
    on: 'REPORT_IN_USE',
    to: 'OCCUPIED_UNKNOWN',
    guard: null,
    source: '7.11',
    note: '次に案内された人が「使用中だった」と報告した',
  },
  {
    from: 'NEEDS_CHECK',
    on: 'CLOSE',
    to: 'DISABLED',
    guard: null,
    source: '7.14',
    note: '運用が終わった',
  },
  {
    from: 'NEEDS_CHECK',
    on: 'VENUE_RELEASE',
    to: 'DISABLED',
    guard: null,
    source: '7.9',
    note: '緊急時の全席解放',
  },
] as const satisfies readonly TableTransition[];

/**
 * 運用終了（`CLOSE`）で即座に `DISABLED` になる状態。
 *
 * 利用中の席（`HELD` / `OCCUPIED` / `OCCUPIED_UNKNOWN`）は、運用が終わっても
 * すぐには外さない。呼び出し中の人や着席中の人に影響するためで、
 * `disableAfterCurrent` を立てて現在の利用が終わってから外す（7.6）。
 * 緊急時の `VENUE_RELEASE` だけが、利用中かどうかにかかわらずすべてを外す。
 */
export const CLOSE_APPLIES_TO: readonly TableStatus[] = ['FREE', 'TURNOVER', 'NEEDS_CHECK'];

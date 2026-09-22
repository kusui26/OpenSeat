/**
 * チケットの契約（9.7 の利用者 1〜3）。
 *
 * 受付し、状態を見て、操作を送る。**この 3 本で利用者の一周が閉じる。**
 */

import type { CommandType } from '@openseat/core';
import { z } from 'zod';
import {
  CancelReason,
  ClientToken,
  IdempotencyKey,
  PartySize,
  TableToken,
  Tags,
  TicketId,
  TicketSecret,
} from '../values.js';
import { ServerTime, TicketView } from './views.js';

// ---- 受付（`POST /api/v/{venue}/tickets`） ----

/**
 * 受付（7.5）。**入力は人数だけ**で足りる。
 *
 * **通知手段はここに入らない。** 9.7 の表は受付に含めているが、Web Push の購読は
 * **許可を求める操作のあとでしか取れない**（受付ボタンを押した直後には、まだ無い）。
 * 受付を通知の許可待ちにすると、並ぶこと自体が遅れる。だから購読は受付のあとに
 * 別の呼び出しで届ける（PR 16）。
 */
export const JoinRequest = z.object({
  partySize: PartySize,
  /** 車いす対応席など。**順番は早めない**（7.6）。 */
  requiredTags: Tags.default([]),
  /**
   * チケット URL の秘密パラメータ（9.8）。**画面が作って送る。**
   *
   * ## なぜサーバが作らないのか
   *
   * **送り直しに同じ秘密を返せないからである。** 冪等キーの控えは結末だけで、
   * 応答そのものを持たない（[ADR-0015](../../../../docs/adr/0015-idempotency-key.md)）。
   * サーバが作ると、1 回目の応答が失われたとき、**送り直しても秘密が分からず、
   * そのチケットに二度と触れなくなる。**
   *
   * 画面が作れば、送り直しても手元にある。**サーバは保存時にハッシュ化する**ので、
   * 生の値を持つのは画面だけになる（CLAUDE.md 7 章）。冪等キーと匿名トークンも
   * 画面が作っており、考え方は同じである。
   *
   * **推測不能な乱数にすること**（`crypto.getRandomValues`）。
   */
  secret: TicketSecret,
});

export type JoinRequest = z.infer<typeof JoinRequest>;

/**
 * 受付の返し。
 *
 * **秘密パラメータは返さない。** 送ったのは画面のほうなので、返す必要が無い。
 * 返さなければ、**応答のログにも履歴にも現れない**（CLAUDE.md 7 章）。
 */
export const JoinResponse = ServerTime.extend({
  ticket: TicketView,
});

export type JoinResponse = z.infer<typeof JoinResponse>;

// ---- 状態（`GET /api/t/{ticket}`） ----

export const TicketPath = z.object({ ticket: TicketId });
export const TicketQuery = z.object({ k: TicketSecret });

/**
 * チケットの状態。
 *
 * **目安は `ticket.eta` に入っている。** 保留中の人にも「準備OK を押したら
 * どれくらいか」が返るので（`core` の `estimateForTicket`）、外に出し直さない。
 */
export const TicketResponse = ServerTime.extend({
  ticket: TicketView,
});

export type TicketResponse = z.infer<typeof TicketResponse>;

// ---- 操作（`POST /api/t/{ticket}/actions`） ----

/**
 * 利用者が出せる操作と、それが表す `core` のコマンド。
 *
 * **1 対 1 の表にしてある。** 境界は名前を引くだけで、どのコマンドにするかを
 * 考えない（CLAUDE.md 3.1 の「業務判断を書かない」）。
 *
 * 9.7 の表は 10 個を挙げているが、**3 つ足りない**。座席 QR の分岐（7.8）が
 * 出す「席を変える」「前倒しで座る」と、放置の判定に使う心拍（7.9）である。
 * 足りないまま作ると、**画面が「この席に変更できます」と出しても送り先が無い。**
 */
export const TICKET_ACTIONS = {
  cancel: 'CANCEL',
  pause: 'PAUSE',
  ready: 'READY',
  extend: 'EXTEND',
  pass: 'PASS',
  check_in: 'CHECK_IN',
  check_in_early: 'CHECK_IN_EARLY',
  swap_table: 'SWAP_TABLE',
  check_out: 'CHECK_OUT',
  still_here: 'STILL_HERE',
  report_conflict: 'REPORT_TAKEN',
  change_party_size: 'CHANGE_PARTY_SIZE',
  heartbeat: 'HEARTBEAT',
} as const satisfies Record<string, CommandType>;

export type TicketAction = keyof typeof TICKET_ACTIONS;

/** 席を指す操作。**読み取ったトークンで指す。内部 ID は外に出さない。** */
const atTable = <T extends TicketAction>(action: T) =>
  z.object({ action: z.literal(action), tableToken: TableToken });

const plain = <T extends TicketAction>(action: T) => z.object({ action: z.literal(action) });

/**
 * 操作の中身。
 *
 * **`action` で分かれる判別可能なユニオンにしてある**（CLAUDE.md 4 章）。
 * 席を指す操作にトークンを忘れる、といった組み合わせが型で作れない。
 */
export const TicketActionRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('cancel'),
    /** 本人は任意（7.9）。スタッフの取り消しは別の入口で、そちらは必須。 */
    reason: CancelReason.nullable().default(null),
  }),
  plain('pause'),
  plain('ready'),
  plain('extend'),
  plain('pass'),
  atTable('check_in'),
  atTable('check_in_early'),
  atTable('swap_table'),
  plain('check_out'),
  plain('still_here'),
  atTable('report_conflict'),
  z.object({ action: z.literal('change_party_size'), partySize: PartySize }),
  plain('heartbeat'),
]);

export type TicketActionRequest = z.infer<typeof TicketActionRequest>;

/**
 * 操作の返し。**断られても 1 つの形で返る。**
 *
 * 成功したときは新しい状態をそのまま返す。画面が次の `GET` を待たずに描けるので、
 * 「押したのに何も起きない」時間が生まれない。
 */
export const TicketActionResponse = ServerTime.extend({
  ticket: TicketView,
});

export type TicketActionResponse = z.infer<typeof TicketActionResponse>;

// ---- 共通のヘッダ ----

/**
 * 再送で二重に適用しないための鍵（9.4）。**状態を変える呼び出しに付ける。**
 *
 * 仕組みそのものは PR 4 で入る。ここでは「付ける約束」だけを宣言しておく。
 */
export const IdempotencyHeader = z.object({ 'idempotency-key': IdempotencyKey });

/**
 * 端末の匿名トークン（9.8）。**アカウントの代わりである。**
 *
 * 受付の回数制限（7.16 の `join_rate_limit_per_hour`）と、同じ端末が持つチケットの
 * 引き当てに使う。**運び方（ヘッダか Cookie か）と保存の仕方は PR 5 が決める。**
 * ここで宣言しているのは「そういう値が要る」ことだけである。
 */
export const ClientTokenHeader = z.object({ 'x-openseat-client': ClientToken.optional() });

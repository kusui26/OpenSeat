/**
 * 施設を見るための契約（9.7 の利用者 6、ボード 7）。
 *
 * **どちらも登録せずに見られる。** 空き状況は「今どれくらい待つか」を見るだけの
 * 導線（10.1）で、ボードは**通知が届かない人の受け皿**である（6.6）。
 */

import { z } from 'zod';
import {
  Minutes,
  PartySize,
  TableLabel,
  TicketCode,
  Timestamp,
  VenueSlug,
} from '../values.js';
import { ServerTime, TableView, WaitEstimate } from './views.js';

export const VenuePath = z.object({ venue: VenueSlug });

// ---- 空き状況（`GET /api/v/{venue}/status`） ----

/** 人数を添えると、その人数での目安が返る。添えなければ人数ごとの一覧になる。 */
export const VenueStatusQuery = z.object({ partySize: PartySize.optional() });

/**
 * 施設のいまの様子。
 *
 * **席の内訳は数だけ。** どの席が空いているかを外に出すと、並ばずに直行する人が
 * 出て、案内された人の席が塞がる（7.11 の事故が増える）。
 */
export const VenueStatusResponse = ServerTime.extend({
  venue: z.object({
    slug: VenueSlug,
    name: z.string(),
    timezone: z.string(),
    /** 運用中か（7.14）。false なら自由席に戻っている。 */
    operating: z.boolean(),
    /** 新規の受付を開いているか。運用終了の手前では、運用したまま受付だけ閉じる。 */
    joinOpen: z.boolean(),
    /** いまの営業回が終わる時刻。持たないなら `null`。 */
    closesAt: Timestamp.nullable(),
  }),

  /** 待っている組の数（`WAITING` ＋ `PAUSED` ＋ `CALLED`）。 */
  waiting: z.int().min(0),
  /** 管理対象の席のうち、確実に空いている数。 */
  freeTables: z.int().min(0),
  /** 管理対象の席の数。 */
  managedTables: z.int().min(0),

  /**
   * 人数ごとの目安。
   *
   * **人数で待ち時間が変わる**（4 名席は少ない）ので、1 つの数字では答えられない。
   * `partySize` を添えて呼べば、その 1 行だけが返る。
   */
  estimates: z.array(z.object({ partySize: PartySize, eta: WaitEstimate })),

  /** 受付の前に「それでも並びますか」を出す目安（7.16 の `long_wait_confirm_min`）。 */
  longWaitConfirmMin: Minutes,
});

export type VenueStatusResponse = z.infer<typeof VenueStatusResponse>;

// ---- ボード（`GET /api/v/{venue}/board`） ----

/**
 * 呼び出しボードの 1 行。
 *
 * **出すのはコードと席番号だけ**（9.9）。人数も待ち時間も出さない。誰が何人で
 * どこに座るかは、ボードを見ている全員に見せる必要が無い。
 */
export const BoardEntry = z.object({
  code: TicketCode,
  tableLabel: TableLabel,
  /** 呼び出しの期限。**画面は残りを大きく描く**（通知が届かない人の受け皿なので）。 */
  holdDeadline: Timestamp,
  /** 呼ばれた時刻。並び順に使う。 */
  calledAt: Timestamp,
}).meta({ id: 'BoardEntry' });

export type BoardEntry = z.infer<typeof BoardEntry>;

/**
 * ボードの中身。
 *
 * **WebSocket でも同じ形が流れる**（9.5 の `venue:{id}:public`）。配信の仕組みは
 * PR 7 で入るが、**形をここで 1 つに決めておく**ので、最初の取得と以後の更新で
 * 画面の描き方が変わらない。
 */
export const BoardResponse = ServerTime.extend({
  venue: z.object({ slug: VenueSlug, name: z.string(), operating: z.boolean() }),
  /** 呼び出し中の一覧。呼ばれた順。 */
  called: z.array(BoardEntry),
  waiting: z.int().min(0),
  /** 人数ごとの目安。ボードの下段に出す。 */
  estimates: z.array(z.object({ partySize: PartySize, eta: WaitEstimate })),
  /** 席の姿。スタッフが遠目に見るためのもので、**誰が座っているかは入らない。** */
  tables: z.array(TableView),
});

export type BoardResponse = z.infer<typeof BoardResponse>;

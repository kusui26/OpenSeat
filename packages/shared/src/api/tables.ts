/**
 * 座席 QR の契約（9.7 の利用者 4〜5）。
 *
 * **同じ QR が、受付・着席・退席・報告のすべてを兼ねる**（7.8）。何を見せて何を
 * 出すかは、席の状態と読み取った人の状態の組み合わせ **63 通り**で決まり、
 * **それを決めるのは `core` の `resolveTableScan` である**。境界はその結果を
 * 写して返すだけで、判断しない（CLAUDE.md 3.1）。
 */

import type { CommandType } from '@openseat/core';
import { z } from 'zod';
import {
  PartySize,
  TableLabel,
  TableScanKind,
  TableStatus,
  TableToken,
  Tags,
  TicketId,
  TicketSecret,
  VenueSlug,
} from '../values.js';
import { AvailableAction, ServerTime, TicketView, WaitEstimate } from './views.js';
import { JoinResponse } from './tickets.js';

// ---- ランディング（`GET /api/v/{venue}/tables/{token}`） ----

export const TablePath = z.object({ venue: VenueSlug, token: TableToken });

/**
 * 読み取った人が誰かを、任意で添える。
 *
 * **チケットを持たない人も読む**（7.8 の 6〜9）。持っている人は `?ticket=&k=` を
 * 添えると、その人向けの分岐になる。
 */
export const TableQuery = z.object({
  ticket: TicketId.optional(),
  k: TicketSecret.optional(),
});

/**
 * 読み取った席の、いまの姿。
 *
 * **`kind` が「何を見せるか」を決める。** 文言は `kind` を鍵にして
 * [i18n](../i18n/index.ts) が作る。画面は分岐を持たない。
 */
export const TableScanResponse = ServerTime.extend({
  kind: TableScanKind,

  /** 読み取った席。 */
  table: z.object({
    label: TableLabel,
    capacity: z.int().min(1),
    tags: Tags,
    status: TableStatus,
  }),

  /** その人に案内されている席の番号。`other_table` のとき、ここへ導く。 */
  assignedTableLabel: TableLabel.nullable(),

  /** いま押せる操作。**画面はこれ以外を出さない。** */
  actions: z.array(AvailableAction),

  /**
   * 持っていたチケットがもう終わっているか（7.7 の 8）。
   * ノーショーや期限切れのあとで席に来た人がこれにあたる。
   */
  staleTicket: z.boolean(),

  /** チケットを持っている人には、その状態も返す。 */
  ticket: TicketView.nullable(),

  /** 飛び込みで座れるとき、そのあとどれくらい待つかではなく「いま座れる」を示す。 */
  eta: WaitEstimate,
});

export type TableScanResponse = z.infer<typeof TableScanResponse>;

// ---- 飛び込み着席（`POST /api/v/{venue}/tables/{token}/walk-in`） ----

/**
 * 飛び込み着席（7.12）。**登録を経ずに、いきなり着席から始まる。**
 *
 * これで (a) 待ちがない時間帯でも占有状況が正確になり、(b) 登録した人が守られ、
 * (c)「待ちがいるのに席が空いている」矛盾がなくなる。
 */
export const WalkInRequest = z.object({
  partySize: PartySize,
  /** チケット URL の秘密パラメータ。**画面が作る**（`JoinRequest.secret` と同じ理由）。 */
  secret: TicketSecret,
});

export type WalkInRequest = z.infer<typeof WalkInRequest>;

/** 返しは受付と同じ。**飛び込みでもチケットは作られる**ので、以後は同じ画面で扱える。 */
export const WalkInResponse = JoinResponse;

export type WalkInResponse = z.infer<typeof WalkInResponse>;

// ---- 席についての報告 ----

/**
 * チケットを持たない人でも出せる、席についての報告。
 *
 * **「空いていました」は、席に着席の記録が残っていればスタッフだけ**である
 * （[ADR-0011](../../../../docs/adr/0011-who-may-free-an-uncertain-seat.md)）。
 * その判断は `core` が下し、足りなければ `STAFF_ONLY` で断る。**境界は判定しない。**
 */
export const TABLE_REPORTS = {
  in_use: 'REPORT_IN_USE',
  free: 'CONFIRM_FREE',
} as const satisfies Record<string, CommandType>;

export type TableReport = keyof typeof TABLE_REPORTS;

/**
 * 上の表に並ぶ名前。**綴り違いは型が落とす**が、足し忘れは落とせない
 * （`z.enum` はリテラルの並びを要る）。**抜けは対応表のテストが見る。**
 */
const TABLE_REPORT_NAMES = ['in_use', 'free'] as const satisfies readonly TableReport[];

export const TableReportRequest = z.object({
  report: z.enum(TABLE_REPORT_NAMES),
  /** 案内されていた本人なら、埋め合わせのために添える（7.8 の 10）。 */
  ticket: TicketId.nullable().default(null),
});

export type TableReportRequest = z.infer<typeof TableReportRequest>;

export const TableReportResponse = ServerTime.extend({
  table: z.object({ label: TableLabel, status: TableStatus }),
});

export type TableReportResponse = z.infer<typeof TableReportResponse>;

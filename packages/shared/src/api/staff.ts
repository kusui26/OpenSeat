/**
 * スタッフの契約（9.7 のスタッフ 8、10.1 の運用コンソール）。
 *
 * **スタッフの操作は例外なく監査ログに残る**（CLAUDE.md 7 章、PR 12）。だから
 * どの呼び出しも「誰が」を伴う。**誰であるかの確認はセッションが行い、`core` は
 * コマンドに書かれた実行者を信じる**（[ADR-0011](../../../../docs/adr/0011-who-may-free-an-uncertain-seat.md) と同じ扱い）。
 *
 * **権限の判定はここではしない。** 役割 × コマンドの表は PR 3 で入り、`dispatch` が
 * 適用の前に必ず評価する（CLAUDE.md 3.2(4)）。
 */

import type { CommandType } from '@openseat/core';
import { z } from 'zod';
import {
  CancelReason,
  PartySize,
  TableLabel,
  TableStatus,
  Tags,
  TicketCode,
  TicketId,
  TicketState,
  Timestamp,
  VenueSlug,
} from '../values.js';
import { ServerTime, TableView, TicketView, WaitEstimate } from './views.js';

export const StaffVenuePath = z.object({ venue: VenueSlug });

// ---- コンソール（`GET /api/staff/v/{venue}/console`） ----

/** 待ち一覧の 1 行。**氏名も連絡先も無い。** 人数と順番だけで運用する。 */
export const QueueEntry = z.object({
  id: TicketId,
  code: TicketCode,
  state: TicketState,
  partySize: PartySize,
  requiredTags: Tags,
  /** 順番の基準。保留を挟んでも保たれる（7.7）。 */
  priorityAt: Timestamp,
  /** 受付した時刻。**絶対上限の起点**で、`priorityAt` とは別（7.16）。 */
  createdAt: Timestamp,
  tableLabel: TableLabel.nullable(),
  holdDeadline: Timestamp.nullable(),
  /** 通知が届く手段を持っているか。**持たない人は声をかける**（6.6）。 */
  hasNotificationChannel: z.boolean(),
}).meta({ id: 'QueueEntry' });

export type QueueEntry = z.infer<typeof QueueEntry>;

/**
 * 運用コンソールの中身。
 *
 * **「確認要」を別に切り出してある。** 7.11 の 4 層目で、ここが片づかないと席が
 * 戻らない。一覧に紛れさせず、やることとして見せる。
 */
export const ConsoleResponse = ServerTime.extend({
  venue: z.object({
    slug: VenueSlug,
    name: z.string(),
    operating: z.boolean(),
    joinOpen: z.boolean(),
    closesAt: Timestamp.nullable(),
  }),
  queue: z.array(QueueEntry),
  tables: z.array(TableView),
  /** 確かめてほしい席。**スタッフの仕事の一覧である。** */
  needsCheck: z.array(
    z.object({
      label: TableLabel,
      /** その姿になってからの時間。長いものから片づける。 */
      since: Timestamp,
      /** 着席の記録が残っているか。**残っていれば、空席に戻せるのはスタッフだけ。** */
      hasOccupantRecord: z.boolean(),
    }),
  ),
  estimates: z.array(z.object({ partySize: PartySize, eta: WaitEstimate })),
});

export type ConsoleResponse = z.infer<typeof ConsoleResponse>;

// ---- 手動受付（`POST /api/staff/v/{venue}/tickets`） ----

/**
 * スマホを持たない人の受付（10.1）。
 *
 * **紙のチケットに表示コードを書いて渡す。** 通知は届かないので、呼び出しは
 * ボードと声かけになる（6.6）。
 */
export const ManualJoinRequest = z.object({
  partySize: PartySize,
  requiredTags: Tags.default([]),
});

export type ManualJoinRequest = z.infer<typeof ManualJoinRequest>;

export const ManualJoinResponse = ServerTime.extend({ ticket: TicketView });

export type ManualJoinResponse = z.infer<typeof ManualJoinResponse>;

// ---- チケットへの代理操作（`POST /api/staff/v/{venue}/tickets/{ticket}/actions`） ----

/**
 * スタッフが代わりに出せる操作と、それが表す `core` のコマンド。
 *
 * **取り消しの理由は必須である**（7.9）。本人の取り消しは任意だが、スタッフの
 * 操作は監査に残るので、なぜ消したかが後から分かる必要がある。
 */
export const STAFF_TICKET_ACTIONS = {
  cancel: 'CANCEL',
  check_in: 'CHECK_IN',
  check_out: 'CHECK_OUT',
} as const satisfies Record<string, CommandType>;

export type StaffTicketAction = keyof typeof STAFF_TICKET_ACTIONS;

export const StaffTicketActionRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('cancel'), reason: CancelReason }),
  z.object({ action: z.literal('check_in'), tableLabel: TableLabel }),
  z.object({ action: z.literal('check_out') }),
]);

export type StaffTicketActionRequest = z.infer<typeof StaffTicketActionRequest>;

export const StaffTicketActionResponse = ServerTime.extend({ ticket: TicketView });

export type StaffTicketActionResponse = z.infer<typeof StaffTicketActionResponse>;

// ---- 席への操作（`POST /api/staff/v/{venue}/tables/{label}/actions`） ----

/**
 * 席の状態を人の手で動かす（7.11 の 4 層目）。
 *
 * **「空席にする」が要になる**（[ADR-0011](../../../../docs/adr/0011-who-may-free-an-uncertain-seat.md)）。
 * 着席の記録が残った「確認要」の席を戻せるのは、ここだけである。
 */
export const STAFF_TABLE_ACTIONS = {
  free: 'CONFIRM_FREE',
  in_use: 'REPORT_IN_USE',
  disable: 'DISABLE_TABLE',
  enable: 'ENABLE_TABLE',
} as const satisfies Record<string, CommandType>;

export type StaffTableAction = keyof typeof STAFF_TABLE_ACTIONS;

const STAFF_TABLE_ACTION_NAMES = [
  'free',
  'in_use',
  'disable',
  'enable',
] as const satisfies readonly StaffTableAction[];

export const StaffTableActionRequest = z.object({ action: z.enum(STAFF_TABLE_ACTION_NAMES) });

export type StaffTableActionRequest = z.infer<typeof StaffTableActionRequest>;

export const StaffTableActionResponse = ServerTime.extend({
  table: z.object({ label: TableLabel, status: TableStatus, enabled: z.boolean() }),
});

export type StaffTableActionResponse = z.infer<typeof StaffTableActionResponse>;

// ---- 運用（`POST /api/staff/v/{venue}/operation`） ----

/**
 * 運用そのものを動かす（7.14）。
 *
 * **`release_all` は最後の手段である。** 障害のときに掲示を出して自由席へ戻す
 * 手順（12.6）の一部で、**この操作だけはいつでも効くように保つ**（CLAUDE.md 8）。
 */
export const OPERATION_ACTIONS = {
  open: 'OPEN',
  close: 'CLOSE',
  release_all: 'RELEASE_ALL',
} as const satisfies Record<string, CommandType>;

export type OperationAction = keyof typeof OPERATION_ACTIONS;

export const OperationRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('open'),
    /** この営業回が終わる時刻。手で閉じるまで続けるなら `null`（7.14）。 */
    closesAt: Timestamp.nullable().default(null),
  }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('release_all') }),
]);

export type OperationRequest = z.infer<typeof OperationRequest>;

export const OperationResponse = ServerTime.extend({
  operating: z.boolean(),
  joinOpen: z.boolean(),
  closesAt: Timestamp.nullable(),
  tables: z.array(TableView),
});

export type OperationResponse = z.infer<typeof OperationResponse>;

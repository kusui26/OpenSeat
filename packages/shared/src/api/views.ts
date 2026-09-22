/**
 * 返す形。
 *
 * **画面は業務判断をしない**（CLAUDE.md 3.1）。だから「いま押せる操作」も
 * 「あと何分か」も、**判断した結果**をサーバが入れて返す。画面はそれを描くだけである。
 *
 * **個人を特定しうるものは 1 つも入っていない。** 端末トークンのハッシュ、
 * 通知先、座席 QR のトークンはここに現れない（CLAUDE.md 7 章）。
 */

import { COMMAND_TYPES } from '@openseat/core';
import { z } from 'zod';
import {
  EndReason,
  Minutes,
  PartySize,
  TableLabel,
  TableStatus,
  Tags,
  TicketCode,
  TicketId,
  TicketState,
  Timestamp,
} from '../values.js';

/**
 * いま押せる操作。
 *
 * **`core` のコマンドの種別そのもの**なので、画面はこれをそのまま送り返せる。
 * 画面が独自に操作を足さないための約束である（`core` の `TableScanOutcome` と同じ）。
 */
export const AvailableAction = z.enum(COMMAND_TYPES);

/**
 * 待ち時間の目安（7.13）。`core` の `WaitEstimate` をそのまま写す。
 *
 * **幅で見せる。** 分単位の数字をそのまま出すと、過度に正確に見える（7.13）。
 */
export const WaitEstimate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no_seat') }).describe('その人数が収まる席が 1 つも無い'),
  z.object({ kind: z.literal('not_waiting') }).describe('並んでいない'),
  z.object({
    kind: z.literal('estimate'),
    minutes: Minutes.describe('目安の分数（悲観側に切り上げ）'),
    fromMin: Minutes.describe('表示する幅の下限'),
    toMin: Minutes.describe('表示する幅の上限'),
    ahead: z.int().min(0).describe('前に何組いるか'),
  }),
]).meta({ id: 'WaitEstimate' });

export type WaitEstimate = z.infer<typeof WaitEstimate>;

/**
 * 着席時間の目安（7.10）。
 *
 * **`hard` でも席を取り上げない**のが既定である（[ADR-0009](../../../../docs/adr/0009-seating-time-limit.md)）。
 * 画面は「目安」と書く。強制の印象を与えない（6.5）。
 */
export const TimeLimitView = z.object({
  /** 目安に達する時刻。 */
  at: Timestamp,
  /** 目安の長さ。 */
  minutes: Minutes,
  /** すでに達しているか。 */
  reached: z.boolean(),
}).meta({ id: 'TimeLimit' });

/**
 * 利用者に見せるチケット。
 *
 * **秘密パラメータ（`?k=`）は入らない。** 画面は URL から読む。返す形に入れると、
 * ボードやスタッフ画面へ同じ形を流したときに漏れる。
 */
export const TicketView = z.object({
  id: TicketId,
  code: TicketCode,
  state: TicketState,
  partySize: PartySize,
  requiredTags: Tags,

  /** 案内されている席の番号。決まっていなければ `null`。**内部 ID は返さない。** */
  tableLabel: TableLabel.nullable(),

  /** 呼び出しの期限（7.7）。**絶対時刻で渡し、カウントダウンは画面が描く**（9.4）。 */
  holdDeadline: Timestamp.nullable(),
  /** 保留の期限（7.7）。 */
  pauseDeadline: Timestamp.nullable(),
  /** あと何回延ばせるか。`0` なら「向かっています」を出さない。 */
  extensionsLeft: z.int().min(0),

  eta: WaitEstimate,
  timeLimit: TimeLimitView.nullable(),

  /** 終わっていれば、その終わり方。 */
  endReason: EndReason.nullable(),

  /** いま押せる操作。**画面はこれ以外を出さない。** */
  actions: z.array(AvailableAction),
}).meta({ id: 'TicketView' });

export type TicketView = z.infer<typeof TicketView>;

/**
 * ボードと空き状況に出す席。
 *
 * **誰が座っているかは出さない。** 出すのは「その席がいまどう見えるか」だけである。
 */
export const TableView = z.object({
  label: TableLabel,
  capacity: z.int().min(1),
  tags: Tags,
  status: TableStatus,
  /** 呼び出し中なら、その表示コード。ボードが「A-23 → T-12」と出すために要る。 */
  calledCode: TicketCode.nullable(),
}).meta({ id: 'TableView' });

export type TableView = z.infer<typeof TableView>;

/**
 * サーバの時刻。
 *
 * **時刻はサーバのみを信頼する**（9.4、CLAUDE.md 3.4）。期限は絶対時刻で渡し、
 * 画面はこの値との差から時計のずれを知って、カウントダウンを描く。
 */
export const ServerTime = z.object({ serverNow: Timestamp });

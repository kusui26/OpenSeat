/**
 * 実行者。**誰として、その操作を出しているか**（全体プラン 9.8）。
 *
 * ## 2 つの別々のこと
 *
 * | | 何を表すか | どこで使うか |
 * |---|---|---|
 * | `Role` | **誰か。** 匿名・本人・スタッフ・管理者・所有者 | 権限の判定（`domain/permissions.ts`） |
 * | `Side` | **どちら側が行ったか。** 利用者側かスタッフ側か | 記録（終わり方、7.9） |
 *
 * 分けてあるのは、**記録に要る細かさと、権限に要る細かさが違う**からである。
 * 「管理者が取り消した」と「スタッフが取り消した」は統計では同じ（どちらも
 * `staff_cancel`）だが、権限では違う。逆に「匿名」と「本人」は権限では大きく
 * 違うが、記録ではどちらも利用者側である。
 *
 * ## `core` は名乗りを信じる
 *
 * **誰であるかの確認は境界の責務である**（[ADR-0011](../../../../docs/adr/0011-who-may-free-an-uncertain-seat.md)
 * と同じ扱い）。セッション（PR 12）と匿名トークン（PR 5）が確かめたものを、
 * `core` はそのまま受け取る。ここで見るのは「その役割にその操作が許されているか」
 * だけである。
 */

import type { TicketId } from './ids.js';

/**
 * その操作を、どちら側が行ったか。
 *
 * **記録に残るのはこの 2 つだけである。** 「本人が取り消した」と「スタッフが
 * 取り消した」は別のこととして数える必要があるが（7.9）、その先の役割まで
 * 分ける理由は、統計にも文言にも無い。
 */
export const SIDES = ['user', 'staff'] as const;

export type Side = (typeof SIDES)[number];

/**
 * 役割（全体プラン 9.8）。
 *
 * | 役割 | 誰か |
 * |---|---|
 * | `anonymous` | チケットを持たない人。入口の QR や座席 QR を読んだだけ |
 * | `ticket_owner` | チケットの秘密パラメータを示した本人（9.8） |
 * | `staff` | 現場のスタッフ。招待制でログインする |
 * | `admin` | 施設の管理者。設定と席を変えられる |
 * | `owner` | 施設の所有者。管理者を招待できる |
 *
 * **並びは弱いほうから強いほうへ。** 上位が下位を兼ねることは、この並びでは
 * 表さない（`PERMISSIONS` の表に明示的に並べる）。**「たぶん兼ねる」で通すと、
 * 表を読んだだけでは誰が何をできるか分からなくなる。**
 */
export const ROLES = ['anonymous', 'ticket_owner', 'staff', 'admin', 'owner'] as const;

export type Role = (typeof ROLES)[number];

/**
 * コマンドを出した人。
 *
 * **役割だけでは足りない。** 本人（`ticket_owner`）は「どのチケットの本人か」を
 * 伴う。伴わないと、**チケット A の秘密パラメータでチケット B を取り消せる**。
 */
export interface Actor {
  readonly role: Role;
  /**
   * 本人が示したチケット。`ticket_owner` 以外では `null`。
   *
   * 既存のチケットに対する操作では、**ここと操作の相手が一致していなければ
   * 断る**（`domain/permissions.ts`）。
   */
  readonly ticketId: TicketId | null;
  /**
   * スタッフ・管理者の識別子。**監査ログに残す**（CLAUDE.md 7 章）。
   *
   * 利用者は匿名なので `null`。**氏名も連絡先も持たない。**
   */
  readonly userId: string | null;
}

/** チケットを持たない人。入口の QR を読んだだけの人がこれにあたる。 */
export const ANONYMOUS: Actor = { role: 'anonymous', ticketId: null, userId: null };

/** チケットの秘密パラメータを示した本人。 */
export function ticketOwner(ticketId: TicketId): Actor {
  return { role: 'ticket_owner', ticketId, userId: null };
}

/** ログインした人。**誰であるかを確かめるのは境界の責務**で、ここは受け取るだけ。 */
export function member(role: Role, userId: string): Actor {
  return { role, ticketId: null, userId };
}

/**
 * 役割から、記録に残す側を導く。
 *
 * **表として宣言する。** 役割を足したときに、どちら側として記録するかを必ず
 * 決めさせるため（CLAUDE.md 3.2）。
 */
const SIDE_OF = {
  anonymous: 'user',
  ticket_owner: 'user',
  staff: 'staff',
  admin: 'staff',
  owner: 'staff',
} as const satisfies Record<Role, Side>;

export function sideOf(role: Role): Side {
  return SIDE_OF[role];
}

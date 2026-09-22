/**
 * 誰がどのコマンドを出せるか（CLAUDE.md 3.2(4)、全体プラン 9.8）。
 *
 * **表 1 つで決まる。** ハンドラに `if (role === 'staff')` を書かない。書けば、
 * ハンドラを書き換えるたびに権限が変わりうることになり、**コントローラーを
 * 何度書き換えても整合性が壊れない**という約束（CLAUDE.md 3 章）が崩れる。
 *
 * 表は `dispatch` が適用の前に必ず評価する（`machine/dispatch.ts`）。**`apply` は
 * 公開していない**ので、権限を通らずに状態を変える道が外から見えない。
 *
 * ## ここで見ないこと
 *
 * **「誰であるか」は見ない。** セッション（PR 12）と匿名トークン（PR 5）が
 * 確かめたものを信じる（`domain/actor.ts`）。
 *
 * **ドメインの条件も見ない。** 「着席の記録が残っている席を空席に戻せるのは
 * スタッフだけ」（[ADR-0011](../../../../docs/adr/0011-who-may-free-an-uncertain-seat.md)）は
 * **席に記録があるか**という状態の条件で、役割の条件ではない。**両方が要る**ので
 * 両方を残し、評価する順（権限 → ドメイン）を `dispatch.test.ts` が固定している。
 */

import type { Command, CommandType } from '../machine/command.js';
import type { Actor, Role } from './actor.js';
import type { TicketId } from './ids.js';

/**
 * 役割 × コマンドの表。
 *
 * **すべてのコマンドを並べる。** `satisfies Record<CommandType, ...>` にしてあるので、
 * コマンドを足したら**誰に許すかを決めるまで型が通らない**。決め忘れて「誰でも
 * 出せる」になることが起こらない。
 *
 * ### 読み方
 *
 * - **利用者の操作は本人だけ**（`ticket_owner`）。スタッフも出せるのは、代わりに
 *   操作する道があるものだけ（7.9 の代理取り消し、10.1 の手動受付）
 * - **席についての報告は誰でも出せる**（7.8 の 6〜9、7.11 の 3 層目）。通りすがりの
 *   人が「使用中でした」と押せることが、ゴースト占有を戻す最短の道である
 * - **運用そのものを動かすのはスタッフから上**（7.14）。`RELEASE_ALL` は障害時の
 *   最後の手段（12.6）なので、現場のスタッフが押せる
 * - **席の設定を変えられるのは管理者から上**（10.2）
 */
export const PERMISSIONS = {
  // ---- 受付（7.5、7.12） ----
  // 並んでいる最中の人がもう 1 枚取ることは、回数制限（7.16）で抑える。
  JOIN: ['anonymous', 'ticket_owner', 'staff', 'admin', 'owner'],
  WALK_IN: ['anonymous', 'ticket_owner', 'staff', 'admin', 'owner'],

  // ---- 本人の操作（7.7、7.9、7.10） ----
  PAUSE: ['ticket_owner'],
  READY: ['ticket_owner'],
  EXTEND: ['ticket_owner'],
  PASS: ['ticket_owner'],
  STILL_HERE: ['ticket_owner'],
  CHANGE_PARTY_SIZE: ['ticket_owner'],
  HEARTBEAT: ['ticket_owner'],
  SWAP_TABLE: ['ticket_owner'],
  CHECK_IN_EARLY: ['ticket_owner'],
  REPORT_TAKEN: ['ticket_owner'],

  // ---- 本人かスタッフ（代理がある操作） ----
  // 取り消しはスタッフも出せる（7.9）。理由は必須で、監査に残る。
  CANCEL: ['ticket_owner', 'staff', 'admin', 'owner'],
  // 着席の確認と退席の申告は、スタッフが代わりに入れられる（10.1 の運用コンソール）。
  CHECK_IN: ['ticket_owner', 'staff', 'admin', 'owner'],
  CHECK_OUT: ['ticket_owner', 'staff', 'admin', 'owner'],

  // ---- 席についての報告（7.8、7.11） ----
  // **誰でも出せる。** 記録の残った席を空席に戻す道だけは、ADR-0011 が別に絞る。
  REPORT_IN_USE: ['anonymous', 'ticket_owner', 'staff', 'admin', 'owner'],
  CONFIRM_FREE: ['anonymous', 'ticket_owner', 'staff', 'admin', 'owner'],

  // ---- 運用（7.14、12.6） ----
  OPEN: ['staff', 'admin', 'owner'],
  CLOSE: ['staff', 'admin', 'owner'],
  RELEASE_ALL: ['staff', 'admin', 'owner'],

  // ---- 席の設定（10.2） ----
  DISABLE_TABLE: ['admin', 'owner'],
  ENABLE_TABLE: ['admin', 'owner'],
} as const satisfies Record<CommandType, readonly Role[]>;

/** その役割が、そのコマンドを出せるか。 */
export function isPermitted(role: Role, command: CommandType): boolean {
  const allowed: readonly Role[] = PERMISSIONS[command];
  return allowed.includes(role);
}

/**
 * そのコマンドは、**すでにあるチケット**を相手にするか。
 *
 * **受付（`JOIN`）と飛び込み（`WALK_IN`）だけが違う。** どちらもチケットを
 * **作る**側で、出す人はまだその本人ではない。ここを取り違えると、**すでに
 * 並んでいる人が 2 枚目を取れなくなる**（持っているチケットと ID が違うため）。
 *
 * 表として宣言する。コマンドを足したら、相手が誰かを決めるまで型が通らない。
 */
const TARGETS_EXISTING_TICKET = {
  // 作る側
  JOIN: false,
  WALK_IN: false,

  // 本人の操作
  CANCEL: true,
  PAUSE: true,
  READY: true,
  EXTEND: true,
  PASS: true,
  CHECK_IN: true,
  CHECK_OUT: true,
  SWAP_TABLE: true,
  CHECK_IN_EARLY: true,
  REPORT_TAKEN: true,
  STILL_HERE: true,
  CHANGE_PARTY_SIZE: true,
  HEARTBEAT: true,

  // 席についての報告。本人が添えたなら、埋め合わせの相手になる（7.8 の 10）
  REPORT_IN_USE: true,

  // 席と施設に対する操作。チケットを相手にしない
  CONFIRM_FREE: false,
  OPEN: false,
  CLOSE: false,
  RELEASE_ALL: false,
  DISABLE_TABLE: false,
  ENABLE_TABLE: false,
} as const satisfies Record<CommandType, boolean>;

/** そのコマンドが相手にする、すでにあるチケット。無ければ `null`。 */
export function targetTicketId(command: Command): TicketId | null {
  if (!TARGETS_EXISTING_TICKET[command.type]) return null;
  return 'ticketId' in command ? command.ticketId : null;
}

/**
 * 本人が、自分のチケットを相手にしているか。
 *
 * **これが無いと、チケット A の秘密パラメータでチケット B を取り消せる。**
 * 本人以外の役割には関係しない（スタッフはどのチケットも相手にできる）。
 */
export function ownsTarget(actor: Actor, command: Command): boolean {
  if (actor.role !== 'ticket_owner') return true;
  const target: TicketId | null = targetTicketId(command);
  return target === null || target === actor.ticketId;
}

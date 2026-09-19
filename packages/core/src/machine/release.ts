/**
 * チケットを終わらせる／席の確保を解く。
 *
 * 取り消し（`apply`）・パス（`apply`）・ノーショー（`tick`）で同じことが起きる。
 * **書き換える欄を 1 か所にまとめてある。** 別々に書くと、どれか 1 つで
 * `tableId` や `holdDeadline` を消し忘れ、その席が誰にも割り当てられなくなる。
 */

import { withTable, type VenueState } from '../domain/state.js';
import type { Table } from '../domain/table.js';
import type { EndReason, Ticket, TicketState } from '../domain/ticket.js';
import type { Decision } from '../decision.js';
import { err, ok, type Result } from '../result.js';
import type { Timestamp } from '../time.js';
import { closedPause } from './deadlines.js';
import type { DomainEvent } from './events.js';
import type { Rejection } from './rejection.js';
import { tableTransition } from './transition.js';

/**
 * 呼び出しに関する欄を空にする。
 *
 * `calledAt` は残す。「いつ呼ばれたか」は終わったあとも統計と問い合わせに要る。
 * 消すのは「いま効いているもの」だけである。
 */
export function clearedHold(): Pick<Ticket, 'tableId' | 'holdDeadline' | 'holdRemindedAt'> {
  return { tableId: null, ...clearedHoldDeadline() };
}

/**
 * ホールドの期限だけを外す。**席との結びつきは残す。**
 *
 * 着席したときに使う。席はそのまま使い続けるが、「いつまでに来てください」の
 * 期限はもう働かない。`holdRemindedAt` も消して、不変条件 10（`CALLED` の
 * あいだだけ入っている）を保つ。
 */
export function clearedHoldDeadline(): Pick<Ticket, 'holdDeadline' | 'holdRemindedAt'> {
  return { holdDeadline: null, holdRemindedAt: null };
}

/**
 * 着席中に出した一度きりの知らせの記録を消す。
 *
 * 「まだご利用中ですか」と「目安時間になりました」を出したかどうかは、
 * **着席しているあいだだけ意味を持つ**。終わったチケットに残しておくと、
 * 不変条件 10（その状態のときだけ入る）が破れる。
 *
 * 消しても記録は失われない。**いつ出したかはイベントに残っている**。
 * 状態に置いておくのは「もう出したか」を判断するためだけである。
 */
export function clearedSeatedNotices(): Pick<
  Ticket,
  'stillHereAskedAt' | 'stillHereAnsweredAt' | 'timeLimitNoticedAt'
> {
  return { stillHereAskedAt: null, stillHereAnsweredAt: null, timeLimitNoticedAt: null };
}

/**
 * 終端へ落ちたチケットの欄を揃える。
 *
 * 席との結びつきとホールドの期限を必ず外す。残っていると、その席が誰にも
 * 割り当てられなくなり、`terminal_holds_no_table` が破れる。保留中だった場合は
 * その分の時間を合計へ足し込んでから閉じる。
 *
 * **節目の時刻（`calledAt`、`seatedAt`）は残し、一度きりの印は消す。** 節目は
 * 終わったあとも統計と問い合わせに要るが、印は「もう出したか」を判断するため
 * だけのもので、終わったチケットには意味が無い。
 */
export function endedTicket(
  ticket: Ticket,
  to: TicketState,
  endReason: EndReason,
  now: Timestamp,
): Ticket {
  return {
    ...ticket,
    ...clearedHold(),
    ...clearedSeatedNotices(),
    ...closedPause(ticket, now),
    state: to,
    endedAt: now,
    endReason,
  };
}

/**
 * 確保していた席を空席に戻す（全体プラン 7.9「`CALLED` 中なら席は即 `FREE`」）。
 *
 * **次の人への割当はここでは行わない。** `apply` と `tick` が最後に必ず実行する。
 * `verifiedFreeAt` も更新しない。誰も座っていないので、この席が空いていることの
 * 確からしさは確保する前から変わっていない。
 *
 * 席が見つからない場合は、何もせずに続ける。その状態はすでに
 * `assigned_has_table` が破れているので、解放はむしろ食い違いを解消する。
 */
export function releaseHeldTable(
  state: VenueState,
  ticket: Ticket,
  now: Timestamp,
): Result<Decision<VenueState, DomainEvent>, Rejection> {
  if (ticket.tableId === null) return ok({ state, events: [] });
  const table: Table | undefined = state.tables.find((candidate) => candidate.id === ticket.tableId);
  if (table === undefined) return ok({ state, events: [] });

  const moved = tableTransition({ state, table, now }, 'RELEASE');
  if (!moved.ok) return err(moved.error);
  const freed: Table = { ...table, status: moved.value, statusSince: now, occupantTicketId: null };
  return ok({
    state: withTable(state, freed),
    events: [{ type: 'TableFreed', at: now, tableId: freed.id, releasedTicketId: ticket.id }],
  });
}

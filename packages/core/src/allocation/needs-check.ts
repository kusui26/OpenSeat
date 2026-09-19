/**
 * 確認要の席の案内（全体プラン 7.11 の 3 層目）。
 *
 * 退席の押し忘れと無断利用は必ず起きる。7.11 はその回復を 5 層で重ねており、
 * ここはその 3 層目 ——「空いている可能性が高い席」を **次の利用者に確かめて
 * もらう** —— を担う。
 *
 * **割当（`allocation/choose.ts`）とは意図的にファイルを分けてある。** 席が
 * 空いている確証が無いからで、結果の型も別にしてある。混ぜると、画面のどこかで
 * 「確実な空席」と同じ見せ方をしてしまう。7.11 が繰り返し言うとおり、この機能は
 * **現状の「歩き回って探す」より悪くならない** ことが肝心で、確証の無い席を
 * 確実な空席として見せた時点でそれは崩れる。
 */

import type { TableId, TicketId } from '../domain/ids.js';
import type { VenueState } from '../domain/state.js';
import type { Table } from '../domain/table.js';
import type { Ticket } from '../domain/ticket.js';
import { assignableTables, candidatesFor, orderTables, pickCandidate } from './choose.js';

/**
 * 「空いている可能性が高い席」の案内。
 *
 * **`Assignment` とは別の型である。** 席を確保もしなければ、呼び出しもしない。
 * 状態にも残らない。案内された人が着いてみるまで、その席が空いているかどうかは
 * 誰も知らないからで、**この不確かさを型で持ち歩くために分けてある。**
 */
export interface Suggestion {
  readonly ticketId: TicketId;
  readonly tableId: TableId;
}

/** 案内の対象になる席。管理対象で、空いている可能性が高いもの。 */
export function uncertainTables(state: VenueState): readonly Table[] {
  return state.tables.filter((table) => table.enabled && table.status === 'NEEDS_CHECK');
}

/**
 * 確認要の席を、待っている人に見当として案内する（7.11 の 3 層目）。
 *
 * **確実な空席が 1 つでもあれば、何も案内しない。** そちらが先だからである。
 * `assignNeedsCheck` が偽の施設でも案内しない。
 *
 * 7.11 は「待ちの先頭に」と書いているが、席ごとに収まる人は違う。ここでは
 * **誰を選ぶかを通常の割当（7.6）とまったく同じ規則にした。** 2 人に同じ席を
 * 案内することも、1 人に 2 つの席を案内することもない。
 *
 * **状態を変えない。誰に伝えるかは境界側の責務で、これは問い合わせである。**
 */
export function suggestNeedsCheck(state: VenueState): readonly Suggestion[] {
  if (!state.policy.assignNeedsCheck) return [];

  // 案内する席が無いときが大半なので、そこを先に抜ける（`tick` ごとに呼ばれる）。
  const uncertain: readonly Table[] = uncertainTables(state);
  if (uncertain.length === 0) return [];
  if (assignableTables(state).length > 0) return [];

  const tables = orderTables(uncertain, state.policy);
  const guided = new Set<TicketId>();
  const suggestions: Suggestion[] = [];

  for (const table of tables) {
    const candidates: readonly Ticket[] = candidatesFor(table, state.tickets).filter(
      (ticket) => !guided.has(ticket.id),
    );
    const picked = pickCandidate(candidates, table, state.policy);
    if (picked === null) continue;
    guided.add(picked.ticket.id);
    suggestions.push({ ticketId: picked.ticket.id, tableId: table.id });
  }
  return suggestions;
}

/**
 * その人が、その席を案内されているか。
 *
 * **画面もコマンドのガードもこれを見る。** 案内された人だけが「空いていたので
 * 座ります」を押せる（`earlyCheckInAllowed`）。案内を出す式と、着席してよいかを
 * 判定する式が別々になっていると、必ずどこかで食い違う（PR 9 で一度起きた）。
 */
export function guidedTo(state: VenueState, ticketId: TicketId, tableId: TableId): boolean {
  return suggestNeedsCheck(state).some(
    (suggestion) => suggestion.ticketId === ticketId && suggestion.tableId === tableId,
  );
}

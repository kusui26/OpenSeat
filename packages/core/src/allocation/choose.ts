/**
 * 割当の選択（全体プラン 7.6）。
 *
 * **この関数は状態を変えない。** 「誰をどの席に案内すべきか」を決めるだけで、
 * 状態への反映（`WAITING → CALLED`、`FREE → HELD`）は PR 6 の責務である。
 * 分けてあるのは、7.6 のエッジケースを状態遷移の都合に邪魔されずに
 * 検証できるようにするため。
 *
 * **方針は「ロス最小を基本、長く待つ人を保護」。** 一文で説明できることを
 * 優先しており、最適化の精度は追わない（7.1）。`fairnessOverrideMin` を
 * 0 にすれば厳密な先着順、`Infinity` にすれば純粋な best fit になる。
 */

import type { Policy, TableOrderKey } from '../domain/policy.js';
import { fitsCapacity, satisfiesTags, type Table } from '../domain/table.js';
import { comparePriority, type Ticket } from '../domain/ticket.js';
import type { TableId, TicketId } from '../domain/ids.js';
import type { VenueState } from '../domain/state.js';
import { minutes } from '../time.js';

/** なぜその人が選ばれたか。利用者への説明と、シミュレーションの統計に使う。 */
export const ASSIGNMENT_REASONS = ['only_candidate', 'best_fit', 'fairness_override'] as const;

export type AssignmentReason = (typeof ASSIGNMENT_REASONS)[number];

/** 1 組を 1 つの席へ案内する決定。 */
export interface Assignment {
  readonly ticketId: TicketId;
  readonly tableId: TableId;
  readonly reason: AssignmentReason;
}

// ---- 席の処理順（7.6） ----

function ascending(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function descending(a: number, b: number): number {
  return ascending(b, a);
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 一度も退席が確認されていない席は、最も古いものとして扱う。 */
function verifiedAt(table: Table): number {
  return table.verifiedFreeAt ?? Number.NEGATIVE_INFINITY;
}

const TABLE_COMPARATORS: Readonly<Record<TableOrderKey, (a: Table, b: Table) => number>> = {
  /** 大きい席を大人数のために残す。 */
  capacity_asc: (a, b) => ascending(a.capacity, b.capacity),
  /**
   * 退席が新しく確認された席を先に埋める。
   * 長時間「空席」のままの席は、ピーク時ほど無断利用されている可能性が高い（7.6）。
   */
  verified_free_desc: (a, b) => descending(verifiedAt(a), verifiedAt(b)),
  /** 管理者が決めた順。「入口に近い席から埋める」のような運用を表す。 */
  admin_rank: (a, b) => ascending(a.adminRank, b.adminRank),
  label: (a, b) => compareStrings(a.label, b.label),
};

/**
 * 空席を埋める順に並べる。
 *
 * `policy.tableOrder` の鍵を先頭から順に使い、決着しなければ次の鍵へ進む。
 * 最後は席の ID で決着させる。**これにより結果が入力の並び順に依存しない。**
 */
export function orderTables(tables: readonly Table[], policy: Policy): readonly Table[] {
  return [...tables].sort((a, b) => compareByKeys(a, b, policy.tableOrder));
}

function compareByKeys(a: Table, b: Table, keys: readonly TableOrderKey[]): number {
  for (const key of keys) {
    const result = TABLE_COMPARATORS[key](a, b);
    if (result !== 0) return result;
  }
  return compareStrings(a.id, b.id);
}

/** 割当の対象になる席。確実に空いていて、管理対象であること。 */
export function assignableTables(state: VenueState): readonly Table[] {
  return state.tables.filter((table) => table.enabled && table.status === 'FREE');
}

// ---- 候補の絞り込み（7.6） ----

/**
 * その席に案内しうる人。
 *
 * 待っていて、人数が定員に収まり、希望タグを満たすこと。
 * **希望タグは候補を絞るだけで、順番には影響しない**（7.6）。
 */
export function candidatesFor(table: Table, tickets: readonly Ticket[]): readonly Ticket[] {
  return tickets.filter(
    (ticket) =>
      ticket.state === 'WAITING' &&
      fitsCapacity(table, ticket.partySize) &&
      satisfiesTags(table, ticket.requiredTags),
  );
}

// ---- 候補の中から 1 人を選ぶ（7.6） ----

/** 席の定員と人数の差。小さいほど席を無駄にしない。 */
export function waste(table: Table, ticket: Ticket): number {
  return table.capacity - ticket.partySize;
}

export interface Pick {
  readonly ticket: Ticket;
  readonly reason: AssignmentReason;
}

/**
 * 候補の中から 1 人を選ぶ。
 *
 * 1. ロス（定員 − 人数）が最小の候補群から、最も早く受付した人を選ぶ（best fit）
 * 2. ただし、候補の中で最も長く待っている人が best fit の人より
 *    `fairnessOverrideMin` 以上長く待っていれば、その人を優先する
 *
 * **現在時刻を使わない。** 2 人の待ち時間の差は、どちらも「現在時刻 − 受付時刻」
 * なので現在時刻が打ち消し合い、受付時刻の差だけで決まる。
 */
export function pickCandidate(
  candidates: readonly Ticket[],
  table: Table,
  policy: Policy,
): Pick | null {
  const byPriority = [...candidates].sort(comparePriority);
  const longest = byPriority[0];
  if (longest === undefined) return null;
  if (byPriority.length === 1) return { ticket: longest, reason: 'only_candidate' };

  const minWaste = Math.min(...candidates.map((candidate) => waste(table, candidate)));
  const bestFit = byPriority.find((candidate) => waste(table, candidate) === minWaste) ?? longest;
  if (bestFit.id === longest.id) return { ticket: bestFit, reason: 'best_fit' };

  // longest のほうが受付が早いので、この差は 0 以上になる。
  const gap = bestFit.priorityAt - longest.priorityAt;
  if (gap >= minutes(policy.fairnessOverrideMin)) {
    return { ticket: longest, reason: 'fairness_override' };
  }
  return { ticket: bestFit, reason: 'best_fit' };
}

// ---- 全体の割当 ----

/**
 * いま案内すべき組と席の組み合わせを決める。
 *
 * 席を定員の小さい順に処理し、それぞれに 1 人を選ぶ。1 人が 2 つの席に
 * 案内されることはなく、1 つの席に 2 人が案内されることもない。
 *
 * **状態を変えない。** 呼び出し側が結果を状態に反映する（PR 6）。
 *
 * **再割当はしない。** すでに呼び出されている人（`CALLED`）は候補に含めない。
 * より良い席が空いても席を入れ替えると混乱するため（7.6）。
 */
export function chooseAssignments(state: VenueState): readonly Assignment[] {
  const tables = orderTables(assignableTables(state), state.policy);
  const assigned = new Set<TicketId>();
  const assignments: Assignment[] = [];

  for (const table of tables) {
    const candidates = candidatesFor(table, state.tickets).filter(
      (ticket) => !assigned.has(ticket.id),
    );
    const picked = pickCandidate(candidates, table, state.policy);
    if (picked === null) continue;
    assigned.add(picked.ticket.id);
    assignments.push({
      ticketId: picked.ticket.id,
      tableId: table.id,
      reason: picked.reason,
    });
  }
  return assignments;
}

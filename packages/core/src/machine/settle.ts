/**
 * 状態を落ち着かせる。**`apply` と `tick` が共有する出口である。**
 *
 * 手順は 3 つ。
 *
 * 1. **席の期限を明かす。** 片付けの猶予が過ぎた席を空席に戻す
 * 2. **割当を実行する。** 空席と待ちが噛み合っていれば呼び出す
 * 3. **不変条件を検査する。** 破れていたら変更を破棄して拒否する
 *
 * どちらもここを通らずに状態を返さない。だから「空席があるのに誰も呼ばれない」
 * が起きない。
 *
 * **なぜ席の期限だけをここで見るのか。** 期限には 2 種類ある。
 *
 * | 期限 | 誰が見るか | なぜ |
 * |---|---|---|
 * | チケットの期限（ホールド・保留・絶対上限・放置） | `tick` だけ | 利用者の操作と競合する。「期限切れの直前に押した」を巡って時計の担当が 2 つあると、どちらが先かで結果が変わる |
 * | 席の期限（片付けの猶予など） | `apply` と `tick` の両方（ここ） | 席には意思が無い。時計が進めば必ず明けているので、競合しない。**割当の前に明かしておかないと、空いているはずの席が次の人に渡らない** |
 */

import { findTable, withTable, type VenueState } from '../domain/state.js';
import type { Table } from '../domain/table.js';
import type { Decision } from '../decision.js';
import { checkInvariants, formatViolations } from '../invariant.js';
import { err, ok, type Result } from '../result.js';
import { reached, type Timestamp } from '../time.js';
import { runAllocation } from './allocate.js';
import { turnoverEndsAt } from './deadlines.js';
import type { DomainEvent } from './events.js';
import { POST_ALLOCATION_INVARIANTS, STATE_INVARIANTS } from './invariants.js';
import { rejection, type Rejection } from './rejection.js';
import { tableTransition } from './transition.js';

/** 組み立てただけの変更。まだ割当も検査も通っていない。 */
export type Draft = Decision<VenueState, DomainEvent>;

export type Outcome = Result<Draft, Rejection>;

/** 期限の連鎖が止まらない形を作らないための上限。 */
const MAX_CHAIN = 8;

// ---- 席の期限（全体プラン 7.6 の片付けの猶予） ----

/**
 * 席に起きること。
 *
 * いまは片付けの猶予が明けることだけ。整合性の回復（PR 10）で、上限超過・
 * 無断利用の経過・確認要の自動解放が加わる。
 */
type TableDueKind = 'TURNOVER_DONE';

interface TableDue {
  readonly kind: TableDueKind;
  readonly at: Timestamp;
}

/**
 * その席に設定されている期限をすべて並べる。
 *
 * **席の期限は `reached()` で測る。** チケットの期限が利用者に与える猶予なのに
 * 対し、席の待ちは設備の都合なので、ちょうどで終わらせる。片付けの猶予を 0 分に
 * した施設で、本当に待ち時間ゼロになるようにするためである（`time.ts`）。
 */
function tableDeadlinesOf(state: VenueState, table: Table): readonly TableDue[] {
  const candidates: readonly (readonly [TableDueKind, Timestamp | null])[] = [
    ['TURNOVER_DONE', turnoverEndsAt(table, state.policy)],
  ];
  return candidates
    .filter((entry): entry is readonly [TableDueKind, Timestamp] => entry[1] !== null)
    .map(([kind, at]) => ({ kind, at }));
}

function earliestTableDue(state: VenueState, table: Table, now: Timestamp): TableDue | null {
  const passed: readonly TableDue[] = tableDeadlinesOf(state, table).filter((due) =>
    reached(due.at, now),
  );
  return passed.reduce<TableDue | null>(
    (best, due) => (best === null || due.at < best.at ? due : best),
    null,
  );
}

/**
 * 片付けの猶予が明けた（全体プラン 7.6）。
 *
 * 行き先は、対象外にする操作が保留されていたかで変わる。保留されていれば、
 * ここで管理対象から外す（`enabled` を落とし、予約も消す）。運用中の席を即座に
 * 外すと呼び出し中の人に影響するため、この瞬間まで待っていた。
 */
function finishTurnover(state: VenueState, table: Table, now: Timestamp): Outcome {
  const moved = tableTransition({ state, table, now }, 'TURNOVER_DONE');
  if (!moved.ok) return err(moved.error);

  const disabled: boolean = moved.value === 'DISABLED';
  const next: Table = {
    ...table,
    status: moved.value,
    statusSince: now,
    enabled: disabled ? false : table.enabled,
    disableAfterCurrent: false,
  };
  const happened: DomainEvent = disabled
    ? { type: 'TableDisabled', at: now, tableId: table.id }
    : { type: 'TableFreed', at: now, tableId: table.id, releasedTicketId: null };
  return ok({ state: withTable(state, next), events: [happened] });
}

function settleTableDue(state: VenueState, table: Table, due: TableDue, now: Timestamp): Outcome {
  switch (due.kind) {
    case 'TURNOVER_DONE':
      return finishTurnover(state, table, now);
  }
}

/** 1 つの席について、来ている期限をすべて処理する。 */
function settleTable(state: VenueState, id: string, now: Timestamp): Outcome {
  let current: VenueState = state;
  const events: DomainEvent[] = [];

  for (let step = 0; step < MAX_CHAIN; step += 1) {
    const table: Table | undefined = findTable(current, id);
    if (table === undefined) break;
    const due: TableDue | null = earliestTableDue(current, table, now);
    if (due === null) break;

    // その期限の時刻で処理する（`tick.ts` と同じ理由）。
    const settled = settleTableDue(current, table, due, due.at);
    if (!settled.ok) return err(settled.error);
    current = settled.value.state;
    events.push(...settled.value.events);
  }
  return ok({ state: current, events });
}

function settleTables(state: VenueState, now: Timestamp): Outcome {
  let current: VenueState = state;
  const events: DomainEvent[] = [];

  for (const id of state.tables.map((table) => table.id)) {
    const settled = settleTable(current, id, now);
    if (!settled.ok) return err(settled.error);
    current = settled.value.state;
    events.push(...settled.value.events);
  }
  return ok({ state: current, events });
}

// ---- 出口 ----

/**
 * 席の期限を明かし、割当を実行し、不変条件を検査して締める。
 *
 * `no_starvation`（収まる空席があるのに待ちが残らない）をここで検査できるのは、
 * 直前に割当を実行しているからである。PR 3 で「割当の直後にしか成立しない」と
 * して常時検査から外した条件が、ここで常時検査に戻る。
 */
export function settle(drafted: Draft, now: Timestamp): Outcome {
  const tables = settleTables(drafted.state, now);
  if (!tables.ok) return err(tables.error);

  const allocated = runAllocation(tables.value.state, now);
  if (!allocated.ok) return err(allocated.error);

  const violations = checkInvariants(
    [...STATE_INVARIANTS, ...POST_ALLOCATION_INVARIANTS],
    allocated.value.state,
  );
  if (violations.length > 0) {
    return err(rejection('INVARIANT_VIOLATED', formatViolations(violations)));
  }
  return ok({
    state: allocated.value.state,
    events: [...drafted.events, ...tables.value.events, ...allocated.value.events],
  });
}

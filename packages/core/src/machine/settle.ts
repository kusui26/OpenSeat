/**
 * 状態を落ち着かせる。**`apply` と `tick` が共有する出口である。**
 *
 * 手順は 3 つ。
 *
 * 1. **席の期限を明かす。** 片付けの猶予が過ぎた席を空席に戻し、運用から
 *    外れる席を外す
 * 2. **割当を実行する。** 空席と待ちが噛み合っていれば呼び出す
 * 3. **不変条件を検査する。** 破れていたら変更を破棄して拒否する
 * 4. **時計を刻む。** ここまで進んだことを状態に残す（9.4、`clock.ts`）
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

import { findTable, findTicket, withTable, withTicket, type VenueState } from '../domain/state.js';
import { leftService, type Table } from '../domain/table.js';
import type { Ticket } from '../domain/ticket.js';
import type { TicketId } from '../domain/ids.js';
import type { Decision } from '../decision.js';
import { checkInvariants, formatViolations } from '../invariant.js';
import { err, ok, type Result } from '../result.js';
import { reached, type Timestamp } from '../time.js';
import { runAllocation } from './allocate.js';
import { withClock } from './clock.js';
import { autoFreeAt, turnoverEndsAt, unknownAgedAt } from './deadlines.js';
import type { DomainEvent } from './events.js';
import { POST_ALLOCATION_INVARIANTS, STATE_INVARIANTS } from './invariants.js';
import { rejection, type Rejection } from './rejection.js';
import { endedTicket } from './release.js';
import { tableTransition, ticketTransition } from './transition.js';

/** 組み立てただけの変更。まだ割当も検査も通っていない。 */
export type Draft = Decision<VenueState, DomainEvent>;

export type Outcome = Result<Draft, Rejection>;

/** 期限の連鎖が止まらない形を作らないための上限。 */
const MAX_CHAIN = 8;

// ---- 席の期限（全体プラン 7.6 の片付けの猶予） ----

/**
 * 席に起きること。
 *
 * 片付けの猶予が明けること（7.6）、整合性の回復の 5 層目（7.11）、運用から
 * 外れること（7.6 のエッジケースと 7.14）。着席中の席が「確認要」に落ちるのは、
 * 利用者の操作と競合するのでチケット側（`tick.ts`）が見る。
 */
type TableDueKind = 'TURNOVER_DONE' | 'UNKNOWN_AGED' | 'AUTO_FREE' | 'LEAVES_SERVICE';

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
    ['UNKNOWN_AGED', unknownAgedAt(table, state.policy)],
    ['AUTO_FREE', autoFreeAt(table, state.policy)],
    ['LEAVES_SERVICE', leavesServiceAt(state, table)],
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

/**
 * 無断利用の想定滞在時間が過ぎた（7.11 の 5 層目）。
 *
 * 誰が使っているか分からないまま置かれていた席を「たぶん空いている」に
 * 落とす。次の利用者かスタッフが確かめれば解消する。
 */
function ageUnknown(state: VenueState, table: Table, now: Timestamp): Outcome {
  const moved = tableTransition({ state, table, now }, 'UNKNOWN_AGED');
  if (!moved.ok) return err(moved.error);
  const uncertain: Table = { ...table, status: moved.value, statusSince: now };
  return ok({
    state: withTable(state, uncertain),
    events: [
      { type: 'TableNeedsCheck', at: now, tableId: table.id, reason: 'unknown_aged', occupantTicketId: null },
    ],
  });
}

/**
 * 「確認要」のまま放置された席を、自動で空席に戻す（7.11 の 5 層目）。
 *
 * **これが「最悪でも席が永久に塞がらない」を支えている唯一の仕掛けである。**
 * `needsCheckAutoFreeMin` を `null` にすると働かず、スタッフの確認を待つことに
 * なる（ガード `autoFreeEnabled`）。
 *
 * 着席中のチケットが結びついたままなら、**その人は申告せずに去ったものとして
 * 扱い**、チケットも終わらせる。残すと席とチケットの対応が壊れる。
 */
function autoFree(state: VenueState, table: Table, now: Timestamp): Outcome {
  const moved = tableTransition({ state, table, now }, 'AUTO_FREE');
  if (!moved.ok) return err(moved.error);

  const freed: Table = {
    ...table,
    status: moved.value,
    statusSince: now,
    occupantTicketId: null,
    verifiedFreeAt: now,
  };
  const reclaimed = reclaimSeat(withTable(state, freed), table.occupantTicketId, now);
  if (!reclaimed.ok) return err(reclaimed.error);
  return ok({
    state: reclaimed.value.state,
    events: [
      { type: 'TableFreed', at: now, tableId: table.id, releasedTicketId: null },
      ...reclaimed.value.events,
    ],
  });
}

/**
 * 席を回収された人のチケットを終わらせる。誰も居なければ何もしない。
 *
 * **「申告せずに去った」と見なす道が 3 つある。** 自動解放（ここ、7.11 の 5 層目）、
 * 次の利用者が空席だと確かめたとき、スタッフが空席だと確かめたとき
 * （どちらも `apply.ts` の `CONFIRM_FREE` と `CHECK_IN_EARLY`）。**どれも同じ
 * 終わり方（`auto_release`）にしてある。** 席を空ける根拠が時間か人かの違いで、
 * 本人にとって起きたことは同じだからである。
 */
export function reclaimSeat(state: VenueState, ticketId: TicketId | null, now: Timestamp): Outcome {
  const ticket: Ticket | undefined = ticketId === null ? undefined : findTicket(state, ticketId);
  if (ticket === undefined) return ok({ state, events: [] });

  const moved = ticketTransition({ state, ticket, now, table: null }, 'SEAT_RECLAIMED');
  if (!moved.ok) return err(moved.error);
  return ok({
    state: withTicket(state, endedTicket(ticket, moved.value, 'auto_release', now)),
    events: [
      {
        type: 'TicketEnded',
        at: now,
        ticketId: ticket.id,
        endReason: 'auto_release',
        by: null,
        cancelReason: null,
      },
    ],
  });
}

/**
 * 空席が運用から外れる時刻（全体プラン 7.6 のエッジケース、7.14）。
 *
 * 理由は 2 つあり、どちらも **「利用が終わって空いた瞬間」が期限** である。
 *
 * | 理由 | いつ | 管理対象（`enabled`） |
 * |---|---|---|
 * | 対象外にする予約がある（7.6） | 管理者が外した席の利用が終わった | 落とす |
 * | 運用していない（7.14） | 運用終了のときに使われていた席が空いた | **そのまま** |
 *
 * 2 つを分けているのは、**運用時間外と「対象席でない」は別のこと**だからである。
 * 閉店で外れた席は次の `OPEN` で戻るが、管理者が外した席は戻らない。
 *
 * **すでに空いている席には、ここは効かない。** 「外す」と決めた時点で空席だった
 * 席は、その瞬間に外れる（`apply.ts` の `DISABLE_TABLE`、`venue.ts` の
 * `closeVenue`）。ここが拾うのは、そのとき使われていた席だけである。だから
 * `statusSince`（空いた時刻）が、そのまま外れる時刻になる。
 */
function leavesServiceAt(state: VenueState, table: Table): Timestamp | null {
  if (table.status !== 'FREE') return null;
  if (!table.disableAfterCurrent && state.operating) return null;
  return table.statusSince;
}

/**
 * 空席を運用から外す。
 *
 * 出口（ここ）と、外すと決めた瞬間（`apply.ts`）から呼ばれる。
 */
export function leaveService(state: VenueState, table: Table, now: Timestamp): Outcome {
  const moved = tableTransition({ state, table, now }, 'CLOSE');
  if (!moved.ok) return err(moved.error);
  // 対象外の予約があったときだけ、管理対象から本当に外す（`leftService`）。
  return ok({
    state: withTable(state, leftService(table, moved.value, now)),
    events: [{ type: 'TableDisabled', at: now, tableId: table.id }],
  });
}

function settleTableDue(state: VenueState, table: Table, due: TableDue, now: Timestamp): Outcome {
  switch (due.kind) {
    case 'TURNOVER_DONE':
      return finishTurnover(state, table, now);
    case 'UNKNOWN_AGED':
      return ageUnknown(state, table, now);
    case 'AUTO_FREE':
      return autoFree(state, table, now);
    case 'LEAVES_SERVICE':
      return leaveService(state, table, now);
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
    // ここまで進んだことを刻む。次に戻った時刻が来たら入口で落とせる（9.4）。
    state: withClock(allocated.value.state, now),
    events: [...drafted.events, ...tables.value.events, ...allocated.value.events],
  });
}

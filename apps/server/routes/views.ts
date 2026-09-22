/**
 * `core` の状態を、契約の形に写す。
 *
 * **ここに業務判断は書かない**（CLAUDE.md 3.1）。「いま押せる操作」も「あと何分か」も、
 * **`core` に聞いた答え**を並べ替えているだけである。
 *
 * **秘密は 1 つも通らない。** 座席 QR のトークン、端末の匿名トークン、チケットの
 * 秘密パラメータ、席の内部 ID はここに現れない（CLAUDE.md 7 章）。
 */

import {
  dispatch,
  estimateForJoin,
  estimateForTicket,
  findTable,
  managedTables,
  minutes,
  ticketOwner,
  type Command,
  type CommandType,
  type Table,
  type Ticket,
  type Timestamp,
  type VenueState,
} from '@openseat/core';
import type {
  TableView,
  TicketResponse,
  TicketView,
  VenueStatusResponse,
  WaitEstimate,
} from '@openseat/shared';
import type { VenueHandle } from './deps.js';

/**
 * チケットの画面に並ぶ操作。
 *
 * **席を読まずに押せるものだけ**である。着席・席の変更・前倒し・「誰か座っていた」は
 * 座席 QR から出す（7.8。**「その席にいる証拠」を求めるのは着席確認だけ**という
 * 決めごとによる）。心拍（`HEARTBEAT`）はボタンではないので入れない。
 */
const OWNER_BUTTONS = [
  'READY',
  'EXTEND',
  'PASS',
  'PAUSE',
  'STILL_HERE',
  'CHANGE_PARTY_SIZE',
  'CHECK_OUT',
  'CANCEL',
] as const satisfies readonly CommandType[];

type OwnerButton = (typeof OWNER_BUTTONS)[number];

/**
 * その操作を、いま試したらどうなるか。
 *
 * **通るかどうかは `core` に聞く。** 画面のための判定を別に書くと、
 * 「できます」と出したのに拒否される、という食い違いが必ずどこかで起きる
 * （`core` の `resolveTableScan` が同じ理由でそうしている）。
 *
 * `dispatch` は純粋なので、**試しても何も起きない。**
 */
function attempt(state: VenueState, ticket: Ticket, type: OwnerButton, now: Timestamp): boolean {
  return dispatch(state, ticketOwner(ticket.id), probe(ticket, type), now).ok;
}

/** 試すための、いちばん当たり障りのない引数。 */
function probe(ticket: Ticket, type: OwnerButton): Command {
  switch (type) {
    case 'READY':
    case 'EXTEND':
    case 'PASS':
    case 'PAUSE':
    case 'STILL_HERE':
      return { type, ticketId: ticket.id };
    case 'CHANGE_PARTY_SIZE':
      // いまと同じ人数で試す。**増やせるかどうかは本番の要求が決める**
      // （定員と `max_party_size` を見るのは `core` である）。
      return { type, ticketId: ticket.id, partySize: ticket.partySize };
    case 'CHECK_OUT':
      return { type, ticketId: ticket.id, by: 'user' };
    case 'CANCEL':
      return { type, ticketId: ticket.id, by: 'user', reason: null };
  }
}

/** いま押せる操作。 */
export function actionsFor(
  state: VenueState,
  ticket: Ticket,
  now: Timestamp,
): readonly CommandType[] {
  return OWNER_BUTTONS.filter((type) => attempt(state, ticket, type, now));
}

/**
 * 着席時間の目安（7.10）。
 *
 * **「目安」であって、取り上げる時刻ではない**（[ADR-0009](../../../docs/adr/0009-seating-time-limit.md)）。
 * 待っている人がいるときだけ知らせを出すかどうか（`limitOnlyWhenWaiting`）は
 * 通知の話で、**施設が掲げている目安そのものは、座っているあいだ常にある。**
 */
function timeLimitOf(state: VenueState, ticket: Ticket, now: Timestamp): TicketView['timeLimit'] {
  if (ticket.state !== 'SEATED' || ticket.seatedAt === null) return null;
  if (state.policy.timeLimitMode === 'off') return null;
  const at: Timestamp = ticket.seatedAt + minutes(state.policy.timeLimitMin);
  return { at, minutes: state.policy.timeLimitMin, reached: now >= at };
}

/** 利用者に見せるチケット。 */
export function ticketView(state: VenueState, ticket: Ticket, now: Timestamp): TicketView {
  const table: Table | undefined = ticket.tableId === null ? undefined : findTable(state, ticket.tableId);
  return {
    id: ticket.id,
    code: ticket.code,
    state: ticket.state,
    partySize: ticket.partySize,
    requiredTags: [...ticket.requiredTags],
    tableLabel: table?.label ?? null,
    holdDeadline: ticket.holdDeadline,
    pauseDeadline: ticket.pauseDeadline,
    extensionsLeft: Math.max(0, state.policy.maxExtensions - ticket.extensions),
    eta: estimateForTicket(state, ticket, now),
    timeLimit: timeLimitOf(state, ticket, now),
    endReason: ticket.endReason,
    actions: [...actionsFor(state, ticket, now)],
  };
}

/** ボードと空き状況に出す席。**誰が座っているかは出さない。** */
export function tableView(state: VenueState, table: Table): TableView {
  const occupant: Ticket | undefined =
    table.status === 'HELD' && table.occupantTicketId !== null
      ? state.tickets.find((ticket) => ticket.id === table.occupantTicketId)
      : undefined;
  return {
    label: table.label,
    capacity: table.capacity,
    tags: [...table.tags],
    status: table.status,
    calledCode: occupant?.code ?? null,
  };
}

/**
 * 人数ごとの目安。
 *
 * **人数で待ち時間が変わる**（4 名席は少ない）ので、1 つの数字では答えられない。
 */
export function estimatesFor(
  state: VenueState,
  sizes: readonly number[],
  now: Timestamp,
): readonly { readonly partySize: number; readonly eta: WaitEstimate }[] {
  return sizes.map((partySize) => ({
    partySize,
    eta: estimateForJoin(state, { partySize, requiredTags: [] }, now),
  }));
}

// ---- 返しそのもの ----
//
// **1 回で取るときも、流し続けるときも、ここを通る**（9.5、ADR-0018）。
// 組み立てを 2 か所に置くと、**同じものを見ているはずの 2 つの道が、違う姿を
// 返す**ようになる。

/**
 * 本人に見せるチケット（`GET /api/t/{ticket}` と、その配信）。
 *
 * **見つからなければ `null`。** 流している最中にチケットが消えることは無いが、
 * 消えていないことをここで確かめておけば、呼ぶ側が同じ確認を書かずに済む。
 */
export function ticketResponse(
  state: VenueState,
  ticketId: string,
  now: Timestamp,
): TicketResponse | null {
  const ticket: Ticket | undefined = state.tickets.find((item) => item.id === ticketId);
  if (ticket === undefined) return null;
  return { serverNow: now, ticket: ticketView(state, ticket, now) };
}

/** 待っているとみなす状態。着席した人は行列から出ている。 */
const QUEUED: readonly string[] = ['WAITING', 'PAUSED', 'CALLED'];

/**
 * 施設のいまの様子（`GET /api/v/{venue}/status` と、その配信）。
 *
 * **席の内訳は数だけ。** どの席が空いているかを外に出すと、並ばずに直行する人が
 * 出て、案内された人の席が塞がる（7.11 の事故が増える）。
 */
export function venueStatus(
  venue: VenueHandle,
  state: VenueState,
  sizes: readonly number[],
  now: Timestamp,
): VenueStatusResponse {
  const managed: readonly Table[] = managedTables(state);
  return {
    serverNow: now,
    venue: profileOf(venue, state),
    waiting: state.tickets.filter((ticket) => QUEUED.includes(ticket.state)).length,
    freeTables: managed.filter((table) => table.status === 'FREE').length,
    managedTables: managed.length,
    estimates: [...estimatesFor(state, sizes, now)],
    longWaitConfirmMin: state.policy.longWaitConfirmMin,
  };
}

/** 施設そのものの姿。**運用しているか、受付を開いているか、いつ終わるか。** */
function profileOf(venue: VenueHandle, state: VenueState): VenueStatusResponse['venue'] {
  return {
    slug: venue.slug,
    name: venue.name,
    timezone: venue.timezone,
    operating: state.operating,
    joinOpen: state.joinOpen,
    closesAt: state.closesAt,
  };
}

/**
 * 不変条件（全体プラン 9.12、CLAUDE.md 3.2 の 3）。
 *
 * 破られたら製品が成立しない条件を、**名前付きの述語として 1 か所に宣言**する。
 * 同じ宣言を次の 3 か所で使い回し、二重には書かない。
 *
 * 1. 実行時の検査 — `apply` と `tick` の出口で通す（PR 5 以降）
 * 2. 性質テスト — fast-check のランダムなコマンド列の判定に使う
 * 3. シミュレーションのファズ — 大量に流して違反を探す（PR 8 以降）
 *
 * **検査するタイミングで 3 つに分けてある。**
 *
 * | 群 | いつ成り立つか |
 * |---|---|
 * | `STATE_INVARIANTS` | 常に。すべてのコマンド適用と `tick` の出口 |
 * | `POST_ALLOCATION_INVARIANTS` | 割当を実行した直後にだけ |
 * | `TRANSITION_INVARIANTS` | 状態遷移の前後の 2 状態について |
 *
 * 分けてあるのは、`no_starvation`（収まる空席があるのに待ちが残らない）が
 * 割当の直後にしか成立しないためである。呼び出しの途中や、席が解放された直後は
 * 一時的に破れる。常時検査の群に混ぜると、正常な状態を違反として弾いてしまう。
 */

import { fitsCapacity, satisfiesTags, type Table, type TableStatus } from '../domain/table.js';
import { END_REASON_STATES, isTerminal, type Ticket } from '../domain/ticket.js';
import { activeTickets, findTable, findTicket, sameVenueState, type VenueState } from '../domain/state.js';
import { invariant, transitionInvariant, type Invariant, type TransitionInvariant } from '../invariant.js';

// ---- 小さな助け ----

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function assignedTickets(state: VenueState): readonly Ticket[] {
  return state.tickets.filter((ticket) => ticket.state === 'CALLED' || ticket.state === 'SEATED');
}

function tableOf(state: VenueState, ticket: Ticket): Table | undefined {
  return ticket.tableId === null ? undefined : findTable(state, ticket.tableId);
}

// ---- 常に成り立つ不変条件 ----

/**
 * 1. 識別子の一意性。
 *
 * 型では表せない。重複があると引き当てが最初の 1 件を返し、もう片方が
 * 永久に触れなくなる。
 */
export const uniqueIds: Invariant<VenueState> = invariant(
  'unique_ids',
  'チケット ID とテーブル ID がそれぞれ一意',
  (state) =>
    !hasDuplicates(state.tickets.map((ticket) => ticket.id)) &&
    !hasDuplicates(state.tables.map((table) => table.id)),
);

/**
 * 2. 生きているチケットの表示コードが一意。
 *
 * 呼び出しボードに出し、口頭でも読み上げるため、同時に 2 枚あると
 * 別人が席へ向かってしまう。終端に達したものは重複してよい。
 */
export const uniqueActiveCodes: Invariant<VenueState> = invariant(
  'unique_active_codes',
  '生きているチケットの表示コードが一意',
  (state) => !hasDuplicates(activeTickets(state).map((ticket) => ticket.code)),
);

/** 3. 席を持つべき状態のチケットは、実在する席を持つ（全体プラン 9.12 の 2）。 */
export const assignedHasTable: Invariant<VenueState> = invariant(
  'assigned_has_table',
  'CALLED と SEATED のチケットは実在する席を 1 つ持つ',
  (state) => assignedTickets(state).every((ticket) => tableOf(state, ticket) !== undefined),
);

/**
 * 4. 終端に達したチケットは席を持たない。
 *
 * 持ったままだと、その席が誰にも割り当てられなくなる。
 */
export const terminalHoldsNoTable: Invariant<VenueState> = invariant(
  'terminal_holds_no_table',
  '終端に達したチケットは席を持たない',
  (state) =>
    state.tickets
      .filter((ticket) => isTerminal(ticket.state))
      .every((ticket) => ticket.tableId === null),
);

/**
 * 5. 席とチケットの参照が双方向に一致する。
 *
 * 片方向だけ見ていると、席が「誰かのもの」になったままチケット側は
 * 別の席を指している、という食い違いを見逃す。
 */
export const tableLinkIsMutual: Invariant<VenueState> = invariant(
  'table_link_is_mutual',
  '席の occupantTicketId とチケットの tableId が双方向に一致する',
  (state) => {
    const fromTicket = assignedTickets(state).every(
      (ticket) => tableOf(state, ticket)?.occupantTicketId === ticket.id,
    );
    const fromTable = state.tables
      .filter((table) => table.occupantTicketId !== null)
      .every((table) => {
        const ticket = table.occupantTicketId === null ? undefined : findTicket(state, table.occupantTicketId);
        return ticket !== undefined && ticket.tableId === table.id;
      });
    return fromTicket && fromTable;
  },
);

/**
 * 6. チケットの状態と席の状態が対応する。
 *
 * ID が一致していても、席が `FREE` のままなら別の人に割り当てられてしまう。
 *
 * **着席中の席は `OCCUPIED` のほかに `NEEDS_CHECK` も取りうる。** 着席時間の
 * 上限を超えた席（7.10 の `soft`）と、「まだご利用中ですか」に答えが無かった席
 * （7.11 の 2 層目）がこれにあたる。どちらも **「その人がまだ居るか分からない」**
 * という状態で、チケットを終わらせてはいない。終わらせると「まだ居ます」と
 * 答えて戻る道（`STILL_HERE`）が閉じ、次の人を使用中の席へ案内する事故に
 * つながる（7.10 が `hard` を勧めない理由と同じ）。
 */
const SEATED_TABLE_STATUSES: readonly TableStatus[] = ['OCCUPIED', 'NEEDS_CHECK'];

export const assignmentStatusMatches: Invariant<VenueState> = invariant(
  'assignment_status_matches',
  'CALLED の席は HELD、SEATED の席は OCCUPIED か NEEDS_CHECK',
  (state) => assignedTickets(state).every((ticket) => tableMatches(state, ticket)),
);

function tableMatches(state: VenueState, ticket: Ticket): boolean {
  const status: TableStatus | undefined = tableOf(state, ticket)?.status;
  if (status === undefined) return false;
  return ticket.state === 'CALLED' ? status === 'HELD' : SEATED_TABLE_STATUSES.includes(status);
}

/**
 * 7. 1 つの席に、席を持つチケットは最大 1 枚（全体プラン 9.12 の 1）。
 *
 * **これが破られると製品が成立しない。** 2 組が同じ席へ案内される。
 */
export const oneTicketPerTable: Invariant<VenueState> = invariant(
  'one_ticket_per_table',
  '1 つの席に、CALLED または SEATED のチケットは最大 1 枚',
  (state) => !hasDuplicates(assignedTickets(state).map((ticket) => ticket.tableId ?? '')),
);

/**
 * 8. 席を持つ組の人数が、その席の定員に収まる。
 *
 * 割当が保証するが、人数の変更や席の定員の変更で破れうる。
 */
export const assignedPartyFitsCapacity: Invariant<VenueState> = invariant(
  'assigned_party_fits_capacity',
  '席を持つ組の人数が、その席の定員に収まる',
  (state) =>
    assignedTickets(state).every((ticket) => {
      const table = tableOf(state, ticket);
      return table === undefined || fitsCapacity(table, ticket.partySize);
    }),
);

/**
 * 9. 確保中の席には期限がある。
 *
 * 期限が無いと、呼び出しに応じない人のために席が永久に押さえられる。
 */
export const heldTableHasDeadline: Invariant<VenueState> = invariant(
  'held_table_has_deadline',
  'CALLED のチケットは holdDeadline を持ち、その席は HELD である',
  (state) =>
    state.tickets
      .filter((ticket) => ticket.state === 'CALLED')
      .every((ticket) => ticket.holdDeadline !== null),
);

/**
 * 10. 状態に応じた時刻が入っている。
 *
 * | 状態 | 埋まっているべき欄 |
 * |---|---|
 * | `CALLED` | `calledAt`、`holdDeadline` |
 * | `SEATED` | `seatedAt` |
 * | `PAUSED` | `pauseDeadline`、`pausedSince` |
 * | 終端 | `endedAt`、`endReason` |
 *
 * `pausedSince` と `holdRemindedAt` は逆向きにも見る。**その状態以外では空で
 * あること。** `pausedSince` を保留から出るときに消し忘れると、次に保留へ
 * 入ったときに `pausedTotal` が二重に積み上がり、`pauseMaxTotalMin` が実際より
 * 早く尽きる。`holdRemindedAt` を消し忘れると、次の呼び出しで知らせが出ない。
 */
export const stateTimestampsAreSet: Invariant<VenueState> = invariant(
  'state_timestamps_are_set',
  '状態に応じた時刻と終わり方が埋まっており、保留の起点と呼び出しの知らせはその状態のときだけ入る',
  (state) => state.tickets.every(hasRequiredTimestamps),
);

function hasRequiredTimestamps(ticket: Ticket): boolean {
  return (
    hasStateTimestamps(ticket) &&
    pauseStartIsScoped(ticket) &&
    reminderIsScoped(ticket) &&
    seatedNoticesAreScoped(ticket)
  );
}

function hasStateTimestamps(ticket: Ticket): boolean {
  if (ticket.state === 'CALLED') return ticket.calledAt !== null && ticket.holdDeadline !== null;
  if (ticket.state === 'SEATED') return ticket.seatedAt !== null;
  if (ticket.state === 'PAUSED') return ticket.pauseDeadline !== null && ticket.pausedSince !== null;
  if (isTerminal(ticket.state)) return ticket.endedAt !== null && ticket.endReason !== null;
  return true;
}

/** 保留の起点は `PAUSED` のあいだだけ入っている。 */
function pauseStartIsScoped(ticket: Ticket): boolean {
  return ticket.state === 'PAUSED' || ticket.pausedSince === null;
}

/** ホールドの知らせの記録は `CALLED` のあいだだけ入っている。 */
function reminderIsScoped(ticket: Ticket): boolean {
  return ticket.state === 'CALLED' || ticket.holdRemindedAt === null;
}

/**
 * 着席中の知らせの記録は `SEATED` のあいだだけ入っている。
 *
 * 消し忘れると、次に着席したときに問いかけも上限の知らせも出なくなる。
 * この版ではチケットが着席を 2 回することは無いが、飛び込みと前倒しで
 * 着席の入口が増えた（PR 9）ので、条件として置いておく。
 */
function seatedNoticesAreScoped(ticket: Ticket): boolean {
  if (ticket.state === 'SEATED') return true;
  return (
    ticket.stillHereAskedAt === null &&
    ticket.stillHereAnsweredAt === null &&
    ticket.timeLimitNoticedAt === null
  );
}

/**
 * 11. 終わり方と終端状態が、宣言された対応表に一致する。
 *
 * 対応表は PR 1 の `END_REASON_STATES`。「ノーショーなのに CANCELLED」の
 * ような食い違いを、統計に混ざる前に落とす。
 */
export const endReasonMatchesState: Invariant<VenueState> = invariant(
  'end_reason_matches_state',
  '終わり方が、その終端状態に対応している',
  (state) =>
    state.tickets
      .filter((ticket) => ticket.endReason !== null)
      .every((ticket) => ticket.endReason !== null && END_REASON_STATES[ticket.endReason] === ticket.state),
);

/** すべてのコマンド適用と `tick` の出口で検査する不変条件。 */
export const STATE_INVARIANTS: readonly Invariant<VenueState>[] = [
  uniqueIds,
  uniqueActiveCodes,
  assignedHasTable,
  terminalHoldsNoTable,
  tableLinkIsMutual,
  assignmentStatusMatches,
  oneTicketPerTable,
  assignedPartyFitsCapacity,
  heldTableHasDeadline,
  stateTimestampsAreSet,
  endReasonMatchesState,
];

// ---- 割当の直後にだけ成り立つ不変条件 ----

/**
 * 12. 収まる空席があるのに、待っている人が残らない（全体プラン 9.12 の 3）。
 *
 * **割当の直後にしか成立しない。** 席が解放された瞬間や、呼び出しの途中では
 * 一時的に破れる。常時検査の群に混ぜてはならない。
 */
export const noStarvation: Invariant<VenueState> = invariant(
  'no_starvation',
  '割当の直後に、収まる空席があるのに待っている人が残っていない',
  (state) => {
    const free = state.tables.filter((table) => table.enabled && table.status === 'FREE');
    const waiting = state.tickets.filter((ticket) => ticket.state === 'WAITING');
    return !waiting.some((ticket) =>
      free.some((table) => fitsCapacity(table, ticket.partySize) && satisfiesTags(table, ticket.requiredTags)),
    );
  },
);

/** 割当を実行した直後にだけ検査する不変条件。 */
export const POST_ALLOCATION_INVARIANTS: readonly Invariant<VenueState>[] = [noStarvation];

// ---- 遷移の前後について成り立つ不変条件 ----

/**
 * 13. 保留の出入りで順番が変わらない（全体プラン 9.12 の 4）。
 *
 * 「パス」や 1 回目のノーショーで保留に落ちても、順番は保持される（7.7）。
 * これが破れると、譲った人が損をするので誰も譲らなくなる。
 *
 * 順番を意図的に変える操作（人数の増加、`requeue_back`）は保留を経由しないため、
 * この条件には触れない。
 */
export const priorityPreservedAcrossPause: TransitionInvariant<VenueState> = transitionInvariant(
  'priority_preserved_across_pause',
  '保留に入る遷移と保留から出る遷移では priorityAt が変わらない',
  (before, after) =>
    before.tickets.every((old) => {
      const now = findTicket(after, old.id);
      if (now === undefined) return true;
      const crossesPause = (old.state === 'PAUSED') !== (now.state === 'PAUSED');
      return !crossesPause || old.priorityAt === now.priorityAt;
    }),
);

/**
 * 14. 同じ時刻の `tick` は状態を変えない（全体プラン 9.12 の 5）。
 *
 * 呼び出し側が同じ時刻で `tick` を 2 回呼び、その 2 つの状態を渡して検査する。
 * 冪等でないと、`tick` の間隔が変わっただけで結果が変わってしまい、
 * サーバの再起動や時計のずれに耐えられない（9.4）。
 */
export const tickIdempotent: TransitionInvariant<VenueState> = transitionInvariant(
  'tick_idempotent',
  '同じ時刻で tick を 2 回目に呼んでも状態が変わらない',
  (before, after) => sameVenueState(before, after),
);

/** 状態遷移の前後の 2 状態について検査する不変条件。 */
export const TRANSITION_INVARIANTS: readonly TransitionInvariant<VenueState>[] = [
  priorityPreservedAcrossPause,
  tickIdempotent,
];

/**
 * 宣言されているすべての不変条件の名前。
 *
 * 数が減っていないこと（うっかり宣言から外していないこと）をテストで守る。
 */
export const ALL_INVARIANT_NAMES: readonly string[] = [
  ...STATE_INVARIANTS.map((item) => item.name),
  ...POST_ALLOCATION_INVARIANTS.map((item) => item.name),
  ...TRANSITION_INVARIANTS.map((item) => item.name),
];

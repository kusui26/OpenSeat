/**
 * 時刻起因の遷移。
 *
 * ホールドの期限、保留の期限、受付からの絶対上限、放置を、**状態に書いてある
 * 絶対時刻と `now` の比較だけ**で処理する。個別のタイマーは持たない。だから
 * サーバを再起動しても取りこぼさず、シミュレータでも同じ関数で時間を進められる
 * （全体プラン 9.4）。
 *
 * **期限は早いものから順に処理する。** 「先に評価した種類を優先する」にすると、
 * `tick` を 10 秒ごとに呼んだ場合と、止まっていて 1 時間ぶんをまとめて処理した
 * 場合とで、終わり方（`endReason`）が変わってしまう。たとえば保留の期限が
 * 45 分、受付からの上限が 90 分のチケットを 100 分後に処理するとき、種類の順で
 * 決めると `max_age` になるが、10 秒ごとに呼んでいれば `pause_expired` になる。
 * 期限の早い順に処理すれば、どちらでも `pause_expired` になる。
 *
 * **処理はその期限の時刻で行う。** 7 分で切れたホールドは、30 分後に気づいた
 * としても「7 分に切れた」として刻む。現在時刻で刻むと、そこから置かれる次の
 * 期限（保留の 10 分など）が現在時刻より先になり、まとめて処理したときに連鎖が
 * 途切れる。実運用では `tick` が 10 秒ごとに走るので差は 10 秒以内だが、
 * 再起動やスケジューラの遅れで空いた時間を正しく取り戻せる。
 *
 * この設計の裏返しとして、**ガードは時間を見ない**。「どちらへ進むか」は
 * ガードが決め、「いつ進むか」は期限が決める（`guards.ts`）。
 *
 * この性質（時間の飛ばし方によらず同じ状態に落ち着く）は PR 12 で検証する。
 */

import { findTable, findTicket, withTable, withTicket, type VenueState } from '../domain/state.js';
import type { Table } from '../domain/table.js';
import type { Ticket } from '../domain/ticket.js';
import type { Decision } from '../decision.js';
import { err, ok, type Result } from '../result.js';
import { hasPassed, minutes, type Timestamp } from '../time.js';
import { pausedDraft } from './apply.js';
import { settle, type Draft, type Outcome } from './settle.js';
import { closeVenue, endForClose } from './venue.js';
import {
  abandonedAt,
  holdExpiresAt,
  joinCutoffAt,
  venueCloseAt,
  venueClosesAt,
  holdReminderAt,
  maxAgeAt,
  overstayAt,
  pauseExpiresAt,
  stillHereAskAt,
  stillHereTimeoutAt,
  timeLimitNoticeAt,
} from './deadlines.js';
import type { DomainEvent, NeedsCheckReason } from './events.js';
import { rejection, type Rejection } from './rejection.js';
import { endedTicket, releaseHeldTable } from './release.js';
import type { TicketEvent } from './ticket-machine.js';
import { tableTransition, ticketTransition } from './transition.js';

/**
 * 時刻が来て起きること。
 *
 * `REMIND` だけは状態を変えず、知らせを出したことを記録する。ほかの 4 つは
 * 遷移表の事象に対応する。
 */
const DUE_KINDS = [
  // **運用終了を先頭に置く。** 同じ時刻に自分の期限（保留の上限など）と運用終了が
  // 重なったら、施設都合のほうを採る。取り消し（`CANCELLED`）は期限切れ
  // （`EXPIRED`）より説明がやさしく、利用者に厳しくしない側だからである。
  'VENUE_CLOSE',
  'REMIND',
  'HOLD_EXPIRE',
  'PAUSE_EXPIRE',
  'MAX_AGE',
  'ABANDON',
  'TIME_LIMIT_NOTICE',
  'STILL_HERE_ASK',
  'STILL_HERE_TIMEOUT',
  'OVERSTAY',
] as const;

type DueKind = (typeof DUE_KINDS)[number];

interface Due {
  readonly kind: DueKind;
  readonly at: Timestamp;
}

/**
 * そのチケットに設定されている期限をすべて並べる。
 *
 * `null` は「その期限はこのチケットには無い」を表す（`CALLED` に保留の期限は
 * 無い、通知手段を持つ人に放置の期限は無い、など）。判定は `deadlines.ts` に
 * 集めてあり、期限を置く側と見る側で式が分かれないようにしてある。
 */
function deadlinesOf(state: VenueState, ticket: Ticket): readonly Due[] {
  const policy = state.policy;
  const candidates: readonly (readonly [DueKind, Timestamp | null])[] = [
    ['VENUE_CLOSE', venueCloseAt(ticket, state)],
    ['REMIND', holdReminderAt(ticket, policy)],
    ['HOLD_EXPIRE', holdExpiresAt(ticket)],
    ['PAUSE_EXPIRE', pauseExpiresAt(ticket)],
    ['MAX_AGE', maxAgeAt(ticket, policy)],
    ['ABANDON', abandonedAt(ticket, policy)],
    ['TIME_LIMIT_NOTICE', timeLimitNoticeAt(ticket, state)],
    ['STILL_HERE_ASK', stillHereAskAt(ticket, policy)],
    ['STILL_HERE_TIMEOUT', stillHereTimeoutAt(ticket, state)],
    ['OVERSTAY', overstayAt(ticket, state)],
  ];
  return candidates
    .filter((entry): entry is readonly [DueKind, Timestamp] => entry[1] !== null)
    .map(([kind, at]) => ({ kind, at }));
}

/**
 * いま処理すべき期限のうち、もっとも早いもの。
 *
 * 同じ時刻に複数あるときは `DUE_KINDS` の順で決める。知らせ（`REMIND`）が
 * ホールドの期限切れより先に来るのは、この順による。
 */
function earliestDue(state: VenueState, ticket: Ticket, now: Timestamp): Due | null {
  const passed: readonly Due[] = deadlinesOf(state, ticket).filter((due) => hasPassed(due.at, now));
  return passed.reduce<Due | null>((best, due) => (best === null || isEarlier(due, best) ? due : best), null);
}

function isEarlier(candidate: Due, best: Due): boolean {
  if (candidate.at !== best.at) return candidate.at < best.at;
  return DUE_KINDS.indexOf(candidate.kind) < DUE_KINDS.indexOf(best.kind);
}

// ---- 期限ごとの処理 ----

/**
 * 「あと 2 分で無効になります」（全体プラン 7.7 の 3）。
 *
 * 状態は変えない。出したことを記録して、同じ知らせを繰り返さないようにする。
 */
function remind(state: VenueState, ticket: Ticket, now: Timestamp): Outcome {
  if (ticket.tableId === null || ticket.holdDeadline === null) {
    return err(rejection('NOT_ALLOWED_IN_STATE', '席も期限も持たないチケットには知らせを出せない'));
  }
  const reminded: Ticket = { ...ticket, holdRemindedAt: now };
  return ok({
    state: withTicket(state, reminded),
    events: [
      {
        type: 'TicketReminded',
        at: now,
        ticketId: ticket.id,
        tableId: ticket.tableId,
        holdDeadline: ticket.holdDeadline,
      },
    ],
  });
}

/**
 * ホールドの期限切れ（全体プラン 7.7 の 6）。
 *
 * 行き先は `noShowPolicy` が決める。`requeue_once` の 1 回目は保留（順番を保持）、
 * `requeue_back` は待ちの末尾、それ以外は終了。**どれになっても席は空席へ戻る。**
 */
function expireHold(state: VenueState, ticket: Ticket, now: Timestamp): Outcome {
  const moved = ticketTransition({ state, ticket, now, table: null }, 'HOLD_EXPIRE');
  if (!moved.ok) return err(moved.error);

  const released = releaseHeldTable(state, ticket, now);
  if (!released.ok) return err(released.error);

  // 期限切れを数えるのは遷移を決めたあと。ガードは「これが何回目か」を見るため。
  const counted: Ticket = { ...ticket, noShows: ticket.noShows + 1 };
  const after: VenueState = released.value.state;
  const draft: Draft = noShowDraft(after, counted, moved.value, now);
  return ok({ state: draft.state, events: [...draft.events, ...released.value.events] });
}

function noShowDraft(state: VenueState, ticket: Ticket, to: string, now: Timestamp): Draft {
  if (to === 'PAUSED') return pausedDraft(state, ticket, 'PAUSED', 'no_show', now);
  if (to === 'WAITING') return requeuedDraft(state, ticket, now);
  return endedDraft(state, ticket, 'NO_SHOW', 'no_show', now);
}

/** 順番を末尾に戻す（`requeue_back`）。受付時刻をやり直すので実質的に最後尾になる。 */
function requeuedDraft(state: VenueState, ticket: Ticket, now: Timestamp): Draft {
  const requeued: Ticket = {
    ...ticket,
    state: 'WAITING',
    tableId: null,
    holdDeadline: null,
    holdRemindedAt: null,
    priorityAt: now,
  };
  return {
    state: withTicket(state, requeued),
    events: [
      { type: 'TicketRequeued', at: now, ticketId: ticket.id, priorityAt: now, reason: 'no_show' },
    ],
  };
}

// ---- 終端へ落とす期限 ----

/** 期限で終わったチケット。席を持っていれば解放してから終端に落とす。 */
function expireTo(
  state: VenueState,
  ticket: Ticket,
  event: TicketEvent,
  endReason: 'pause_expired' | 'max_age' | 'abandoned',
  now: Timestamp,
): Outcome {
  const moved = ticketTransition({ state, ticket, now, table: null }, event);
  if (!moved.ok) return err(moved.error);

  const released = releaseHeldTable(state, ticket, now);
  if (!released.ok) return err(released.error);

  const draft = endedDraft(released.value.state, ticket, moved.value, endReason, now);
  return ok({ state: draft.state, events: [...draft.events, ...released.value.events] });
}

function endedDraft(
  state: VenueState,
  ticket: Ticket,
  to: string,
  endReason: 'no_show' | 'pause_expired' | 'max_age' | 'abandoned',
  now: Timestamp,
): Draft {
  const ended: Ticket = endedTicket(ticket, toTicketState(to), endReason, now);
  return {
    state: withTicket(state, ended),
    events: [
      { type: 'TicketEnded', at: now, ticketId: ticket.id, endReason, by: null, cancelReason: null },
    ],
  };
}

/** 遷移表が返した行き先を、そのまま状態として使う。 */
function toTicketState(to: string): Ticket['state'] {
  if (to === 'NO_SHOW') return 'NO_SHOW';
  return 'EXPIRED';
}

// ---- 着席中に起きること（全体プラン 7.10、7.11 の 2 層目） ----

/**
 * 「目安時間になりました」（7.10 の `soft`）。
 *
 * 状態は変えない。出したことを記録して、繰り返さないようにする。
 * 何組が待っているかを添える。7.10 の文言が「現在 3 組がお待ちです」だから。
 */
function noticeTimeLimit(state: VenueState, ticket: Ticket, now: Timestamp): Outcome {
  if (ticket.tableId === null) {
    return err(rejection('TABLE_NOT_FOUND', '席を持たないチケットに上限は無い'));
  }
  const noticed: Ticket = { ...ticket, timeLimitNoticedAt: now };
  const waitingCount: number = state.tickets.filter((item) => item.state === 'WAITING').length;
  return ok({
    state: withTicket(state, noticed),
    events: [
      { type: 'TimeLimitReached', at: now, ticketId: ticket.id, tableId: ticket.tableId, waitingCount },
    ],
  });
}

/**
 * 「まだご利用中ですか」（7.11 の 2 層目）。
 *
 * 状態は変えない。1 人につき 1 回だけ出す。答えが無いまま
 * `stillHereTimeoutMin` が過ぎると、席が「確認要」に落ちる。
 */
function askStillHere(state: VenueState, ticket: Ticket, now: Timestamp): Outcome {
  if (ticket.tableId === null) {
    return err(rejection('TABLE_NOT_FOUND', '席を持たないチケットには問いかけない'));
  }
  const asked: Ticket = { ...ticket, stillHereAskedAt: now };
  const answerBy: Timestamp = now + minutes(state.policy.stillHereTimeoutMin);
  return ok({
    state: withTicket(state, asked),
    events: [
      { type: 'StillHereAsked', at: now, ticketId: ticket.id, tableId: ticket.tableId, answerBy },
    ],
  });
}

/**
 * 着席中の席を「確認要」に落とす（7.10 の上限超過、7.11 の 2 層目の無応答）。
 *
 * **チケットは終わらせない。** `hard` モードの上限超過だけが例外で、そちらは
 * ガードが決める。終わらせないのは、「まだ居ます」と答えて戻る道
 * （`STILL_HERE`）を閉じないためである。
 */
function markNeedsCheck(
  state: VenueState,
  ticket: Ticket,
  event: 'OVERSTAY' | 'STILL_HERE_TIMEOUT',
  reason: NeedsCheckReason,
  now: Timestamp,
): Outcome {
  const table: Table | undefined = ticket.tableId === null ? undefined : findTable(state, ticket.tableId);
  if (table === undefined) return err(rejection('TABLE_NOT_FOUND', '着席中のチケットに席が無い'));

  const marked = uncertainDraft(state, table, ticket, reason, event, now);
  if (!marked.ok) return err(marked.error);
  return event === 'OVERSTAY' ? releaseOnHardLimit(marked.value, ticket, now) : ok(marked.value);
}

/**
 * 席を「確認要」に落とす。**すでに落ちていれば何もしない。**
 *
 * 上限超過と問いかけの無応答は、どちらも同じ状態へ向かう。既定値では
 * 無応答のほうが先に来るので、上限が来たときにはもう落ちていることがある。
 */
function uncertainDraft(
  state: VenueState,
  table: Table,
  ticket: Ticket,
  reason: NeedsCheckReason,
  event: 'OVERSTAY' | 'STILL_HERE_TIMEOUT',
  now: Timestamp,
): Result<Draft, Rejection> {
  if (table.status === 'NEEDS_CHECK') return ok({ state, events: [] });

  const moved = tableTransition({ state, table, now }, event);
  if (!moved.ok) return err(moved.error);
  const uncertain: Table = { ...table, status: moved.value, statusSince: now };
  return ok({
    state: withTable(state, uncertain),
    events: [
      { type: 'TableNeedsCheck', at: now, tableId: table.id, reason, occupantTicketId: ticket.id },
    ],
  });
}

/**
 * `hard` モードだけ、上限超過でチケットも終わらせる（7.10）。
 *
 * **席の側の結びつきも外す。** チケットが席を指さなくなるので、席が指したままだと
 * `table_link_is_mutual` が破れる。席は「確認要」のままで、空席には戻さない
 * （次の人に「確実な空席」として案内しないため）。
 */
function releaseOnHardLimit(marked: Draft, ticket: Ticket, now: Timestamp): Outcome {
  const moved = ticketTransition(
    { state: marked.state, ticket, now, table: null },
    'AUTO_RELEASE',
  );
  // ガードが通らない（`soft` と `off`）のは正しい流れなので、席だけを落として終わる。
  if (!moved.ok) return ok(marked);

  const released: Ticket = endedTicket(ticket, moved.value, 'auto_release', now);
  const unlinked: VenueState = unlinkTable(marked.state, ticket.tableId);
  return ok({
    state: withTicket(unlinked, released),
    events: [
      ...marked.events,
      { type: 'TicketEnded', at: now, ticketId: ticket.id, endReason: 'auto_release', by: null, cancelReason: null },
    ],
  });
}

/** 席から「誰が使っているか」の記録を外す。席の状態は変えない。 */
function unlinkTable(state: VenueState, tableId: string | null): VenueState {
  const table: Table | undefined = tableId === null ? undefined : findTable(state, tableId);
  return table === undefined ? state : withTable(state, { ...table, occupantTicketId: null });
}

/**
 * 1 つの期限を処理する。
 *
 * 種別ごとに 1 行ずつ並べるだけの分岐なので、この関数だけ長さの制約から外す
 * （`apply.ts` の `route` と同じ理由）。
 */
// eslint-disable-next-line max-lines-per-function
function settleDue(state: VenueState, ticket: Ticket, due: Due, now: Timestamp): Outcome {
  switch (due.kind) {
    case 'VENUE_CLOSE':
      return endForClose(state, ticket, now);
    case 'REMIND':
      return remind(state, ticket, now);
    case 'HOLD_EXPIRE':
      return expireHold(state, ticket, now);
    case 'PAUSE_EXPIRE':
      return expireTo(state, ticket, 'PAUSE_EXPIRE', 'pause_expired', now);
    case 'MAX_AGE':
      return expireTo(state, ticket, 'MAX_AGE', 'max_age', now);
    case 'ABANDON':
      return expireTo(state, ticket, 'ABANDON', 'abandoned', now);
    case 'TIME_LIMIT_NOTICE':
      return noticeTimeLimit(state, ticket, now);
    case 'STILL_HERE_ASK':
      return askStillHere(state, ticket, now);
    case 'STILL_HERE_TIMEOUT':
      return markNeedsCheck(state, ticket, 'STILL_HERE_TIMEOUT', 'no_answer', now);
    case 'OVERSTAY':
      return markNeedsCheck(state, ticket, 'OVERSTAY', 'overstay', now);
  }
}

// ---- 施設そのものの期限（全体プラン 7.14） ----

/**
 * 受付の締切と運用終了を処理する。
 *
 * **チケットを一巡したあとに見る。** 待っている人の取り消しは、施設の側では
 * なく **1 枚ごとの期限**（`VENUE_CLOSE`）として処理してある。こうしないと、
 * 運用終了より早いホールドの期限が後回しになり、`tick` の刻み方で結果が
 * 変わってしまう（このファイル冒頭の「期限は早いものから」）。ここに残るのは
 * 施設の欄と席の後始末だけで、待っている人はもう居ない。
 */
function settleVenue(state: VenueState, now: Timestamp): Outcome {
  const cutoff = closeJoinIfDue(state, now);
  if (!cutoff.ok) return err(cutoff.error);

  const closed = closeIfDue(cutoff.value.state, now);
  if (!closed.ok) return err(closed.error);
  return ok({
    state: closed.value.state,
    events: [...cutoff.value.events, ...closed.value.events],
  });
}

/** 運用終了の手前で、新規の受付だけを止める（`join_cutoff_before_close_min`）。 */
function closeJoinIfDue(state: VenueState, now: Timestamp): Outcome {
  const at: Timestamp | null = joinCutoffAt(state);
  if (at === null || state.closesAt === null || !hasPassed(at, now)) return ok({ state, events: [] });
  return ok({
    state: { ...state, joinOpen: false },
    events: [{ type: 'JoinClosed', at, closesAt: state.closesAt }],
  });
}

/** 運用時間が終わった。手で閉じるときとまったく同じ手続きを踏む。 */
function closeIfDue(state: VenueState, now: Timestamp): Outcome {
  const at: Timestamp | null = venueClosesAt(state);
  if (at === null || !hasPassed(at, now)) return ok({ state, events: [] });
  return closeVenue(state, at, 'schedule');
}

// ---- 全体 ----

/**
 * 1 枚のチケットについて、来ている期限をすべて処理する。
 *
 * 1 つ処理すると次が来ていることがある（知らせ → ホールドの期限切れ → 保留、
 * さらに受付からの上限）。連鎖は 3 段までだが、上限を置いて止まらない形を
 * 作らないようにしてある。
 */
const MAX_CHAIN = 8;

function settleTicket(state: VenueState, id: string, now: Timestamp): Outcome {
  let current: VenueState = state;
  const events: DomainEvent[] = [];

  for (let step = 0; step < MAX_CHAIN; step += 1) {
    const ticket: Ticket | undefined = findTicket(current, id);
    if (ticket === undefined) break;
    const due: Due | null = earliestDue(current, ticket, now);
    if (due === null) break;

    // **その期限の時刻で処理する。** `now` で刻むと、まとめて処理したときに
    // 次の期限が現在時刻より先へずれ、連鎖が途切れてしまう。
    const settled = settleDue(current, ticket, due, due.at);
    if (!settled.ok) return err(settled.error);
    current = settled.value.state;
    events.push(...settled.value.events);
  }
  return ok({ state: current, events });
}

/**
 * 時刻を進める。
 *
 * **失敗するのは実装の誤りがあるときだけである。** 時刻が進むことを業務上の
 * 理由で拒否することはないので、拒否が返ったらそれは不変条件が破れたか、
 * 遷移表と処理が食い違ったかのどちらかを意味する。呼び出し側はその変更を
 * 破棄して記録すること（利用者向けの文言にしてはならない）。
 *
 * 期限を処理したあと、必ず割当を実行する（`apply` と同じ出口）。空いた席は
 * その場で次の人へ渡る。
 */
export function tick(
  state: VenueState,
  now: Timestamp,
): Result<Decision<VenueState, DomainEvent>, Rejection> {
  const ids: readonly string[] = state.tickets.map((ticket) => ticket.id);
  let current: VenueState = state;
  const events: DomainEvent[] = [];

  for (const id of ids) {
    const settled = settleTicket(current, id, now);
    if (!settled.ok) return err(settled.error);
    current = settled.value.state;
    events.push(...settled.value.events);
  }

  // 施設の開閉は、チケットを一巡したあとで見る（下記）。
  const venue = settleVenue(current, now);
  if (!venue.ok) return err(venue.error);

  // 席の期限（片付けの猶予）は出口の `settle` が見る。`apply` でも同じように
  // 明かす必要があるため、`tick` だけの仕事にはしていない。
  return settle({ state: venue.value.state, events: [...events, ...venue.value.events] }, now);
}

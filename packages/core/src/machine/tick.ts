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

import { findTicket, withTicket, type VenueState } from '../domain/state.js';
import type { Ticket } from '../domain/ticket.js';
import type { Decision } from '../decision.js';
import { err, ok, type Result } from '../result.js';
import { hasPassed, type Timestamp } from '../time.js';
import { pausedDraft } from './apply.js';
import { settle, type Draft, type Outcome } from './settle.js';
import {
  abandonedAt,
  holdExpiresAt,
  holdReminderAt,
  maxAgeAt,
  pauseExpiresAt,
} from './deadlines.js';
import type { DomainEvent } from './events.js';
import { rejection, type Rejection } from './rejection.js';
import { endedTicket, releaseHeldTable } from './release.js';
import type { TicketEvent } from './ticket-machine.js';
import { ticketTransition } from './transition.js';

/**
 * 時刻が来て起きること。
 *
 * `REMIND` だけは状態を変えず、知らせを出したことを記録する。ほかの 4 つは
 * 遷移表の事象に対応する。
 */
const DUE_KINDS = ['REMIND', 'HOLD_EXPIRE', 'PAUSE_EXPIRE', 'MAX_AGE', 'ABANDON'] as const;

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
    ['REMIND', holdReminderAt(ticket, policy)],
    ['HOLD_EXPIRE', holdExpiresAt(ticket)],
    ['PAUSE_EXPIRE', pauseExpiresAt(ticket)],
    ['MAX_AGE', maxAgeAt(ticket, policy)],
    ['ABANDON', abandonedAt(ticket, policy)],
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
    events: [{ type: 'TicketRequeued', at: now, ticketId: ticket.id, priorityAt: now }],
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

/** 1 つの期限を処理する。 */
function settleDue(state: VenueState, ticket: Ticket, due: Due, now: Timestamp): Outcome {
  switch (due.kind) {
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
  }
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

  // 席の期限（片付けの猶予）は出口の `settle` が見る。`apply` でも同じように
  // 明かす必要があるため、`tick` だけの仕事にはしていない。
  return settle({ state: current, events }, now);
}

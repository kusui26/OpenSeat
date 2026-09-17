/**
 * 期限の計算。
 *
 * 時刻起因の遷移はすべて **絶対時刻の期限** で表す。経過時間を溜め込まず、
 * 「いつまでか」を状態に書いておいて `now` と比べるだけにする。こうすると
 * サーバを再起動しても取りこぼさず、`tick` の間隔が変わっても結果が変わらない
 * （全体プラン 9.4）。
 *
 * 期限をこのファイルに集めてあるのは、**同じ期限を 2 か所で計算しないため**
 * である。`apply`（期限を置く側）と `tick`（期限を見る側）が別の式を持つと、
 * 片方だけ直したときに静かにずれる。
 *
 * 期限が `null` を返すのは「その遷移はこのチケットには起こりえない」ことを表す。
 * 「まだ来ていない」とは別で、`tick` はこれを区別しない（どちらも何もしない）。
 */

import type { Policy } from '../domain/policy.js';
import type { Ticket } from '../domain/ticket.js';
import { minutes, type DurationMs, type Timestamp } from '../time.js';
import { MAX_AGE_APPLIES_TO } from './ticket-machine.js';

// ---- ホールド（全体プラン 7.7 の 2〜4） ----

/** 呼び出したときに置く期限。 */
export function holdDeadlineFor(policy: Policy, now: Timestamp): Timestamp {
  return now + minutes(policy.holdMin);
}

/** 「向かっています」で延ばしたあとの期限。**現在時刻からではなく期限から延ばす。** */
export function extendedHoldDeadline(ticket: Ticket, policy: Policy): Timestamp | null {
  return ticket.holdDeadline === null ? null : ticket.holdDeadline + minutes(policy.holdExtensionMin);
}

/**
 * 「あと 2 分で無効になります」を出す時刻（7.7 の 3）。
 *
 * すでに出したあとなら `null`。期限が延びたときは記録を消すので、新しい期限に
 * ついてもう一度出る。`holdReminderBeforeMin < holdMin` は設定の検証が守る。
 */
export function holdReminderAt(ticket: Ticket, policy: Policy): Timestamp | null {
  if (ticket.state !== 'CALLED' || ticket.holdDeadline === null) return null;
  if (ticket.holdRemindedAt !== null) return null;
  return ticket.holdDeadline - minutes(policy.holdReminderBeforeMin);
}

/** ホールドが切れる時刻。`CALLED` のときだけ。 */
export function holdExpiresAt(ticket: Ticket): Timestamp | null {
  return ticket.state === 'CALLED' ? ticket.holdDeadline : null;
}

/** 「向かっています」をあと何回押せるか（7.7 の 4）。 */
export function canExtendHold(ticket: Ticket, policy: Policy): boolean {
  return ticket.extensions < policy.maxExtensions;
}

// ---- 保留（全体プラン 7.7 の 5〜7） ----

/**
 * 閉じた保留で使い残している時間。
 *
 * **いま続いている保留で経過した分は引かれていない。** `pausedTotal` は保留を
 * 閉じるときに足し込まれるためで、続いている分まで見たいときは
 * `pauseWindowEnd()` を使うこと。
 */
export function remainingPauseBudget(ticket: Ticket, policy: Policy): DurationMs {
  const cap: DurationMs = minutes(policy.pauseMaxTotalMin);
  return cap > ticket.pausedTotal ? cap - ticket.pausedTotal : 0;
}

/**
 * いまの保留が、いつまでなら許されるか。
 *
 * 保留に入った時刻から、使い残している時間だけ先。**延長を何度繰り返しても
 * この時刻より先へは延びない。** ここを見ないと、`pausedTotal` が保留を閉じる
 * まで増えないため、延長のたびに上限いっぱいの持ち時間が戻ってしまう。
 *
 * まだ保留に入っていなければ、これから入る時刻から数える。
 */
export function pauseWindowEnd(ticket: Ticket, policy: Policy, now: Timestamp): Timestamp {
  const start: Timestamp = ticket.pausedSince ?? now;
  return start + remainingPauseBudget(ticket, policy);
}

/**
 * これから置く保留の期限。
 *
 * 1 回に延びるのは `pauseStepMin` まで。ただし合計が `pauseMaxTotalMin` を
 * 超えないように切り詰める。**1 つの仕掛け（期限）で 2 つのパラメータを守る。**
 *
 * 保留中の延長でも同じ式を使う。**延長は「いまから `pauseStepMin` 先」**で、
 * ホールドの延長（期限から足す）とは違う。保留は「まだ待っていますか」への
 * 応答なので、応答した時点から数え直すのが素直である（7.7 の 7）。
 *
 * 持ち時間を使い切っていれば、期限は現在時刻か、それより前になる。次の `tick` が
 * その時刻で期限切れにする。
 */
export function pauseDeadlineFor(ticket: Ticket, policy: Policy, now: Timestamp): Timestamp {
  return Math.min(now + minutes(policy.pauseStepMin), pauseWindowEnd(ticket, policy, now));
}

/** 保留が切れる時刻。`PAUSED` のときだけ。 */
export function pauseExpiresAt(ticket: Ticket): Timestamp | null {
  return ticket.state === 'PAUSED' ? ticket.pauseDeadline : null;
}

/** 保留に入るときに書き換える欄。どちらも必ず入るので `null` を取らない。 */
export interface StartedPause {
  readonly pauseDeadline: Timestamp;
  readonly pausedSince: Timestamp;
}

export function startedPause(ticket: Ticket, policy: Policy, now: Timestamp): StartedPause {
  return { pauseDeadline: pauseDeadlineFor(ticket, policy, now), pausedSince: now };
}

/** 保留を閉じるときに書き換える欄。使った時間を合計へ足し込む。 */
export function closedPause(
  ticket: Ticket,
  now: Timestamp,
): Pick<Ticket, 'pauseDeadline' | 'pausedSince' | 'pausedTotal'> {
  const spent: DurationMs = ticket.pausedSince === null ? 0 : Math.max(0, now - ticket.pausedSince);
  return { pauseDeadline: null, pausedSince: null, pausedTotal: ticket.pausedTotal + spent };
}

// ---- 受付からの絶対上限（全体プラン 7.7 の 7） ----

/**
 * チケットが強制的に終わる時刻。
 *
 * 呼び出しに至っていない人だけが対象（`MAX_AGE_APPLIES_TO`）。席を確保した人を
 * 上限で打ち切らないという判断は `ticket-machine.ts` に書いてある。
 */
export function maxAgeAt(ticket: Ticket, policy: Policy): Timestamp | null {
  if (!MAX_AGE_APPLIES_TO.includes(ticket.state)) return null;
  return ticket.createdAt + minutes(policy.ticketMaxAgeMin);
}

// ---- 放置（全体プラン 7.9 の「暗黙のキャンセル」） ----

/**
 * 放置とみなす時刻。
 *
 * 通知手段を持つ人には来ない（`null`）。画面を閉じても呼び出しが届くので、
 * 接続が切れていることは放置の証拠にならない。呼び出しに応じなかった場合は
 * ノーショーの側で扱う。
 */
export function abandonedAt(ticket: Ticket, policy: Policy): Timestamp | null {
  if (ticket.state !== 'WAITING' || ticket.hasNotificationChannel) return null;
  return ticket.lastSeenAt + minutes(policy.abandonTimeoutMin);
}

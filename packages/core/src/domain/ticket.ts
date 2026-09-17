/**
 * チケット。
 *
 * 一組（パーティ）の「受付から退席まで」のライフサイクルを表す。
 * 状態は全体プラン 7.3 の状態機械に対応する。
 *
 * **`core` に持たない欄**（全体プラン 9.6 のデータモデルには存在するもの）:
 * `client_token_hash`（端末の匿名トークン）は利用者の識別と重複登録の抑止に使う
 * 資格情報で、境界側の責務。`core` は「誰が操作したか」をコマンドの引数として
 * 受け取るだけで、識別子そのものは保持しない。
 */

import type { DurationMs, Timestamp } from '../time.js';
import type { TableId, Tag, TicketCode, TicketId } from './ids.js';

/**
 * チケットの状態（全体プラン 7.3）。
 *
 * | 状態 | 意味 |
 * |---|---|
 * | `WAITING` | 順番待ち中。割当の対象 |
 * | `PAUSED` | 順番は保持しているが割当の対象外。「準備OK」で戻る |
 * | `CALLED` | 席が確保されている（ホールド中） |
 * | `SEATED` | 着席中 |
 * | `DONE` | 利用が終わった |
 * | `CANCELLED` | 取り消された |
 * | `NO_SHOW` | 呼び出しに応じなかった |
 * | `EXPIRED` | 放置・保留の期限切れ・受付からの絶対上限 |
 */
export const TICKET_STATES = [
  'WAITING',
  'PAUSED',
  'CALLED',
  'SEATED',
  'DONE',
  'CANCELLED',
  'NO_SHOW',
  'EXPIRED',
] as const;

export type TicketState = (typeof TICKET_STATES)[number];

/** 終端の状態。ここから出る遷移は無い。 */
export const TERMINAL_TICKET_STATES = ['DONE', 'CANCELLED', 'NO_SHOW', 'EXPIRED'] as const;

export type TerminalTicketState = (typeof TERMINAL_TICKET_STATES)[number];

/** まだ生きている状態。 */
export const ACTIVE_TICKET_STATES = ['WAITING', 'PAUSED', 'CALLED', 'SEATED'] as const;

export type ActiveTicketState = (typeof ACTIVE_TICKET_STATES)[number];

/** 終わり方。統計と、利用者への説明に使う。 */
export const END_REASONS = [
  'checked_out',
  'staff_checkout',
  'auto_release',
  'user_cancel',
  'staff_cancel',
  'venue_closed',
  'no_show',
  'abandoned',
  'pause_expired',
  'max_age',
] as const;

export type EndReason = (typeof END_REASONS)[number];

/**
 * 終わり方と、そのとき到達する終端状態の対応。
 *
 * 分岐ではなく表として宣言する。終わり方を足したときに、どの終端状態に
 * 落ちるかを必ず決めさせるため（CLAUDE.md 3.2）。
 */
export const END_REASON_STATES = {
  checked_out: 'DONE',
  staff_checkout: 'DONE',
  auto_release: 'DONE',
  user_cancel: 'CANCELLED',
  staff_cancel: 'CANCELLED',
  venue_closed: 'CANCELLED',
  no_show: 'NO_SHOW',
  abandoned: 'EXPIRED',
  pause_expired: 'EXPIRED',
  max_age: 'EXPIRED',
} as const satisfies Record<EndReason, TerminalTicketState>;

export interface Ticket {
  readonly id: TicketId;

  /** 利用者とボードに見せる短いコード。 */
  readonly code: TicketCode;

  /** 一緒に食事する人数。 */
  readonly partySize: number;

  /** 車いす対応席など、満たしてほしい条件。順番には影響しない。 */
  readonly requiredTags: readonly Tag[];

  readonly state: TicketState;

  /**
   * 順番の基準になる時刻。
   * 受付時刻で初期化し、保留を挟んでも保持する。人数を増やしたときだけ
   * 現在時刻に更新する（「1 名で登録して 4 名に変える」抜け道を防ぐ。7.6）。
   */
  readonly priorityAt: Timestamp;

  /** 受付した時刻。絶対上限（`ticketMaxAgeMin`）の起点。`priorityAt` とは別。 */
  readonly createdAt: Timestamp;

  /** `CALLED` / `SEATED` のとき、割り当てられているテーブル。 */
  readonly tableId: TableId | null;

  readonly calledAt: Timestamp | null;

  /** ホールドの期限。絶対時刻で持つ。経過時間の累積では判定しない（9.4）。 */
  readonly holdDeadline: Timestamp | null;

  /** 「向かっています」を押して延長した回数。 */
  readonly extensions: number;

  /** 「パス」で次の人に譲った回数。 */
  readonly passes: number;

  /** ホールドの期限切れを起こした回数。`noShowPolicy` の判定に使う。 */
  readonly noShows: number;

  /**
   * 案内された席が塞がっていた人であることを示す。
   * 同じ `priorityAt` の中で最優先に扱う（全体プラン 7.8）。
   */
  readonly conflictPriority: boolean;

  readonly seatedAt: Timestamp | null;
  readonly endedAt: Timestamp | null;
  readonly endReason: EndReason | null;

  /** `PAUSED` の期限。操作があるたびに延長される。 */
  readonly pauseDeadline: Timestamp | null;

  /** 保留していた時間の合計。`pauseMaxTotalMin` の判定に使う。 */
  readonly pausedTotal: DurationMs;

  /**
   * 利用者の画面から最後に接続があった時刻。
   * 通知手段が無い人の放置判定に使う（全体プラン 7.9）。
   */
  readonly lastSeenAt: Timestamp;

  /**
   * Web Push や LINE など、画面を閉じても届く通知手段を持っているか。
   * 持っている人は接続が切れても放置とみなさない。
   */
  readonly hasNotificationChannel: boolean;

  /** 「まだご利用中ですか」を出した時刻。1 回だけ出すための記録。 */
  readonly stillHereAskedAt: Timestamp | null;
}

/** 呼び出しに関する欄。受付の時点ではまだ何も起きていない。 */
const UNCALLED_FIELDS = {
  tableId: null,
  calledAt: null,
  holdDeadline: null,
  extensions: 0,
  passes: 0,
  noShows: 0,
  conflictPriority: false,
} as const;

/** 着席と終了に関する欄。受付の時点ではまだ決まっていない。 */
const UNFINISHED_FIELDS = {
  seatedAt: null,
  endedAt: null,
  endReason: null,
  pauseDeadline: null,
  pausedTotal: 0,
  stillHereAskedAt: null,
} as const;

export interface CreateTicketParams {
  readonly id: TicketId;
  readonly code: TicketCode;
  readonly partySize: number;
  readonly now: Timestamp;
  readonly requiredTags?: readonly Tag[];
  readonly hasNotificationChannel?: boolean;
}

/** 受付直後のチケットを作る。 */
export function createTicket(params: CreateTicketParams): Ticket {
  return {
    id: params.id,
    code: params.code,
    partySize: params.partySize,
    requiredTags: params.requiredTags ?? [],
    state: 'WAITING',
    priorityAt: params.now,
    createdAt: params.now,
    lastSeenAt: params.now,
    hasNotificationChannel: params.hasNotificationChannel ?? false,
    ...UNCALLED_FIELDS,
    ...UNFINISHED_FIELDS,
  };
}

const TERMINAL_SET: ReadonlySet<TicketState> = new Set(TERMINAL_TICKET_STATES);
const TABLE_HOLDING_SET: ReadonlySet<TicketState> = new Set(['CALLED', 'SEATED']);

/**
 * 終端の状態か。
 * 判定は `TERMINAL_TICKET_STATES` から導く。状態を足したときに、この関数だけが
 * 取り残されることを防ぐため。
 */
export function isTerminal(state: TicketState): boolean {
  return TERMINAL_SET.has(state);
}

/** まだ生きているか。 */
export function isActive(state: TicketState): boolean {
  return !isTerminal(state);
}

/** 席を持っているべき状態か。 */
export function holdsTable(state: TicketState): boolean {
  return TABLE_HOLDING_SET.has(state);
}

/**
 * 順番の比較。小さいほど先に案内される。
 *
 * `conflictPriority`（案内された席が塞がっていた人）が同時刻の他者より前に来る。
 * 同点なら ID で決定的に並べる。配列の順序に結果が依存しないようにするため。
 */
export function comparePriority(a: Ticket, b: Ticket): number {
  if (a.priorityAt !== b.priorityAt) return a.priorityAt - b.priorityAt;
  if (a.conflictPriority !== b.conflictPriority) return a.conflictPriority ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

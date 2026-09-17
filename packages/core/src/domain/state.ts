/**
 * 施設の状態。
 *
 * `apply` と `tick` が受け取り、新しい状態を返す対象（ADR-0004）。
 * 破壊的な更新はしない。
 *
 * テーブルとチケットは配列で持つ。1 施設あたり席 20〜100、生きているチケットは
 * 200 程度（全体プラン 9.1）なので線形走査で足りる。引き当てはこのファイルの
 * ヘルパーに閉じ込めてあるので、規模が変わったときに差し替えられる。
 */

import type { Policy } from './policy.js';
import type { Table } from './table.js';
import type { TableId, TicketCode, TicketId, VenueId } from './ids.js';
import type { Ticket } from './ticket.js';
import { isActive } from './ticket.js';

export interface VenueState {
  readonly venueId: VenueId;

  readonly tables: readonly Table[];

  /**
   * チケット。終端に達したものも履歴として残る。
   * 生きているものだけが欲しい場合は `activeTickets()` を使う。
   */
  readonly tickets: readonly Ticket[];

  readonly policy: Policy;

  /**
   * 運用中か。スケジュールまたはスタッフの手動操作で切り替わる（全体プラン 7.14）。
   * 運用外では対象席が `DISABLED` になり、自由席に戻る。
   */
  readonly operating: boolean;

  /**
   * 新規の受付を受け付けているか。
   * 運用終了の手前で止めるため、`operating` とは別に持つ。
   */
  readonly joinOpen: boolean;

  /** 表示コードの採番カウンタ。0 から始まる。 */
  readonly nextCodeSeq: number;
}

export interface CreateVenueStateParams {
  readonly venueId: VenueId;
  readonly policy: Policy;
  readonly tables?: readonly Table[];
}

/** 空の状態を作る。席は別途追加する。 */
export function createVenueState(params: CreateVenueStateParams): VenueState {
  return {
    venueId: params.venueId,
    tables: params.tables ?? [],
    tickets: [],
    policy: params.policy,
    operating: false,
    joinOpen: false,
    nextCodeSeq: 0,
  };
}

// ---- 引き当て ----

export function findTable(state: VenueState, id: TableId): Table | undefined {
  return state.tables.find((table) => table.id === id);
}

export function findTicket(state: VenueState, id: TicketId): Ticket | undefined {
  return state.tickets.find((ticket) => ticket.id === id);
}

/** 終端に達していないチケット。 */
export function activeTickets(state: VenueState): readonly Ticket[] {
  return state.tickets.filter((ticket) => isActive(ticket.state));
}

/** 割当の対象になっているチケット。順番は保証しない。 */
export function waitingTickets(state: VenueState): readonly Ticket[] {
  return state.tickets.filter((ticket) => ticket.state === 'WAITING');
}

/** 管理対象の席。 */
export function managedTables(state: VenueState): readonly Table[] {
  return state.tables.filter((table) => table.enabled);
}

// ---- 表示コードの採番 ----

const CODE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODES_PER_LETTER = 99;

/** 重複せずに発行できるコードの総数。 */
export const CODE_SPACE_SIZE = CODE_LETTERS.length * CODES_PER_LETTER;

/**
 * `nextCodeSeq` から表示コードを導く。
 *
 * `A-01` から `A-99`、`B-01` と続き、`Z-99` の次は `A-01` に戻る。
 * 2,574 通りあるので 1 日の運用で重複しない。乱数を使わず状態から決まるため、
 * `core` の純粋性を保ったまま採番できる（ADR-0004）。
 */
export function ticketCodeFor(seq: number): TicketCode {
  const wrapped: number = ((seq % CODE_SPACE_SIZE) + CODE_SPACE_SIZE) % CODE_SPACE_SIZE;
  const letter: string = CODE_LETTERS.charAt(Math.floor(wrapped / CODES_PER_LETTER));
  const slot: number = (wrapped % CODES_PER_LETTER) + 1;
  return `${letter}-${String(slot).padStart(2, '0')}`;
}

/** 次に発行する表示コード。採番カウンタを進めるのは呼び出し側の責務。 */
export function nextTicketCode(state: VenueState): TicketCode {
  return ticketCodeFor(state.nextCodeSeq);
}

// ---- 受け付けられる最大人数 ----

/**
 * 受け付けられる最大人数。
 *
 * `policy.maxPartySize` が設定されていればそれを使い、無ければ対象席の
 * 最大定員から導く（全体プラン 7.16）。対象席が 1 つも無ければ 0 を返す。
 */
export function effectiveMaxPartySize(state: VenueState): number {
  const explicit: number | null = state.policy.maxPartySize;
  if (explicit !== null) return explicit;
  const capacities: readonly number[] = managedTables(state).map((table) => table.capacity);
  return capacities.length === 0 ? 0 : Math.max(...capacities);
}

// ---- 更新のヘルパー ----

/** 1 つのテーブルを差し替えた状態を返す。 */
export function withTable(state: VenueState, updated: Table): VenueState {
  return {
    ...state,
    tables: state.tables.map((table) => (table.id === updated.id ? updated : table)),
  };
}

/** 1 つのチケットを差し替えた状態を返す。 */
export function withTicket(state: VenueState, updated: Ticket): VenueState {
  return {
    ...state,
    tickets: state.tickets.map((ticket) => (ticket.id === updated.id ? updated : ticket)),
  };
}

/**
 * テーブル（席）。
 *
 * 割当の最小単位で、定員を持つ。カウンター席は定員 1 のテーブルとして扱う。
 * 状態は全体プラン 7.4 の状態機械に対応する。
 *
 * **`core` に持たない欄**（全体プラン 9.6 のデータモデルには存在するもの）:
 *
 * | 欄 | 持たない理由 |
 * |---|---|
 * | `token`（座席 QR の秘密トークン） | 資格情報なので `core` に入れない。トークンから `TableId` への解決は境界側で行い、`core` には `TableId` だけを渡す |
 * | `zone_id` | ゾーンはフロア設定（Phase 3）と v2 のゾーン希望で使う。割当は使わない |
 * | `position`（座標・形） | 見た目だけの情報。割当は座標を使わない（全体プラン 10.2） |
 */

import type { Timestamp } from '../time.js';
import type { TableId, TableLabel, Tag, TicketId } from './ids.js';

/**
 * テーブルの状態（全体プラン 7.4）。
 *
 * | 状態 | 意味 |
 * |---|---|
 * | `DISABLED` | 対象外、または運用時間外。自由席として扱われる |
 * | `FREE` | 確実に空いている。割当の対象 |
 * | `HELD` | 呼び出し中の人のために確保している |
 * | `OCCUPIED` | 着席が確認されている |
 * | `OCCUPIED_UNKNOWN` | 誰かが使っているが、誰かは分からない（無断利用・報告） |
 * | `TURNOVER` | 退席直後の片付け猶予中 |
 * | `NEEDS_CHECK` | たぶん空いているが確証がない。ゴースト占有対策の要（7.11） |
 */
export const TABLE_STATUSES = [
  'DISABLED',
  'FREE',
  'HELD',
  'OCCUPIED',
  'OCCUPIED_UNKNOWN',
  'TURNOVER',
  'NEEDS_CHECK',
] as const;

export type TableStatus = (typeof TABLE_STATUSES)[number];

/** 誰かが使っている（と分かっている）状態。 */
export const TAKEN_TABLE_STATUSES = ['HELD', 'OCCUPIED', 'OCCUPIED_UNKNOWN'] as const;

export type TakenTableStatus = (typeof TAKEN_TABLE_STATUSES)[number];

export interface Table {
  readonly id: TableId;

  /** 印刷される席番号。利用者に見える。 */
  readonly label: TableLabel;

  /** 定員。1 以上。 */
  readonly capacity: number;

  /** 席の属性。割当では候補の絞り込みにのみ使う。 */
  readonly tags: readonly Tag[];

  /**
   * 管理者が決めた処理順。小さいほど先に埋める。
   * 「入口に近い席から埋める」のような運用を表す（全体プラン 7.6）。
   */
  readonly adminRank: number;

  /** OpenSeat の管理対象か。false なら常に自由席。 */
  readonly enabled: boolean;

  readonly status: TableStatus;

  /** 現在の状態になった時刻。滞在時間や猶予の起点。 */
  readonly statusSince: Timestamp;

  /**
   * 退席が確認された最後の時刻。
   * 割当の並び順に使う。長く「空席」のままの席は無断利用されている可能性が
   * 高いため、退席が新しく確認された席を優先する（全体プラン 7.6）。
   * 一度も確認されていなければ null。
   */
  readonly verifiedFreeAt: Timestamp | null;

  /** `HELD` / `OCCUPIED` のとき、その席を使っている（使う予定の）チケット。 */
  readonly occupantTicketId: TicketId | null;

  /**
   * 対象外にする操作が保留されているか。
   * 運用中の席を即座に外すと呼び出し中の人に影響するため、現在の利用が
   * 終わってから反映する（全体プラン 7.6 のエッジケース）。
   */
  readonly disableAfterCurrent: boolean;
}

/** 生成の時点ではまだ決まっていない欄。 */
const UNUSED_TABLE_FIELDS = {
  verifiedFreeAt: null,
  occupantTicketId: null,
  disableAfterCurrent: false,
} as const;

export interface CreateTableParams {
  readonly id: TableId;
  readonly label: TableLabel;
  readonly capacity: number;
  readonly now: Timestamp;
  readonly tags?: readonly Tag[];
  readonly adminRank?: number;
  readonly enabled?: boolean;
}

/** 新しいテーブルを作る。状態は運用開始まで `DISABLED`。 */
export function createTable(params: CreateTableParams): Table {
  return {
    id: params.id,
    label: params.label,
    capacity: params.capacity,
    tags: params.tags ?? [],
    adminRank: params.adminRank ?? 0,
    enabled: params.enabled ?? true,
    status: 'DISABLED',
    statusSince: params.now,
    ...UNUSED_TABLE_FIELDS,
  };
}

const TAKEN_SET: ReadonlySet<TableStatus> = new Set(TAKEN_TABLE_STATUSES);

/**
 * 誰かが使っている（と分かっている）か。
 * 判定は `TAKEN_TABLE_STATUSES` から導く。状態を足したときに、この関数だけが
 * 取り残されることを防ぐため。
 */
export function isTaken(status: TableStatus): boolean {
  return TAKEN_SET.has(status);
}

/** 人数が定員に収まるか。 */
export function fitsCapacity(table: Table, partySize: number): boolean {
  return partySize >= 1 && partySize <= table.capacity;
}

/**
 * 席が利用者の希望タグをすべて満たすか。
 * 希望が空なら常に真。席が余分なタグを持っていても構わない。
 */
export function satisfiesTags(table: Table, requiredTags: readonly Tag[]): boolean {
  return requiredTags.every((tag) => table.tags.includes(tag));
}

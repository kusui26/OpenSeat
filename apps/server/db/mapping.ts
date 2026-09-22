/**
 * 開発プラン 9.6 のデータモデルと、実際のスキーマの対応。
 *
 * **9.6 は概略で、スキーマは実装である。ずれるのは当たり前だが、黙ってずれては
 * いけない。** だから対応をデータとして宣言し、`mapping.test.ts` が突き合わせる。
 *
 * ここに書いてあるのは 3 種類だけである。
 *
 * | 種類 | 意味 |
 * |---|---|
 * | 列名 | 9.6 のその列が、スキーマのこの列になっている（名前が変わることもある） |
 * | `LATER` | **まだ無い。** どの PR で入るかを書く |
 *
 * 9.6 に無い列や表をスキーマ側が持つときは `ADDED` に書く。**説明の無い追加を
 * 残さない**ためで、ここに挙がっていない列があればテストが落ちる。
 */

import { getTableColumns, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.js';
import { commandLog, events, tableStatusLog, tables, tickets, venues, zones } from './schema.js';

/** まだ無い。いつ入るかを書く。 */
export interface Later {
  readonly kind: 'later';
  readonly when: string;
}

const LATER = (when: string): Later => ({ kind: 'later', when });

/** 9.6 の列 1 つの行き先。文字列ならスキーマの列名。 */
export type Destination = string | Later;

/** 9.6 の表 1 つ分の対応。 */
export interface TableMapping {
  /** スキーマ側の表。まだ無ければ `Later`。 */
  readonly schema: SQLiteTable | Later;
  /** 9.6 の「主な列」と、その行き先。 */
  readonly columns: Readonly<Record<string, Destination>>;
  /** 9.6 に無いが、スキーマが持っている列とその理由。 */
  readonly added?: Readonly<Record<string, string>>;
}

/**
 * 9.6 の表と、スキーマの対応。
 *
 * **キーは 9.6 の表の名前、その中のキーは 9.6 の列の名前**である。読むときは
 * 9.6 の表を左に置いて見比べてほしい。
 */
export const MAPPING: Readonly<Record<string, TableMapping>> = {
  venues: {
    schema: venues,
    columns: {
      id: 'id',
      slug: 'slug',
      name: 'name',
      timezone: 'timezone',
      locale: 'locale',
      managed_schedule: 'managed_schedule',
      status: 'status',
    },
    added: {
      // 施設の運用の状態は、`core` の `VenueState` の一部である。別の表に
      // 置くと復元のときに 2 か所を読むことになる（ADR-0013）。
      policy: '運用パラメータ（7.16 の 29 キー）。公開の仕組みは PR 15',
      operating: 'VenueState.operating。運用中か（7.14）',
      join_open: 'VenueState.joinOpen。新規の受付を開いているか',
      closes_at: 'VenueState.closesAt。いまの営業回が終わる時刻',
      clock_at: 'VenueState.clockAt。時計が戻っていないことを確かめる（9.4）',
      next_code_seq: 'VenueState.nextCodeSeq。表示コードの採番カウンタ',
      created_at: '施設を作った時刻。データ保持の期限を数える起点（CLAUDE.md 7）',
      updated_at: '最後に状態が変わった時刻。運用の停止に気づくために管理画面が見る（PR 14）',
    },
  },

  zones: {
    schema: zones,
    columns: { id: 'id', venue_id: 'venue_id', name: 'name', sort: 'sort' },
  },

  tables: {
    schema: tables,
    columns: {
      id: 'id',
      venue_id: 'venue_id',
      zone_id: 'zone_id',
      label: 'label',
      capacity: 'capacity',
      tags: 'tags',
      admin_rank: 'admin_rank',
      token: 'token',
      enabled: 'enabled',
      status: 'status',
      status_since: 'status_since',
      verified_free_at: 'verified_free_at',
      // 名前を変えた。`current` は「いま座っている」と読めるが、`HELD` の席には
      // まだ誰も座っていない。`core` の `occupantTicketId` に合わせる。
      current_ticket_id: 'occupant_ticket_id',
      position: LATER('Phase 3（フロア図）。割当は座標を使わないので、実証実験は一覧編集で回る'),
    },
    added: {
      disable_after_current:
        'core の Table.disableAfterCurrent。運用中の席を外す操作は、現在の利用が終わるまで保留される（7.6）',
    },
  },

  tickets: {
    schema: tickets,
    columns: {
      id: 'id',
      venue_id: 'venue_id',
      code: 'code',
      party_size: 'party_size',
      required_tags: 'required_tags',
      state: 'state',
      priority_at: 'priority_at',
      created_at: 'created_at',
      called_at: 'called_at',
      hold_deadline: 'hold_deadline',
      extensions: 'extensions',
      passes: 'passes',
      no_shows: 'no_shows',
      seated_at: 'seated_at',
      // 名前を変えた。**座らずに終わるチケットのほうが多い**（キャンセル、
      // ノーショー、上限切れ）。「退席した時刻」では、その大半を説明できない。
      left_at: 'ended_at',
      table_id: 'table_id',
      client_token_hash: 'client_token_hash',
      conflict_priority: 'conflict_priority',
      end_reason: 'end_reason',
    },
    added: {
      // **9.6 に足りなかったのはここである。** 無いまま写すと、再起動したときに
      // 期限や知らせの記録が消え、同じ知らせが繰り返される（7.7、7.9、7.10、7.11）。
      hold_reminded_at: 'core の Ticket.holdRemindedAt。「あと 2 分」を期限ごとに 1 回だけ出す（7.7）',
      pause_deadline: 'core の Ticket.pauseDeadline。保留の期限（7.7）',
      paused_since: 'core の Ticket.pausedSince。いまの保留に入った時刻',
      paused_total: 'core の Ticket.pausedTotal。保留していた時間の合計（pause_max_total_min の判定）',
      last_seen_at: 'core の Ticket.lastSeenAt。放置の判定に使う（7.9）',
      has_notification_channel: 'core の Ticket.hasNotificationChannel。届く手段があれば放置とみなさない',
      still_here_asked_at: 'core の Ticket.stillHereAskedAt。「まだご利用中ですか」を出した時刻（7.11）',
      still_here_answered_at: 'core の Ticket.stillHereAnsweredAt。その答えが返った時刻',
      time_limit_noticed_at: 'core の Ticket.timeLimitNoticedAt。「目安時間になりました」を出した時刻（7.10）',
      secret_hash:
        'チケット URL の秘密パラメータのハッシュ（9.8）。9.6 は client_token_hash しか挙げていないが、本人性はこの 2 つで扱う',
    },
  },

  events: {
    schema: events,
    columns: {
      // 名前を変えた。**この列は順序そのものである。** 配信の追いつき（9.5）は
      // 「どこまで受け取ったか」を番号で伝える。
      id: 'seq',
      venue_id: 'venue_id',
      ts: 'at',
      actor: 'actor_kind',
      type: 'type',
      ticket_id: 'ticket_id',
      table_id: 'table_id',
      payload: 'payload',
    },
    added: {
      actor_id: '9.6 の actor(kind, id) の後ろ半分。2 列に分けた',
      recorded_at:
        'こちらに記録した時刻。`at` はそうなった時刻なので、差がそのまま tick の遅れになる（CLAUDE.md 8 の監視）',
    },
  },

  notification_channels: {
    schema: LATER('PR 16（通知）'),
    columns: {
      id: LATER('PR 16'),
      ticket_id: LATER('PR 16'),
      kind: LATER('PR 16'),
      address: LATER('PR 16。**チケットが終わったら消す**（CLAUDE.md 7）'),
      created_at: LATER('PR 16'),
      expires_at: LATER('PR 16'),
    },
  },

  settings_versions: {
    schema: LATER('PR 15（運用設定のプリセット）'),
    columns: {
      id: LATER('PR 15'),
      venue_id: LATER('PR 15'),
      version: LATER('PR 15'),
      json: LATER('PR 15'),
      published_at: LATER('PR 15'),
      published_by: LATER('PR 15'),
    },
  },

  floor_layouts: {
    schema: LATER('Phase 3（フロア図）'),
    columns: {
      venue_id: LATER('Phase 3'),
      background_asset: LATER('Phase 3'),
      canvas: LATER('Phase 3'),
      draft: LATER('Phase 3'),
      published: LATER('Phase 3'),
    },
  },

  users: {
    schema: LATER('PR 12（認証と監査ログ）'),
    columns: { id: LATER('PR 12'), email: LATER('PR 12'), password_hash: LATER('PR 12（argon2）') },
  },

  memberships: {
    schema: LATER('PR 12（認証と監査ログ）'),
    columns: { id: LATER('PR 12'), user_id: LATER('PR 12'), venue_id: LATER('PR 12'), role: LATER('PR 12') },
  },

  sessions: {
    schema: LATER('PR 12（認証と監査ログ）'),
    columns: { id: LATER('PR 12'), user_id: LATER('PR 12'), expires_at: LATER('PR 12') },
  },

  audit_log: {
    schema: LATER('PR 12（認証と監査ログ）'),
    columns: {
      id: LATER('PR 12'),
      venue_id: LATER('PR 12'),
      actor: LATER('PR 12'),
      action: LATER('PR 12'),
      at: LATER('PR 12'),
    },
  },
};

/**
 * 9.6 に無い表。**説明の無い表を作らない。**
 *
 * `table_status_log` を足した理由は Phase 1 の PR 14 で分かったことにある
 * （[ADR-0013](../../../docs/adr/0013-what-we-record.md)）。
 */
const ADDED: readonly (readonly [SQLiteTable, string])[] = [
  [
    tableStatusLog,
    '席の姿の履歴。イベントからは「席がいまどの姿か」が分からないので、稼働率（8.3）を出すために別に持つ',
  ],
  [
    commandLog,
    '受け取ったコマンドの控え。モバイル回線の送り直しで二度適用しないために要る（9.4、ADR-0015）',
  ],
];

export const ADDED_TABLES: ReadonlyMap<SQLiteTable, string> = new Map(ADDED);

/**
 * スキーマにある表を全部。
 *
 * **手で並べない。** 並べると、表を足して並べ忘れたときに「漏れがない」という
 * テストが黙って通ってしまう。`schema.ts` から拾う。
 */
export const ALL_TABLES: readonly SQLiteTable[] = Object.values(schema).filter(
  (value: unknown): value is SQLiteTable => is(value, SQLiteTable),
);

/** 9.6 のその表のうち、すでにスキーマの列になっているもの。 */
export function mappedColumns(entry: TableMapping): readonly string[] {
  return Object.values(entry.columns).filter((to): to is string => typeof to === 'string');
}

/** その表が実際に持っている列の名前（SQL 側の名前）。 */
export function columnNames(table: SQLiteTable): readonly string[] {
  return Object.values(getTableColumns(table)).map((column) => column.name);
}

/** まだ無い印か。 */
export function isLater(value: Destination | SQLiteTable): value is Later {
  return typeof value === 'object' && 'kind' in value && value.kind === 'later';
}

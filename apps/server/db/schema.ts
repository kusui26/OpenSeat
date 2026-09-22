/**
 * スキーマ（開発プラン 9.6）。
 *
 * **このファイルが唯一の出典である。** マイグレーションは生成物であり、手書きの
 * SQL を正としない（CLAUDE.md 3.2(1)）。列や制約を足したら `pnpm db:generate`。
 *
 * ## 行が状態そのものである
 *
 * `venues` ＋ `tables` ＋ `tickets` の行が、そのまま `core` の `VenueState` である。
 * **別にスナップショットの塊を持たない**（[ADR-0013](../../../docs/adr/0013-what-we-record.md)）。
 *
 * ## 整合性は、できるかぎり DB の制約として書く
 *
 * 下の `check(...)` は、すべて `core` の不変条件（`machine/invariants.ts`）を
 * **1 つの表の中だけで確かめられる形に落としたもの**である。名前は元の不変条件に
 * 合わせてあり、対応は `constraints.test.ts` が見ている。
 *
 * **アプリ側のチェックは二重防御であって代替ではない**（CLAUDE.md 3.2(1)）。
 * `core` の検査をすり抜ける道ができても、ここで書き込みが落ちる。
 *
 * 表をまたぐ不変条件（`table_link_is_mutual`、`assignment_status_matches`）は
 * SQLite の CHECK では書けない。そこは `core` と往復のテストが見る。
 */

import {
  COMMAND_TYPES,
  END_REASONS,
  END_REASON_STATES,
  REJECTION_CODES,
  TABLE_STATUSES,
  TAKEN_TABLE_STATUSES,
  TERMINAL_TICKET_STATES,
  TICKET_STATES,
} from '@openseat/core';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ---- 制約を組み立てる小道具 ----

/** `'A', 'B'` の形にする。`IN (...)` の中身を `core` の宣言から導くため。 */
function list(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/** その状態のときだけ真であってほしい条件。ほかの状態では問わない。 */
function when(condition: string, requirement: string): string {
  return `(NOT (${condition}) OR (${requirement}))`;
}

/**
 * 列が、宣言された値のどれかであること。
 *
 * **Drizzle の `enum` は TypeScript の型を狭めるだけで、DB は縛らない。** 縛らないまま
 * にすると、行を読んだ側が「この列は `TicketState` だ」と信じる根拠が無くなる。
 */
function oneOf(column: string, values: readonly string[]): string {
  return `${column} IN (${list(values)})`;
}

const TERMINAL = `state IN (${list(TERMINAL_TICKET_STATES)})`;
const ASSIGNED = `state IN ('CALLED', 'SEATED')`;

/** `END_REASON_STATES` を SQL の条件に落とす。 */
function endReasonMatchesState(): string {
  const pairs = Object.entries(END_REASON_STATES).map(
    ([reason, state]) => `(end_reason = '${reason}' AND state = '${state}')`,
  );
  return `end_reason IS NULL OR ${pairs.join(' OR ')}`;
}

// ---- 施設 ----

/**
 * 施設。**運用の状態（`VenueState` のうち、席とチケット以外）もここに持つ。**
 *
 * `managed_schedule`（7.14 の曜日と時間帯）は JSON で置く。**`core` には渡さない** ——
 * 施設のタイムゾーンで評価して、解決済みの絶対時刻（`closes_at`）だけを渡す（9.4）。
 */
export const venues = sqliteTable(
  'venues',
  {
    id: text('id').primaryKey(),
    /** URL に出る短い名前（`/v/{venue}`）。 */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** 表示に使うタイムゾーン。**保存は常に UTC**（CLAUDE.md 6）。 */
    timezone: text('timezone').notNull().default('Asia/Tokyo'),
    locale: text('locale').notNull().default('ja'),
    /** 7.14 の運用スケジュール（JSON）。境界側で評価する。 */
    managedSchedule: text('managed_schedule'),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),

    /** 運用パラメータ（7.16 の 29 キー）を JSON で。公開の仕組みは PR 15。 */
    policy: text('policy').notNull(),

    // ---- ここから下は `VenueState` の一部 ----
    operating: integer('operating', { mode: 'boolean' }).notNull().default(false),
    joinOpen: integer('join_open', { mode: 'boolean' }).notNull().default(false),
    closesAt: integer('closes_at'),
    /** 最後に進んだ時刻。**時計が戻っていないことを確かめるためだけに持つ**（9.4）。 */
    clockAt: integer('clock_at'),
    nextCodeSeq: integer('next_code_seq').notNull().default(0),

    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (venue) => [
    uniqueIndex('venues_slug').on(venue.slug),
    // 不変条件 `join_requires_operating`（7.14）。逆は成り立たない ——
    // 運用終了の手前では、運用しながら受付だけを閉じている。
    check('join_requires_operating', sql.raw('NOT join_open OR operating')),
    check('next_code_seq_is_not_negative', sql.raw('next_code_seq >= 0')),
  ],
);

// ---- ゾーン ----

/** 席のまとまり。v1 では 1 つで足りるが、v2 のゾーン希望の土台になる（10.2）。 */
export const zones = sqliteTable(
  'zones',
  {
    id: text('id').primaryKey(),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sort: integer('sort').notNull().default(0),
  },
  (zone) => [index('zones_venue').on(zone.venueId)],
);

// ---- 席 ----

/**
 * 席。**`core` の `Table` の全 11 欄 ＋ 境界側の 4 つ**（施設・ゾーン・座席 QR）。
 *
 * 9.6 の列にある `position(x, y, shape)` は置かない。**フロア図は Phase 3** で、
 * 割当は座標を使わない（7.6）。実証実験は一覧編集（PR 13）で回る。
 */
export const tables = sqliteTable(
  'tables',
  {
    id: text('id').primaryKey(),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    zoneId: text('zone_id').references(() => zones.id, { onDelete: 'set null' }),

    /**
     * 座席 QR のトークン。**推測不能なランダム値**（CLAUDE.md 7）。
     * 連番や席番号から導かない。再発行は明示操作のみ。
     */
    token: text('token').notNull(),

    // ---- ここから下は `core` の `Table` ----
    label: text('label').notNull(),
    capacity: integer('capacity').notNull(),
    /** 車いす対応・電源など。JSON の配列。 */
    tags: text('tags').notNull().default('[]'),
    adminRank: integer('admin_rank').notNull().default(0),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    status: text('status', { enum: TABLE_STATUSES }).notNull(),
    statusSince: integer('status_since').notNull(),
    verifiedFreeAt: integer('verified_free_at'),
    occupantTicketId: text('occupant_ticket_id'),
    /** 対象外にする操作が保留されているか（7.6 のエッジケース）。**9.6 に無い列。** */
    disableAfterCurrent: integer('disable_after_current', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  (table) => [
    index('tables_venue').on(table.venueId),
    // 座席 QR は施設をまたいで一意。トークンだけで席が引けること（7.8）。
    uniqueIndex('tables_token').on(table.token),
    // 席番号は施設の中で一意。印刷した番号が重なると現場が混乱する。
    uniqueIndex('tables_venue_label').on(table.venueId, table.label),

    check('capacity_is_positive', sql.raw('capacity >= 1')),
    check('table_status_is_declared', sql.raw(oneOf('status', TABLE_STATUSES))),

    // 不変条件 `unmanaged_table_is_disabled`。**対象外なのに使える状態の席**が
    // あると、画面には空席として見えるのに誰にも案内されない席ができる。
    check('unmanaged_table_is_disabled', sql.raw(`enabled OR status = 'DISABLED'`)),

    // 不変条件 `disabled_table_has_no_reservation`。残ると、翌日の運用開始で
    // その席が一瞬だけ空席として戻り、すぐまた外れる。
    check(
      'disabled_table_has_no_reservation',
      sql.raw(`NOT disable_after_current OR status <> 'DISABLED'`),
    ),

    // `table_link_is_mutual` と `assignment_status_matches` を、1 つの表の中だけで
    // 言える形にしたもの。誰かが使っている姿の席でなければ、占有者は入らない。
    check(
      'occupant_only_when_taken',
      sql.raw(
        `occupant_ticket_id IS NULL OR status IN (${list([...TAKEN_TABLE_STATUSES, 'NEEDS_CHECK'])})`,
      ),
    ),
  ],
);

// ---- チケット ----

/**
 * チケット。**`core` の `Ticket` の全 26 欄 ＋ 境界側の 2 つ**（施設・端末トークン）。
 *
 * 9.6 が挙げている列は 18 で、`core` より 9 つ少ない。9.6 は概略なので当然だが、
 * **足りないまま写すと再起動で状態が欠ける。** ここが出典であり、9.6 の側を直した。
 *
 * **終端に達したチケットも残る**（`core` がそう設計されている）。履歴として要るし、
 * 「もう終わっている」という拒否を返すのにも要る。
 */
export const tickets = sqliteTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),

    /**
     * 端末の匿名トークンのハッシュ（9.8、CLAUDE.md 7）。
     * **生の値は保存しない。** 氏名も電話番号も取らない。
     */
    clientTokenHash: text('client_token_hash'),

    // ---- ここから下は `core` の `Ticket` ----
    code: text('code').notNull(),
    partySize: integer('party_size').notNull(),
    requiredTags: text('required_tags').notNull().default('[]'),
    state: text('state', { enum: TICKET_STATES }).notNull(),
    priorityAt: integer('priority_at').notNull(),
    createdAt: integer('created_at').notNull(),
    /**
     * 割り当てられている席。不変条件 `assigned_has_table` の「実在する」を外部キーが見る。
     *
     * **逆向き（`tables.occupant_ticket_id` → `tickets.id`）は張らない。** 循環した
     * 外部キーになり、書き込みの順序に縛りが出る。逆向きの一致は `core` の
     * `table_link_is_mutual` と往復のテストが見る。
     */
    tableId: text('table_id').references(() => tables.id),
    calledAt: integer('called_at'),
    holdDeadline: integer('hold_deadline'),
    holdRemindedAt: integer('hold_reminded_at'),
    extensions: integer('extensions').notNull().default(0),
    passes: integer('passes').notNull().default(0),
    noShows: integer('no_shows').notNull().default(0),
    conflictPriority: integer('conflict_priority', { mode: 'boolean' }).notNull().default(false),
    seatedAt: integer('seated_at'),
    endedAt: integer('ended_at'),
    endReason: text('end_reason', { enum: END_REASONS }),
    pauseDeadline: integer('pause_deadline'),
    pausedSince: integer('paused_since'),
    pausedTotal: integer('paused_total').notNull().default(0),
    lastSeenAt: integer('last_seen_at').notNull(),
    hasNotificationChannel: integer('has_notification_channel', { mode: 'boolean' })
      .notNull()
      .default(false),
    stillHereAskedAt: integer('still_here_asked_at'),
    stillHereAnsweredAt: integer('still_here_answered_at'),
    timeLimitNoticedAt: integer('time_limit_noticed_at'),
  },
  (ticket) => [
    index('tickets_venue_state').on(ticket.venueId, ticket.state),

    /**
     * **1 つの席に、席を持つチケットは最大 1 枚**（不変条件 `one_ticket_per_table`）。
     *
     * **これが破られると製品が成立しない。** 2 組が同じ席へ案内される。
     * `core` が守っているものを、DB でも縛る。
     */
    uniqueIndex('one_ticket_per_table')
      .on(ticket.tableId)
      .where(sql.raw(`table_id IS NOT NULL AND ${ASSIGNED}`)),

    /**
     * **生きているチケットの表示コードは、施設の中で一意**（不変条件
     * `unique_active_codes`）。ボードで「A-23 番の方」と呼ぶので、重なると
     * 別人が席へ向かってしまう。終端に達したものは重複してよい。
     */
    uniqueIndex('unique_active_codes')
      .on(ticket.venueId, ticket.code)
      .where(sql.raw(`NOT ${TERMINAL}`)),

    ...ticketValueChecks(),
    ...ticketSeatChecks(),
    ...ticketNoticeChecks(),
  ],
);

/**
 * 1 つの列だけで言える制約。値が名乗りどおりであること。
 *
 * 列を参照しない（SQL の文だけで書ける）ので、表の宣言から切り出してある。
 */
function ticketValueChecks() {
  return [
    check('party_size_is_positive', sql.raw('party_size >= 1')),
    check('ticket_state_is_declared', sql.raw(oneOf('state', TICKET_STATES))),
    check('end_reason_is_declared', sql.raw(`end_reason IS NULL OR ${oneOf('end_reason', END_REASONS)}`)),
  ];
}

/**
 * 状態と、席のつじつまが合っていること。
 *
 * **どれも `core` の不変条件（`machine/invariants.ts`）と同じ名前で並べてある。**
 * 名前が対応していれば、どちらを読んでいても対応物を探せる。
 */
function ticketSeatChecks() {
  return [
    // 不変条件 `assigned_has_table` と `terminal_holds_no_table` の、
    // チケット側から言える半分。席が実在するかは往復のテストが見る。
    check('assigned_has_table', sql.raw(when(ASSIGNED, 'table_id IS NOT NULL'))),
    check('terminal_holds_no_table', sql.raw(when(TERMINAL, 'table_id IS NULL'))),

    // 不変条件 `held_table_has_deadline`。期限が無いと、呼び出しに応じない人の
    // ために席が永久に押さえられる。
    check(
      'held_table_has_deadline',
      sql.raw(when(`state = 'CALLED'`, 'hold_deadline IS NOT NULL AND called_at IS NOT NULL')),
    ),

  ];
}

/** 状態に応じた時刻と、知らせの記録のつじつまが合っていること。 */
function ticketNoticeChecks() {
  return [
    check('state_timestamps_are_set', sql.raw(stateTimestampsAreSet())),
    check('notices_are_scoped', sql.raw(noticesAreScoped())),
    check('end_reason_matches_state', sql.raw(endReasonMatchesState())),
  ];
}

/** 不変条件 `state_timestamps_are_set`。状態に応じた時刻が入っていること。 */
function stateTimestampsAreSet(): string {
  return [
    when(`state = 'SEATED'`, 'seated_at IS NOT NULL'),
    when(`state = 'PAUSED'`, 'pause_deadline IS NOT NULL AND paused_since IS NOT NULL'),
    when(TERMINAL, 'ended_at IS NOT NULL AND end_reason IS NOT NULL'),
  ].join(' AND ');
}

/**
 * 同じく `state_timestamps_are_set` の逆向き。**その状態以外では空であること。**
 *
 * `paused_since` を消し忘れると `paused_total` が二重に積み上がり、
 * `pause_max_total_min` が実際より早く尽きる。`hold_reminded_at` を消し忘れると
 * 次の呼び出しで知らせが出ない。**どちらも黙って壊れる種類の間違いである。**
 */
function noticesAreScoped(): string {
  return [
    when(`state <> 'PAUSED'`, 'paused_since IS NULL'),
    when(`state <> 'CALLED'`, 'hold_reminded_at IS NULL'),
    when(
      `state <> 'SEATED'`,
      'still_here_asked_at IS NULL AND still_here_answered_at IS NULL AND time_limit_noticed_at IS NULL',
    ),
  ].join(' AND ');
}

// ---- 起きたこと ----

/**
 * ドメインイベント（`core` の `DomainEvent`）。**復元には使わない。使えない。**
 *
 * 使うのは配信（9.5）、統計（8.3）、監査（CLAUDE.md 7）である。理由は
 * [ADR-0013](../../../docs/adr/0013-what-we-record.md) にある。
 *
 * `payload` が出典で、`type` / `ticket_id` / `table_id` は引くための写しにすぎない。
 * `actor_*` は**そのイベントを生んだコマンドの実行者**。`tick` から出たイベントは
 * 誰の操作でもないので `null` になる。
 */
export const events = sqliteTable(
  'events',
  {
    /** 配信の順序と「取りこぼしの追いつき」に使う（9.5）。 */
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    /**
     * **そうなった時刻。** `seq` の順とは一致しない。
     *
     * 期限で起きたことは、**期限の時刻**が入る（`settle.ts`・`tick.ts`）。`tick` が
     * 3 分遅れて走っても「3 分前に呼び出しが切れた」と記録されるので、統計（8.3）が
     * 走らせ方に左右されない。そのかわり、**先に記録したイベントより前の時刻を持つ
     * ことがある。**
     *
     * だから**順序を問うときは `seq` を見ること**。配信の追いつき（9.5）でここを
     * 使うと、取りこぼす。
     */
    at: integer('at').notNull(),
    /**
     * **こちらに記録した時刻。** `at` との差が、そのまま `tick` の遅れになる。
     *
     * 管理画面に出すことが決まっている（CLAUDE.md 8 の監視）。あとから足すと、
     * 運用中の施設にマイグレーションを当てることになるので、いま置いておく。
     */
    recordedAt: integer('recorded_at').notNull(),
    type: text('type').notNull(),
    ticketId: text('ticket_id'),
    tableId: text('table_id'),
    actorKind: text('actor_kind'),
    actorId: text('actor_id'),
    payload: text('payload').notNull(),
  },
  (event) => [
    index('events_venue_seq').on(event.venueId, event.seq),
    index('events_venue_at').on(event.venueId, event.at),
  ],
);

// ---- 受け取ったコマンドの控え ----

/**
 * 同じコマンドが二度届いたときのための控え（9.4、[ADR-0015](../../../docs/adr/0015-idempotency-key.md)）。
 *
 * **モバイル回線では、届いた応答が返ってこないことがある。** 画面は送り直すが、
 * 受け取る側から見れば同じ要求が 2 回来る。**2 枚目のチケットを作ってはいけない。**
 *
 * 鍵は画面が作る（コマンドごとに 1 つ）。**同じ鍵で二度目が来たら、適用せずに
 * 前回の結末を返す。**
 *
 * **控えるのは結末だけで、応答そのものではない。** どのチケットの話で、通ったか
 * 断られたか、だけを残す。画面に返す中身は**そのときの状態**から作り直す ——
 * 30 秒前の姿を返すより、いまの姿を返すほうが役に立つ（ADR-0015）。
 */
export const commandLog = sqliteTable(
  'command_log',
  {
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    /** 画面が作った鍵。**推測されても困らない**が、衝突すると別の操作が飲み込まれる。 */
    key: text('key').notNull(),
    /** 受け取った時刻。**古い控えを捨てる**ための目印（24 時間）。 */
    at: integer('at').notNull(),
    commandType: text('command_type', { enum: COMMAND_TYPES }).notNull(),
    /** 通ったか。断られたなら理由が入る。 */
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    rejectionCode: text('rejection_code', { enum: REJECTION_CODES }),
    /** その操作が相手にした（または作った）チケット。 */
    ticketId: text('ticket_id'),
  },
  (entry) => [
    primaryKey({ columns: [entry.venueId, entry.key] }),
    // 古い控えを捨てるときに引く。
    index('command_log_at').on(entry.at),
    // 通ったなら理由は無く、断られたなら理由がある。**どちらでもない行を作らない。**
    check('command_type_is_declared', sql.raw(oneOf('command_type', COMMAND_TYPES))),
    check(
      'rejection_code_is_declared',
      sql.raw(`rejection_code IS NULL OR ${oneOf('rejection_code', REJECTION_CODES)}`),
    ),
    check(
      'rejection_matches_outcome',
      sql.raw('(ok AND rejection_code IS NULL) OR (NOT ok AND rejection_code IS NOT NULL)'),
    ),
  ],
);

// ---- 席の姿の履歴（投影） ----

/**
 * 席がどの姿に、いつからいつまでいたか。**稼働率を出すためだけにある**（8.3）。
 *
 * **9.6 に無い表である。足した理由は Phase 1 の PR 14 で分かったことにある。**
 *
 * > イベントは「起きたこと」を語るが、「席がいまどの姿か」を語る責任を負っていない。
 * > `TableReportedInUse` は 2 つの行き先へ向かい、`StillHereAnswered` は席が確認要から
 * > 使用中へ戻ったことを語らず、`VenueOpened` はどの席が運用に戻ったかを持たない。
 *
 * **これは投影であって新しい真実ではない。** 書くのは境界側で、変更の前後の状態を
 * 両方知っているから差分だけで済む。シミュレータの `TableSpan` と同じ形なので、
 * Phase 1 の `sim/metrics.ts` がそのまま使える（Phase 3 のレポート画面）。
 *
 * まだ続いている区間は `until_at` が `null`。次に姿が変わったときに閉じる。
 */
export const tableStatusLog = sqliteTable(
  'table_status_log',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    tableId: text('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
    status: text('status', { enum: TABLE_STATUSES }).notNull(),
    fromAt: integer('from_at').notNull(),
    /** まだ続いているなら `null`。 */
    untilAt: integer('until_at'),
    /** そのあいだ席に結びついていたチケット。 */
    occupantTicketId: text('occupant_ticket_id'),
  },
  (span) => [
    index('status_log_venue_table').on(span.venueId, span.tableId),

    // **席ごとに、開いている区間は 1 つだけ。** 閉じ忘れると稼働率が静かに狂う。
    uniqueIndex('one_open_span_per_table').on(span.tableId).where(sql.raw('until_at IS NULL')),

    // 逆向きに進む区間は、隙間なく覆えているかの検算（`spanCoverage`）を壊す。
    check('span_moves_forward', sql.raw('until_at IS NULL OR until_at >= from_at')),
    check('span_status_is_declared', sql.raw(oneOf('status', TABLE_STATUSES))),
  ],
);

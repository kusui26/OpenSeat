/**
 * 読み書きとトランザクション。
 *
 * **ここに業務判断は書かない**（CLAUDE.md 3.1）。`core` が決めた結果を、
 * 1 つのトランザクションで記録するだけである。条件分岐はすべて
 * 「何が変わったか」の判定で、「どうすべきか」の判定ではない。
 *
 * ## 3 本立て（[ADR-0013](../../../docs/adr/0013-what-we-record.md)）
 *
 * | 記録 | 何のため |
 * |---|---|
 * | `venues` ＋ `tables` ＋ `tickets` の行 | **復元のため。これが状態そのもの** |
 * | `events` | 配信・統計・監査のため |
 * | `table_status_log` | **稼働率のため。**席がどの姿に、いつからいつまでいたか |
 *
 * 3 つとも同じトランザクションで書く。**遅れを作らない**のが復元の前提である。
 */

import {
  DOMAIN_EVENT_TYPES,
  findTable,
  findTicket,
  isTerminal,
  sameTable,
  sameTicket,
  type Actor,
  type DomainEvent,
  type Table,
  type Ticket,
  type Timestamp,
  type VenueState,
} from '@openseat/core';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  decodeVenueState,
  encodeTable,
  encodeTicket,
  encodeVenueState,
  type TableKeys,
  type TicketKeys,
} from './codec.js';
import { events, tableStatusLog, tables, tickets, venues } from './schema.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type TicketRow = typeof tickets.$inferSelect;

/** 1 回の適用で起きたことの全部。 */
export interface Commit {
  readonly before: VenueState;
  readonly after: VenueState;
  readonly events: readonly DomainEvent[];
  /**
   * コマンドを出した人（9.8）。`tick` から出た変化には実行者がいないので `null`。
   *
   * **役割と識別子だけを残す。** 氏名も連絡先も持たない（CLAUDE.md 7 章）。
   */
  readonly actor: Actor | null;
  /** 適用した時刻。**サーバ時刻だけを信じる**（9.4）。 */
  readonly at: Timestamp;
}

/** 席の姿の履歴の 1 区間。`core` の外の概念なので、ここで型を持つ。 */
export interface TableSpanRow {
  readonly tableId: string;
  readonly status: string;
  readonly fromAt: Timestamp;
  readonly untilAt: Timestamp | null;
  readonly occupantTicketId: string | null;
}

// ---- 読む ----

/**
 * 施設の状態を組み立てて返す。**これが「復元」のすべてである。**
 *
 * イベントは読まない。読んでも状態は組み直せない（ADR-0013）。
 *
 * ## なぜ `rowid` で並べるのか
 *
 * **書いた順に返すためである。** `core` の `VenueState` は席とチケットを配列で持ち、
 * 新しいチケットは末尾に足される。ここを ID 順で返すと、`k-9` と `k-10` の前後が
 * 入れ替わり、**再起動する前と後で配列の並びが変わる。**
 *
 * 並びが変われば、`sameVenueState`（`tick` の冪等性を見る判定。位置で比べる）が
 * 再起動をまたいだ瞬間だけ偽になる。**落ちたあとにだけ出る食い違い**は、
 * いちばん見つけにくい種類である。
 *
 * `created_at` で並べても足りない。同じミリ秒に 2 組が受付すると順序が決まらない。
 * SQLite の `rowid` は**挿入した順に増える**ので、これが「書いた順」そのものになる。
 */
export function loadVenueState(db: Db, venueId: string): VenueState | null {
  const venue = db.select().from(venues).where(eq(venues.id, venueId)).get();
  if (venue === undefined) return null;

  return decodeVenueState(
    venue,
    db.select().from(tables).where(eq(tables.venueId, venueId)).orderBy(WRITTEN_ORDER).all(),
    db.select().from(tickets).where(eq(tickets.venueId, venueId)).orderBy(WRITTEN_ORDER).all(),
  );
}

/** 書いた順。SQLite が行に振る連番で、更新しても動かない。 */
const WRITTEN_ORDER = sql`rowid`;

/** ある番号より後のイベント。配信の追いつき（9.5）と統計が使う。 */
export function readEvents(db: Db, venueId: string, afterSeq = 0): readonly DomainEvent[] {
  return db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.venueId, venueId), gt(events.seq, afterSeq)))
    .orderBy(asc(events.seq))
    .all()
    .map((row) => decodeEvent(row.payload));
}

/** 席の姿の履歴。稼働率（8.3）が使う。 */
export function readTableSpans(db: Db, venueId: string): readonly TableSpanRow[] {
  return db
    .select({
      tableId: tableStatusLog.tableId,
      status: tableStatusLog.status,
      fromAt: tableStatusLog.fromAt,
      untilAt: tableStatusLog.untilAt,
      occupantTicketId: tableStatusLog.occupantTicketId,
    })
    .from(tableStatusLog)
    .where(eq(tableStatusLog.venueId, venueId))
    .orderBy(asc(tableStatusLog.seq))
    .all();
}

/**
 * 保存されていたイベントを読み戻す。
 *
 * **確かめるのは名札だけである。** 中身まで見ないのは、`payload` を書いたのが
 * 自分自身であり、復元にも使わないからである（ADR-0013）。それでも名札を見るのは、
 * 読んだ側が `DomainEvent` として扱う以上、せめて種別が宣言のどれかであることは
 * 確かめておきたいため。
 */
function decodeEvent(payload: string): DomainEvent {
  const parsed: unknown = JSON.parse(payload);
  if (!looksLikeEvent(parsed)) throw new Error('events.payload の形が違います');
  return parsed;
}

function looksLikeEvent(value: unknown): value is DomainEvent {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value) || !('at' in value)) return false;
  return DOMAIN_EVENT_TYPES.some((known) => known === value.type) && typeof value.at === 'number';
}

// ---- 施設と席を作る ----

export interface CreateVenueParams {
  readonly state: VenueState;
  readonly slug: string;
  readonly name: string;
  readonly timezone?: string;
  readonly now: Timestamp;
}

/** 施設を作る。席は `insertTable` で足す（一覧編集は PR 13）。 */
export function createVenue(db: Db, params: CreateVenueParams): void {
  db.insert(venues)
    .values({
      id: params.state.venueId,
      slug: params.slug,
      name: params.name,
      ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
      managedSchedule: null,
      createdAt: params.now,
      updatedAt: params.now,
      ...encodeVenueState(params.state),
    })
    .run();
}

/** 席を足す。**姿の履歴も、ここから始まる。** */
export function insertTable(db: Db, table: Table, keys: TableKeys): void {
  db.transaction((tx) => {
    tx.insert(tables).values(encodeTable(table, keys)).run();
    openSpan(tx, keys.venueId, table);
  });
}

// ---- 書く ----

/**
 * 1 回の適用を記録する。**全部が入るか、全部が入らないか**のどちらかになる。
 *
 * 不変条件を破った状態は、`core` が先に弾く。それでも DB の制約を置いてあるのは
 * 二重防御であって代替ではないからで（CLAUDE.md 3.2(1)）、ここで落ちたら
 * **その変更は丸ごと捨てられる**。壊れた状態が残るより、書けないほうがよい。
 */
export function commit(db: Db, change: Commit): void {
  db.transaction((tx) => {
    ensureSeatsUnchanged(change);
    writeTables(tx, change);
    writeTickets(tx, change);
    writeVenue(tx, change);
    writeEvents(tx, change);
    writeSpans(tx, change);
  });
}

function writeVenue(tx: Tx, change: Commit): void {
  tx.update(venues)
    .set({ ...encodeVenueState(change.after), updatedAt: change.at })
    .where(eq(venues.id, change.after.venueId))
    .run();
}

// ---- 席 ----

/**
 * 席は増えも減りもしていないか。
 *
 * **`core` は席の増減をしない。** 席を足すのは `insertTable`、消すのは一覧編集
 * （PR 13）で、どちらもここを通らない。それでも確かめるのは、**黙って 0 行を
 * 更新して見失う**ことだけは避けたいからである。減っていれば行が残り、
 * 次に読んだときに消したはずの席がよみがえる。
 */
function ensureSeatsUnchanged(change: Commit): void {
  const ids = (state: VenueState): string => state.tables.map((table) => table.id).toSorted().join(',');
  if (ids(change.before) === ids(change.after)) return;
  throw new Error('core から席の増減が返りました。席の追加は insertTable を通すこと');
}

function writeTables(tx: Tx, change: Commit): void {
  const changed = change.after.tables.filter((table) => !unchangedTable(change.before, table));
  for (const table of changed) {
    tx.update(tables)
      .set({
        enabled: table.enabled,
        status: table.status,
        statusSince: table.statusSince,
        verifiedFreeAt: table.verifiedFreeAt,
        occupantTicketId: table.occupantTicketId,
        disableAfterCurrent: table.disableAfterCurrent,
      })
      .where(eq(tables.id, table.id))
      .run();
  }
}

function unchangedTable(before: VenueState, table: Table): boolean {
  const previous = findTable(before, table.id);
  return previous !== undefined && sameTable(previous, table);
}

// ---- チケット ----

/**
 * チケットを書く。**順序に意味がある。**
 *
 * 部分一意インデックスも CHECK 制約も、**文が 1 つ終わるたびに**判定される。
 * トランザクションの終わりまで待ってはくれない。だから「A が席を離れ、B がその席に
 * 着く」を 1 回の適用で記録するとき、B を先に書くと**一瞬だけ 2 枚になり、
 * 正しい変更のほうが弾かれる**。片付け猶予が 0 分（既定）なら、これは毎回起きる。
 *
 * **途中に嘘の行を置いて逃げることはできない。** 「いったん `table_id` を外す」と、
 * `CALLED` のまま席を持たない行になり、今度は `assigned_has_table` が落とす。
 * どの一瞬を切り取っても筋が通っている必要がある。
 *
 * だから**書く順番だけで解く**。
 *
 * 1. 席を手放すチケット（手放しつつ別の席へ移る人も含む）
 * 2. 終端に落ちるチケット（表示コードを空ける）
 * 3. 残り
 *
 * これで足りるのは、`core` が**席を受け取るのは席を持っていない人だけ**に
 * してあるからである（割当は `WAITING` にしか配らず、席の変更は空席にしか移れない）。
 * 輪になった持ち替えは起こらない。**万一それが崩れたら、ここは書き込みに失敗し、
 * その変更は丸ごと捨てられる**。壊れた状態が残るよりはよい。
 */
function writeTickets(tx: Tx, change: Commit): void {
  const changed = change.after.tickets.filter((ticket) => !unchangedTicket(change.before, ticket));
  for (const ticket of writeOrder(change, changed)) {
    upsertTicket(tx, encodeTicket(ticket, ticketKeys(change)));
  }
}

function writeOrder(change: Commit, changed: readonly Ticket[]): readonly Ticket[] {
  const releasing = changed.filter((ticket) => releasesTable(change.before, ticket));
  const keeping = changed.filter((ticket) => !releasesTable(change.before, ticket));
  return [
    ...releasing,
    ...keeping.filter((ticket) => isTerminal(ticket.state)),
    ...keeping.filter((ticket) => !isTerminal(ticket.state)),
  ];
}

function unchangedTicket(before: VenueState, ticket: Ticket): boolean {
  const previous = findTicket(before, ticket.id);
  return previous !== undefined && sameTicket(previous, ticket);
}

/** そのチケットは、いま押さえている席を手放そうとしているか。 */
function releasesTable(before: VenueState, ticket: Ticket): boolean {
  const previous = findTicket(before, ticket.id);
  if (previous === undefined || previous.tableId === null) return false;
  return previous.tableId !== ticket.tableId;
}

/**
 * `core` が持たない欄は、前の行から引き継ぐ。
 *
 * 端末トークンのハッシュは受付のときに決まり、以後は変わらない。新しいチケットに
 * 付けるのは PR 5（匿名トークン）の仕事で、そこまでは `null` のままでよい。
 */
function ticketKeys(change: Commit): TicketKeys {
  return { venueId: change.after.venueId, clientTokenHash: null };
}

function upsertTicket(tx: Tx, row: TicketRow): void {
  tx.insert(tickets)
    .values(row)
    .onConflictDoUpdate({ target: tickets.id, set: withoutKeys(row) })
    .run();
}

/** 更新では触らない欄を落とす。施設は変わらず、端末トークンは受付のときだけ決まる。 */
function withoutKeys(row: TicketRow): Omit<TicketRow, 'id' | 'venueId' | 'clientTokenHash'> {
  const { id, venueId, clientTokenHash, ...rest } = row;
  return rest;
}

// ---- 起きたこと ----

/**
 * 起きたことを追記する。
 *
 * **小分けにする。** SQLite の 1 文に置ける値の数には上限があり、`tick` が
 * 長い空白のあとに走ると（落ちていたあと、9.4）イベントが数千件になりうる。
 * **いちばん要るときに落ちる**たぐいの上限なので、最初から避けておく。
 */
const EVENTS_PER_STATEMENT = 200;

function writeEvents(tx: Tx, change: Commit): void {
  const rows = change.events.map((event) => eventRow(change, event));
  for (let from = 0; from < rows.length; from += EVENTS_PER_STATEMENT) {
    tx.insert(events).values(rows.slice(from, from + EVENTS_PER_STATEMENT)).run();
  }
}

function eventRow(change: Commit, event: DomainEvent): typeof events.$inferInsert {
  return {
    venueId: change.after.venueId,
    at: event.at,
    recordedAt: change.at,
    type: event.type,
    ticketId: 'ticketId' in event ? event.ticketId : null,
    tableId: 'tableId' in event ? event.tableId : null,
    actorKind: change.actor?.role ?? null,
    actorId: change.actor?.userId ?? null,
    payload: JSON.stringify(event),
  };
}

// ---- 席の姿の履歴 ----

/**
 * 姿が変わった席の区間を、閉じて開き直す。
 *
 * **判定はシミュレータの `turnedOver` と同じ**（同じ姿でも占有者が入れ替われば
 * 別の区間）だが、1 つだけ広げてある。**`statusSince` が動いたら必ず区切る。**
 *
 * シミュレータは状態が変わるたびに観測するので取りこぼさないが、こちらは
 * 1 回の適用の前後しか見ない。`FREE → HELD → FREE` のように往復して戻ると、
 * 前後の比較では「変わっていない」に見える。`statusSince` を見ていれば区切れる。
 *
 * おかげで **「開いている区間の `from_at` は、その席の `status_since` に等しい」**
 * が常に成り立つ。検算できる形にしておく（`spanCoverage`）。
 */
function writeSpans(tx: Tx, change: Commit): void {
  for (const table of change.after.tables) {
    const previous = findTable(change.before, table.id);
    if (previous === undefined || !movedOn(previous, table)) continue;
    const boundary: Timestamp = spanBoundary(tx, table);
    closeOpenSpan(tx, table.id, boundary);
    openSpan(tx, change.after.venueId, table, boundary);
  }
}

/**
 * 区切りの時刻。ふつうは席がいまの姿になった時刻そのものだが、**戻ることがある。**
 *
 * `core` は期限で起きたことを**期限の時刻**で記録する（`settle.ts`・`tick.ts`）。
 * ところが席の姿は、それより**あとの**壁時計で変わっていることがある。
 *
 * > 18 分に呼び出し（期限 25 分）。26 分に本人が別の空席の QR を読んで席を変える
 * > （`SWAP_TABLE`）。その席は 26 分に「確保」になる。同じ 26 分に `tick` が走り、
 * > 「この呼び出しは 25 分に切れていた」と判断して席を空ける —— **26 分に確保した
 * > 席が、25 分に空く。**
 *
 * `tick` は 10 秒ごとに走るので（9.4）、この窓は本来ごく狭い。だが落ちていた
 * あいだは広がるし、**起こりうる以上は記録が壊れてはいけない。**
 *
 * だからここでは、**区間の境目が前の区間の始まりより前に行かないようにする。**
 * 上の例なら「確保」は長さ 0 の区間になり、26 分から空席が続く。席が実際に
 * 塞がっていた時間は 0 なので、稼働率としてはこれが正しい。
 *
 * **これは `core` 側の課題を覆い隠すものではない。** 席の `status_since` が戻ること
 * 自体は、片付け猶予や無断利用の期限（どれも `status_since` からの経過で測る）を
 * 狂わせうる。[Phase 2 のプラン](../../../docs/260921_plan_Phase2.md)の申し送りに
 * 挙げてあり、施設アクターと `tick` を作る PR 3 で片づける。
 */
function spanBoundary(tx: Tx, table: Table): Timestamp {
  const open = tx
    .select({ fromAt: tableStatusLog.fromAt })
    .from(tableStatusLog)
    .where(and(eq(tableStatusLog.tableId, table.id), isNull(tableStatusLog.untilAt)))
    .get();
  return Math.max(open?.fromAt ?? table.statusSince, table.statusSince);
}

/** 別の区間として数えるべき変化か。 */
function movedOn(previous: Table, table: Table): boolean {
  if (previous.status !== table.status) return true;
  if (previous.statusSince !== table.statusSince) return true;
  const next: string | null = table.occupantTicketId;
  return next !== null && previous.occupantTicketId !== null && next !== previous.occupantTicketId;
}

function closeOpenSpan(tx: Tx, tableId: string, until: Timestamp): void {
  tx.update(tableStatusLog)
    .set({ untilAt: until })
    .where(and(eq(tableStatusLog.tableId, tableId), isNull(tableStatusLog.untilAt)))
    .run();
}

function openSpan(tx: Tx, venueId: string, table: Table, from?: Timestamp): void {
  tx.insert(tableStatusLog)
    .values({
      venueId,
      tableId: table.id,
      status: table.status,
      fromAt: from ?? table.statusSince,
      untilAt: null,
      occupantTicketId: table.occupantTicketId,
    })
    .run();
}

// ---- 運用の記録 ----

/** 適用したマイグレーションの数。`/healthz` が「DB に届いている」ことを示すのに使う。 */
export function migrationCount(db: Db): number {
  const row = db.get<{ count: number }>(
    sql`SELECT COUNT(*) AS count FROM __drizzle_migrations`,
  );
  return row?.count ?? 0;
}

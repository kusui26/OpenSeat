/**
 * 行と `core` の型のあいだの変換。
 *
 * **ここに業務判断は書かない。** 形を移し替えるだけである（CLAUDE.md 3.1）。
 *
 * ## なぜ手で書くのか
 *
 * 行から型を作るところは、**全項目を並べた 1 つのオブジェクトリテラル**にしてある。
 * 面倒に見えるが、これは道具である —— `core` の `Ticket` に欄が 1 つ増えたら
 * **ここが型エラーになる**。欄を足したのに保存を忘れる、という間違いは
 * 「気をつける」では防げない（CLAUDE.md 3 章）。
 *
 * ## 読むほうは、疑ってかかる
 *
 * DB のファイルは運用の現場にあり、人の手が入りうる。**読んだ値が名乗りどおりか
 * どうかは確かめる。** 確かめずに `core` へ渡すと、壊れた状態のまま動き出す。
 */

import {
  DEFAULT_POLICY,
  NO_SHOW_POLICIES,
  TABLE_ORDER_KEYS,
  TIME_LIMIT_MODES,
  type NoShowPolicy,
  type Policy,
  type Table,
  type TableOrderKey,
  type Tag,
  type Ticket,
  type TimeLimitMode,
  type VenueState,
} from '@openseat/core';
import type { tables, tickets, venues } from './schema.js';

type TableRow = typeof tables.$inferSelect;
type TicketRow = typeof tickets.$inferSelect;
type VenueRow = typeof venues.$inferSelect;

/**
 * 保存されていた値が、名乗りどおりでなかった。
 *
 * **文脈は付けるが、秘密は載せない**（CLAUDE.md 4 章・7 章）。座席トークン、
 * 端末トークン、通知先はここに現れない。
 */
export class DecodeError extends Error {
  constructor(where: string, key: string, detail: string) {
    super(`${where}.${key} を読めません: ${detail}`);
    this.name = 'DecodeError';
  }
}

// ---- 値を読む ----

function fields(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DecodeError(where, '(全体)', 'オブジェクトではありません');
  }
  return { ...value };
}

function readNumber(source: Readonly<Record<string, unknown>>, where: string, key: string): number {
  const raw: unknown = source[key];
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
  // JSON は無限大を表せないので、文字列に逃がしてある（`encodePolicy`）。
  if (raw === 'Infinity') return Number.POSITIVE_INFINITY;
  if (raw === '-Infinity') return Number.NEGATIVE_INFINITY;
  throw new DecodeError(where, key, '数ではありません');
}

function readNullableNumber(
  source: Readonly<Record<string, unknown>>,
  where: string,
  key: string,
): number | null {
  return source[key] === null ? null : readNumber(source, where, key);
}

function readBoolean(source: Readonly<Record<string, unknown>>, where: string, key: string): boolean {
  const raw: unknown = source[key];
  if (typeof raw === 'boolean') return raw;
  throw new DecodeError(where, key, '真偽値ではありません');
}

/** 宣言された値のどれかであること。名乗りどおりでなければ落とす。 */
function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
  key: string,
): T {
  const found: T | undefined = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new DecodeError(where, key, `${allowed.join(' / ')} のどれかであること`);
  }
  return found;
}

function readOneOf<T extends string>(
  source: Readonly<Record<string, unknown>>,
  where: string,
  key: string,
  allowed: readonly T[],
): T {
  return pick(source[key], allowed, where, key);
}

function readManyOf<T extends string>(
  source: Readonly<Record<string, unknown>>,
  where: string,
  key: string,
  allowed: readonly T[],
): readonly T[] {
  const raw: unknown = source[key];
  if (!Array.isArray(raw)) throw new DecodeError(where, key, '配列ではありません');
  return raw.map((item: unknown, index: number) => pick(item, allowed, where, `${key}[${index}]`));
}

/** 文字列の配列。タグに使う。中身は施設が決めるので、値までは縛らない。 */
function decodeTags(json: string, where: string): readonly Tag[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new DecodeError(where, 'tags', '配列ではありません');
  return parsed.map((item, index) => {
    if (typeof item !== 'string') throw new DecodeError(where, `tags[${index}]`, '文字列ではありません');
    return item;
  });
}

// ---- 運用パラメータ ----

/**
 * 運用パラメータを JSON にする。
 *
 * **無限大を落とさない。** `fairnessOverrideMin` は `Infinity` を取りうる
 * （「純粋な best fit」の指定。7.16）が、`JSON.stringify(Infinity)` は `null` を
 * 返す。そのまま保存すると、**再起動したときだけ割当の方針が変わる**という、
 * いちばん気づきにくい壊れ方をする。
 */
export function encodePolicy(policy: Policy): string {
  return JSON.stringify(policy, (_key: string, value: unknown) =>
    typeof value === 'number' && !Number.isFinite(value) ? String(value) : value,
  );
}

/**
 * JSON から運用パラメータに戻す。
 *
 * **既定値で埋めない。** 「読めなかったキーは `DEFAULT_POLICY` から借りる」に
 * すると、保存し忘れたキーが黙って既定に戻り、施設が設定したはずの値が消える。
 * 読めなければ失敗させる。
 */
export function decodePolicy(json: string): Policy {
  const at = 'policy';
  const raw = fields(JSON.parse(json), at);
  return {
    ...readJoinKeys(raw),
    ...readAllocationKeys(raw),
    ...readHoldKeys(raw),
    ...readPauseKeys(raw),
    ...readTimeLimitKeys(raw),
    ...readRecoveryKeys(raw),
    ...readEstimateKeys(raw),
  };
}

type Section<K extends keyof Policy> = Pick<Policy, K>;
type Raw = Readonly<Record<string, unknown>>;

function readJoinKeys(
  raw: Raw,
): Section<
  | 'maxPartySize'
  | 'maxQueueLength'
  | 'joinRateLimitPerHour'
  | 'joinCutoffBeforeCloseMin'
  | 'longWaitConfirmMin'
> {
  const at = 'policy';
  return {
    maxPartySize: readNullableNumber(raw, at, 'maxPartySize'),
    maxQueueLength: readNumber(raw, at, 'maxQueueLength'),
    joinRateLimitPerHour: readNumber(raw, at, 'joinRateLimitPerHour'),
    joinCutoffBeforeCloseMin: readNumber(raw, at, 'joinCutoffBeforeCloseMin'),
    longWaitConfirmMin: readNumber(raw, at, 'longWaitConfirmMin'),
  };
}

function readAllocationKeys(
  raw: Raw,
): Section<'fairnessOverrideMin' | 'tableOrder' | 'allowTableSwap' | 'turnoverMin'> {
  const at = 'policy';
  const order: readonly TableOrderKey[] = readManyOf(raw, at, 'tableOrder', TABLE_ORDER_KEYS);
  return {
    fairnessOverrideMin: readNumber(raw, at, 'fairnessOverrideMin'),
    tableOrder: order,
    allowTableSwap: readBoolean(raw, at, 'allowTableSwap'),
    turnoverMin: readNumber(raw, at, 'turnoverMin'),
  };
}

function readHoldKeys(
  raw: Raw,
): Section<
  | 'holdMin'
  | 'holdReminderBeforeMin'
  | 'holdExtensionMin'
  | 'maxExtensions'
  | 'noShowPolicy'
> {
  const at = 'policy';
  const noShow: NoShowPolicy = readOneOf(raw, at, 'noShowPolicy', NO_SHOW_POLICIES);
  return {
    holdMin: readNumber(raw, at, 'holdMin'),
    holdReminderBeforeMin: readNumber(raw, at, 'holdReminderBeforeMin'),
    holdExtensionMin: readNumber(raw, at, 'holdExtensionMin'),
    maxExtensions: readNumber(raw, at, 'maxExtensions'),
    noShowPolicy: noShow,
  };
}

function readPauseKeys(
  raw: Raw,
): Section<'pauseStepMin' | 'pauseMaxTotalMin' | 'ticketMaxAgeMin' | 'abandonTimeoutMin'> {
  const at = 'policy';
  return {
    pauseStepMin: readNumber(raw, at, 'pauseStepMin'),
    pauseMaxTotalMin: readNumber(raw, at, 'pauseMaxTotalMin'),
    ticketMaxAgeMin: readNumber(raw, at, 'ticketMaxAgeMin'),
    abandonTimeoutMin: readNumber(raw, at, 'abandonTimeoutMin'),
  };
}

function readTimeLimitKeys(
  raw: Raw,
): Section<'timeLimitMode' | 'timeLimitMin' | 'limitOnlyWhenWaiting' | 'overstayGraceMin'> {
  const at = 'policy';
  const mode: TimeLimitMode = readOneOf(raw, at, 'timeLimitMode', TIME_LIMIT_MODES);
  return {
    timeLimitMode: mode,
    timeLimitMin: readNumber(raw, at, 'timeLimitMin'),
    limitOnlyWhenWaiting: readBoolean(raw, at, 'limitOnlyWhenWaiting'),
    overstayGraceMin: readNumber(raw, at, 'overstayGraceMin'),
  };
}

function readRecoveryKeys(
  raw: Raw,
): Section<
  | 'stillHerePromptMin'
  | 'stillHereTimeoutMin'
  | 'assignNeedsCheck'
  | 'unknownOccupancyToCheckMin'
  | 'needsCheckAutoFreeMin'
> {
  const at = 'policy';
  return {
    stillHerePromptMin: readNumber(raw, at, 'stillHerePromptMin'),
    stillHereTimeoutMin: readNumber(raw, at, 'stillHereTimeoutMin'),
    assignNeedsCheck: readBoolean(raw, at, 'assignNeedsCheck'),
    unknownOccupancyToCheckMin: readNumber(raw, at, 'unknownOccupancyToCheckMin'),
    needsCheckAutoFreeMin: readNullableNumber(raw, at, 'needsCheckAutoFreeMin'),
  };
}

function readEstimateKeys(raw: Raw): Section<'assumedStayMin' | 'etaBucketMin'> {
  const at = 'policy';
  return {
    assumedStayMin: readNumber(raw, at, 'assumedStayMin'),
    etaBucketMin: readNumber(raw, at, 'etaBucketMin'),
  };
}

/**
 * 既定の運用パラメータ。施設を作るときの初期値（10.3 のプリセット「標準」）。
 *
 * 再輸出しているのは、施設を作る側が `core` と `db` の両方を読まずに済むように
 * するためだけで、値は `core` の宣言そのままである。
 */
export const INITIAL_POLICY: Policy = DEFAULT_POLICY;

// ---- 席 ----

/** 行から `core` の席に戻す。**全項目を並べる**（欄が増えたらここが落ちる）。 */
export function decodeTable(row: TableRow): Table {
  return {
    id: row.id,
    label: row.label,
    capacity: row.capacity,
    tags: decodeTags(row.tags, `tables[${row.id}]`),
    adminRank: row.adminRank,
    enabled: row.enabled,
    status: row.status,
    statusSince: row.statusSince,
    verifiedFreeAt: row.verifiedFreeAt,
    occupantTicketId: row.occupantTicketId,
    disableAfterCurrent: row.disableAfterCurrent,
  };
}

/** 席から行にする。`core` が持たない欄（施設・ゾーン・座席 QR）は呼ぶ側が渡す。 */
export function encodeTable(table: Table, keys: TableKeys): TableRow {
  return {
    id: table.id,
    venueId: keys.venueId,
    zoneId: keys.zoneId,
    token: keys.token,
    label: table.label,
    capacity: table.capacity,
    tags: JSON.stringify(table.tags),
    adminRank: table.adminRank,
    enabled: table.enabled,
    status: table.status,
    statusSince: table.statusSince,
    verifiedFreeAt: table.verifiedFreeAt,
    occupantTicketId: table.occupantTicketId,
    disableAfterCurrent: table.disableAfterCurrent,
  };
}

/** `core` が持たない席の欄。座席トークンはここだけを通る。 */
export interface TableKeys {
  readonly venueId: string;
  readonly zoneId: string | null;
  readonly token: string;
}

// ---- チケット ----

/**
 * チケットの 26 欄を、4 つの束に分けて扱う。
 *
 * **束の切り方は `core` の `sameTicket` と同じにしてある。** 向こうが「同じ
 * チケットか」を見るのに使っている区切りで、こちらは「写し取ったか」を見る。
 * 同じ区切りで並べておけば、片方を読んでいてももう片方を探せる。
 *
 * 束をすべて足すと `Ticket` になる。**欄が 1 つ増えたら、どの束にも入らないので
 * 型エラーになる**（写し忘れが、実行時ではなく編集中に出る）。
 */
type Identity = Pick<Ticket, 'id' | 'code' | 'partySize' | 'requiredTags' | 'state'>;
type Progress = Pick<
  Ticket,
  'priorityAt' | 'createdAt' | 'calledAt' | 'holdDeadline' | 'holdRemindedAt' | 'seatedAt' | 'endedAt' | 'endReason'
>;
type Presence = Pick<
  Ticket,
  | 'pauseDeadline'
  | 'pausedSince'
  | 'pausedTotal'
  | 'lastSeenAt'
  | 'stillHereAskedAt'
  | 'stillHereAnsweredAt'
  | 'timeLimitNoticedAt'
>;
type Counters = Pick<
  Ticket,
  'tableId' | 'extensions' | 'passes' | 'noShows' | 'conflictPriority' | 'hasNotificationChannel'
>;

/** 行から `core` のチケットに戻す。 */
export function decodeTicket(row: TicketRow): Ticket {
  return {
    ...decodeIdentity(row),
    ...decodeProgress(row),
    ...decodePresence(row),
    ...decodeCounters(row),
  };
}

function decodeIdentity(row: TicketRow): Identity {
  return {
    id: row.id,
    code: row.code,
    partySize: row.partySize,
    requiredTags: decodeTags(row.requiredTags, `tickets[${row.id}]`),
    state: row.state,
  };
}

function decodeProgress(row: TicketRow): Progress {
  return {
    priorityAt: row.priorityAt,
    createdAt: row.createdAt,
    calledAt: row.calledAt,
    holdDeadline: row.holdDeadline,
    holdRemindedAt: row.holdRemindedAt,
    seatedAt: row.seatedAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
  };
}

function decodePresence(row: TicketRow): Presence {
  return {
    pauseDeadline: row.pauseDeadline,
    pausedSince: row.pausedSince,
    pausedTotal: row.pausedTotal,
    lastSeenAt: row.lastSeenAt,
    stillHereAskedAt: row.stillHereAskedAt,
    stillHereAnsweredAt: row.stillHereAnsweredAt,
    timeLimitNoticedAt: row.timeLimitNoticedAt,
  };
}

function decodeCounters(row: TicketRow): Counters {
  return {
    tableId: row.tableId,
    extensions: row.extensions,
    passes: row.passes,
    noShows: row.noShows,
    conflictPriority: row.conflictPriority,
    hasNotificationChannel: row.hasNotificationChannel,
  };
}

/** チケットから行にする。端末トークンの**ハッシュ**は呼ぶ側が渡す（生の値は保存しない）。 */
export function encodeTicket(ticket: Ticket, keys: TicketKeys): TicketRow {
  return {
    venueId: keys.venueId,
    clientTokenHash: keys.clientTokenHash,
    secretHash: keys.secretHash,
    ...encodeIdentity(ticket),
    ...encodeProgress(ticket),
    ...encodePresence(ticket),
    ...encodeCounters(ticket),
  };
}

function encodeIdentity(ticket: Ticket): Omit<Identity, 'requiredTags'> & { requiredTags: string } {
  return {
    id: ticket.id,
    code: ticket.code,
    partySize: ticket.partySize,
    requiredTags: JSON.stringify(ticket.requiredTags),
    state: ticket.state,
  };
}

function encodeProgress(ticket: Ticket): Progress {
  return {
    priorityAt: ticket.priorityAt,
    createdAt: ticket.createdAt,
    calledAt: ticket.calledAt,
    holdDeadline: ticket.holdDeadline,
    holdRemindedAt: ticket.holdRemindedAt,
    seatedAt: ticket.seatedAt,
    endedAt: ticket.endedAt,
    endReason: ticket.endReason,
  };
}

function encodePresence(ticket: Ticket): Presence {
  return {
    pauseDeadline: ticket.pauseDeadline,
    pausedSince: ticket.pausedSince,
    pausedTotal: ticket.pausedTotal,
    lastSeenAt: ticket.lastSeenAt,
    stillHereAskedAt: ticket.stillHereAskedAt,
    stillHereAnsweredAt: ticket.stillHereAnsweredAt,
    timeLimitNoticedAt: ticket.timeLimitNoticedAt,
  };
}

function encodeCounters(ticket: Ticket): Counters {
  return {
    tableId: ticket.tableId,
    extensions: ticket.extensions,
    passes: ticket.passes,
    noShows: ticket.noShows,
    conflictPriority: ticket.conflictPriority,
    hasNotificationChannel: ticket.hasNotificationChannel,
  };
}

/**
 * `core` が持たない チケットの欄。
 *
 * **生の秘密はここを通らない。** 端末の匿名トークンも、チケット URL の秘密
 * パラメータも、**ハッシュだけ**が渡る（9.8、CLAUDE.md 7 章）。
 */
export interface TicketKeys {
  readonly venueId: string;
  readonly clientTokenHash: string | null;
  readonly secretHash: string | null;
}

// ---- 施設の状態 ----

/**
 * 3 つの表の行から `VenueState` を組み立てる。
 *
 * **これが「復元」のすべてである。** イベントは読まない（ADR-0013）。
 */
export function decodeVenueState(
  venue: VenueRow,
  tableRows: readonly TableRow[],
  ticketRows: readonly TicketRow[],
): VenueState {
  return {
    venueId: venue.id,
    tables: tableRows.map(decodeTable),
    tickets: ticketRows.map(decodeTicket),
    policy: decodePolicy(venue.policy),
    operating: venue.operating,
    joinOpen: venue.joinOpen,
    closesAt: venue.closesAt,
    clockAt: venue.clockAt,
    nextCodeSeq: venue.nextCodeSeq,
  };
}

/** `VenueState` のうち、施設の行が持つ欄。席とチケットは別の表にある。 */
export type VenueStateColumns = Pick<
  VenueRow,
  'policy' | 'operating' | 'joinOpen' | 'closesAt' | 'clockAt' | 'nextCodeSeq'
>;

/** 施設の行に書き戻す欄を取り出す。 */
export function encodeVenueState(state: VenueState): VenueStateColumns {
  return {
    policy: encodePolicy(state.policy),
    operating: state.operating,
    joinOpen: state.joinOpen,
    closesAt: state.closesAt,
    clockAt: state.clockAt,
    nextCodeSeq: state.nextCodeSeq,
  };
}

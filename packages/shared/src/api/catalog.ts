/**
 * API の一覧。**ここが唯一の出典である。**
 *
 * 開発プラン 9.7 は概略で、行は 9 つしかない。実装はそれを具体的な入口に開いた
 * ものなので、**どの行がどの入口になったかを宣言として持つ**。9.7 に無いものを
 * 足したときは、理由も一緒に書く。突き合わせは `catalog.test.ts` が見ている
 * （`apps/server/db/mapping.ts` と同じやり方）。
 *
 * この表から OpenAPI を組み立てる（[openapi.ts](../openapi.ts)）。**表に足せば
 * 文書にも載る**ので、載せ忘れが起こらない。
 */

import { COMMAND_TYPES, type CommandType } from '@openseat/core';
import type { z } from 'zod';
import type { ApiErrorCode } from './errors.js';
import * as admin from './admin.js';
import * as staff from './staff.js';
import * as tables from './tables.js';
import * as tickets from './tickets.js';
import * as venue from './venue.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** 誰が使う入口か。認証の要否も、役割もここでは決めない（PR 3・PR 12）。 */
export const AUDIENCES = ['user', 'board', 'staff', 'admin'] as const;

export type Audience = (typeof AUDIENCES)[number];

/**
 * 開発プラン 9.7 の表の行。**9 行ある。**
 *
 * Phase 2 のプランは「13 本」と書いているが、9.7 の表は 9 行で、そこから開くと
 * **17 本**になる（下の `ROUTES`）。プラン側を直した。
 */
export const PLAN_ROWS = {
  'user.join': '利用者 | POST /api/v/{venue}/tickets | 受付（人数・タグ・通知手段）',
  'user.ticket': '利用者 | GET /api/t/{ticket}?k= | チケット状態',
  'user.actions': '利用者 | POST /api/t/{ticket}/actions | 本人の操作 10 種',
  'user.table': '利用者 | GET /api/v/{venue}/tables/{token} | 座席 QR ランディング（7.8 の分岐）',
  'user.walkIn': '利用者 | POST /api/v/{venue}/tables/{token}/walk-in | 飛び込み着席',
  'user.status': '利用者 | GET /api/v/{venue}/status | 空き状況・目安',
  'board': 'ボード | GET /api/v/{venue}/board + WS | 呼び出し中一覧',
  'staff': 'スタッフ | POST /api/staff/v/{venue}/... | 手動受付、席の状態変更、キャンセル、モード切替、全席解放',
  'admin': '管理 | GET/PUT /api/admin/v/{venue}/layout、/settings、/print/*.pdf、/reports/* | 設定・印刷・レポート',
} as const;

export type PlanRow = keyof typeof PLAN_ROWS;

export interface RouteSpec {
  /** 短い名前。OpenAPI の `operationId` になる。 */
  readonly id: string;
  readonly method: HttpMethod;
  /** OpenAPI の書き方（`{venue}`）。 */
  readonly path: string;
  readonly summary: string;
  readonly audience: Audience;
  /** 9.7 のどの行から開いたか。 */
  readonly from: PlanRow;
  /** 9.7 に無い入口なら、足した理由。 */
  readonly added?: string;

  readonly params: z.ZodObject | null;
  readonly query: z.ZodObject | null;
  readonly headers: z.ZodObject | null;
  readonly request: z.ZodType | null;
  readonly response: z.ZodType;

  /** 返しうる理由。**`INVALID_REQUEST` と `INTERNAL` はどの入口にもあるので書かない。** */
  readonly errors: readonly ApiErrorCode[];
  /** この入口が出せる `core` のコマンド。**すべてのコマンドに入口があること**を見る。 */
  readonly commands: readonly CommandType[];
}

/** どの入口にもある理由。1 本ずつ書くと、書き漏らしのほうが目立たなくなる。 */
export const UNIVERSAL_ERRORS: readonly ApiErrorCode[] = ['INVALID_REQUEST', 'INTERNAL'];

const NOT_FOUND: readonly ApiErrorCode[] = ['NOT_FOUND'];

/** 本人の操作が返しうる理由。**状態で断られるのが普通である。** */
const TICKET_ERRORS: readonly ApiErrorCode[] = [
  'TICKET_NOT_FOUND',
  'TABLE_NOT_FOUND',
  'NOT_ALLOWED_IN_STATE',
  'BLOCKED_BY_GUARD',
  'STAFF_ONLY',
  'PARTY_TOO_LARGE',
  'PARTY_TOO_SMALL',
  'PARTY_SIZE_INVALID',
  'UNAUTHORIZED',
];

const STAFF_ERRORS: readonly ApiErrorCode[] = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'NOT_ALLOWED_IN_STATE',
  'BLOCKED_BY_GUARD',
];

/** 本人が出せる操作から、そのまま導く。**表に足せばここも増える。** */
const TICKET_COMMANDS: readonly CommandType[] = Object.values(tickets.TICKET_ACTIONS);

export const ROUTES: readonly RouteSpec[] = [
  // ---- 利用者 ----
  {
    id: 'join',
    method: 'POST',
    path: '/api/v/{venue}/tickets',
    summary: '順番待ちに登録する',
    audience: 'user',
    from: 'user.join',
    params: venue.VenuePath,
    query: null,
    headers: tickets.IdempotencyHeader.extend(tickets.ClientTokenHeader.shape),
    request: tickets.JoinRequest,
    response: tickets.JoinResponse,
    errors: [...NOT_FOUND, 'JOIN_CLOSED', 'QUEUE_FULL', 'PARTY_TOO_LARGE', 'PARTY_TOO_SMALL', 'PARTY_SIZE_INVALID', 'RATE_LIMITED', 'NO_CODE_AVAILABLE'],
    commands: ['JOIN'],
  },
  {
    id: 'readTicket',
    method: 'GET',
    path: '/api/t/{ticket}',
    summary: 'チケットの状態を見る',
    audience: 'user',
    from: 'user.ticket',
    params: tickets.TicketPath,
    query: tickets.TicketQuery,
    headers: null,
    request: null,
    response: tickets.TicketResponse,
    errors: ['TICKET_NOT_FOUND', 'UNAUTHORIZED'],
    commands: [],
  },
  {
    id: 'ticketAction',
    method: 'POST',
    path: '/api/t/{ticket}/actions',
    summary: '本人の操作を送る',
    audience: 'user',
    from: 'user.actions',
    params: tickets.TicketPath,
    query: tickets.TicketQuery,
    headers: tickets.IdempotencyHeader,
    request: tickets.TicketActionRequest,
    response: tickets.TicketActionResponse,
    errors: TICKET_ERRORS,
    commands: TICKET_COMMANDS,
  },
  {
    id: 'readTable',
    method: 'GET',
    path: '/api/v/{venue}/tables/{token}',
    summary: '座席 QR を読んだ人に見せるもの',
    audience: 'user',
    from: 'user.table',
    params: tables.TablePath,
    query: tables.TableQuery,
    headers: null,
    request: null,
    response: tables.TableScanResponse,
    errors: [...NOT_FOUND, 'TABLE_NOT_FOUND'],
    commands: [],
  },
  {
    id: 'walkIn',
    method: 'POST',
    path: '/api/v/{venue}/tables/{token}/walk-in',
    summary: '待たずに空席へ座る',
    audience: 'user',
    from: 'user.walkIn',
    params: tables.TablePath,
    query: null,
    headers: tickets.IdempotencyHeader.extend(tickets.ClientTokenHeader.shape),
    request: tables.WalkInRequest,
    response: tables.WalkInResponse,
    errors: [...NOT_FOUND, 'TABLE_NOT_FOUND', 'NOT_ALLOWED_IN_STATE', 'BLOCKED_BY_GUARD', 'PARTY_TOO_LARGE', 'NO_CODE_AVAILABLE'],
    commands: ['WALK_IN'],
  },
  {
    id: 'reportTable',
    method: 'POST',
    path: '/api/v/{venue}/tables/{token}/report',
    summary: 'この席は使用中／空いていた、と伝える',
    audience: 'user',
    from: 'user.table',
    added:
      '9.7 に無い。7.8 の 9 行目と 7.11 の 3 層目は**チケットを持たない人の報告**を前提にしているが、本人の操作（/actions）はチケットが要る。入口が無いと、ゴースト占有を戻す道が塞がる',
    params: tables.TablePath,
    query: null,
    headers: tickets.IdempotencyHeader,
    request: tables.TableReportRequest,
    response: tables.TableReportResponse,
    errors: [...NOT_FOUND, 'TABLE_NOT_FOUND', 'NOT_ALLOWED_IN_STATE', 'BLOCKED_BY_GUARD', 'STAFF_ONLY'],
    commands: Object.values(tables.TABLE_REPORTS),
  },
  {
    id: 'venueStatus',
    method: 'GET',
    path: '/api/v/{venue}/status',
    summary: '登録せずに、いまの混み具合を見る',
    audience: 'user',
    from: 'user.status',
    params: venue.VenuePath,
    query: venue.VenueStatusQuery,
    headers: null,
    request: null,
    response: venue.VenueStatusResponse,
    errors: NOT_FOUND,
    commands: [],
  },

  // ---- ボード ----
  {
    id: 'board',
    method: 'GET',
    path: '/api/v/{venue}/board',
    summary: '呼び出しボードの中身',
    audience: 'board',
    from: 'board',
    params: venue.VenuePath,
    query: null,
    headers: null,
    request: null,
    response: venue.BoardResponse,
    errors: NOT_FOUND,
    commands: [],
  },

  // ---- スタッフ ----
  {
    id: 'console',
    method: 'GET',
    path: '/api/staff/v/{venue}/console',
    summary: '運用コンソールの中身',
    audience: 'staff',
    from: 'staff',
    params: staff.StaffVenuePath,
    query: null,
    headers: null,
    request: null,
    response: staff.ConsoleResponse,
    errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
    commands: [],
  },
  {
    id: 'manualJoin',
    method: 'POST',
    path: '/api/staff/v/{venue}/tickets',
    summary: 'スマホを持たない人を代わりに登録する',
    audience: 'staff',
    from: 'staff',
    params: staff.StaffVenuePath,
    query: null,
    headers: tickets.IdempotencyHeader,
    request: staff.ManualJoinRequest,
    response: staff.ManualJoinResponse,
    errors: [...STAFF_ERRORS, 'JOIN_CLOSED', 'QUEUE_FULL', 'PARTY_TOO_LARGE', 'NO_CODE_AVAILABLE'],
    commands: ['JOIN'],
  },
  {
    id: 'staffTicketAction',
    method: 'POST',
    path: '/api/staff/v/{venue}/tickets/{ticket}/actions',
    summary: 'スタッフが代わりに操作する',
    audience: 'staff',
    from: 'staff',
    params: staff.StaffVenuePath.extend(tickets.TicketPath.shape),
    query: null,
    headers: tickets.IdempotencyHeader,
    request: staff.StaffTicketActionRequest,
    response: staff.StaffTicketActionResponse,
    errors: [...STAFF_ERRORS, 'TICKET_NOT_FOUND', 'TABLE_NOT_FOUND', 'REASON_REQUIRED'],
    commands: Object.values(staff.STAFF_TICKET_ACTIONS),
  },
  {
    id: 'staffTableAction',
    method: 'POST',
    path: '/api/staff/v/{venue}/tables/{label}/actions',
    summary: '席の状態を人の手で動かす',
    audience: 'staff',
    from: 'staff',
    params: staff.StaffVenuePath.extend({ label: admin.TableSetting.shape.label }),
    query: null,
    headers: tickets.IdempotencyHeader,
    request: staff.StaffTableActionRequest,
    response: staff.StaffTableActionResponse,
    errors: [...STAFF_ERRORS, 'TABLE_NOT_FOUND', 'STAFF_ONLY'],
    commands: Object.values(staff.STAFF_TABLE_ACTIONS),
  },
  {
    id: 'operation',
    method: 'POST',
    path: '/api/staff/v/{venue}/operation',
    summary: '運用を開始・終了し、全席を解放する',
    audience: 'staff',
    from: 'staff',
    params: staff.StaffVenuePath,
    query: null,
    headers: tickets.IdempotencyHeader,
    request: staff.OperationRequest,
    response: staff.OperationResponse,
    errors: STAFF_ERRORS,
    commands: Object.values(staff.OPERATION_ACTIONS),
  },

  // ---- 管理 ----
  {
    id: 'readSettings',
    method: 'GET',
    path: '/api/admin/v/{venue}/settings',
    summary: '運用設定を見る',
    audience: 'admin',
    from: 'admin',
    params: admin.AdminVenuePath,
    query: null,
    headers: null,
    request: null,
    response: admin.SettingsResponse,
    errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
    commands: [],
  },
  {
    id: 'updateSettings',
    method: 'PUT',
    path: '/api/admin/v/{venue}/settings',
    summary: '運用設定を公開する',
    audience: 'admin',
    from: 'admin',
    params: admin.AdminVenuePath,
    query: null,
    headers: null,
    request: admin.SettingsUpdateRequest,
    response: admin.SettingsResponse,
    errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
    commands: [],
  },
  {
    id: 'readTables',
    method: 'GET',
    path: '/api/admin/v/{venue}/tables',
    summary: '席の一覧を見る',
    audience: 'admin',
    from: 'admin',
    added:
      '9.7 は `/layout`（フロア図）と書いているが、**フロア図は Phase 3** である。v1 は一覧で編集する（10.2）',
    params: admin.AdminVenuePath,
    query: null,
    headers: null,
    request: null,
    response: admin.TablesResponse,
    errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
    commands: [],
  },
  {
    id: 'updateTables',
    method: 'PUT',
    path: '/api/admin/v/{venue}/tables',
    summary: '席の一覧を差し替える',
    audience: 'admin',
    from: 'admin',
    added:
      '9.7 は `/layout`（フロア図）と書いているが、**フロア図は Phase 3** である。v1 は一覧で編集する（10.2）',
    params: admin.AdminVenuePath,
    query: null,
    headers: null,
    request: admin.TablesUpdateRequest,
    response: admin.TablesResponse,
    errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'BLOCKED_BY_GUARD'],
    commands: [],
  },
];

/**
 * まだ契約を書いていない入口。
 *
 * **中身が決まっていないものに、先回りして形を作らない**（CLAUDE.md 6 章）。
 * どこで入るかだけを書いて、忘れないようにしておく。
 */
export const LATER_ROUTES: readonly {
  readonly path: string;
  readonly from: PlanRow | null;
  readonly when: string;
}[] = [
  { path: 'WS /api/v/{venue}/board', from: 'board', when: 'PR 7（配信。ADR-0014 で方式を決める）' },
  { path: 'WS /api/t/{ticket}', from: 'user.ticket', when: 'PR 7（本人の画面への配信）' },
  { path: 'POST /api/t/{ticket}/notifications', from: 'user.join', when: 'PR 16（通知）。9.7 は受付に含めているが、Web Push の購読は許可を求めたあとにしか取れない' },
  { path: 'GET /api/admin/v/{venue}/print/tables.pdf', from: 'admin', when: 'PR 13（QR 印刷）' },
  { path: 'GET/PUT /api/admin/v/{venue}/layout', from: 'admin', when: 'Phase 3（フロア図）' },
  { path: 'GET /api/admin/v/{venue}/reports/*', from: 'admin', when: 'Phase 3（レポート）' },
  { path: 'POST /api/staff/session', from: null, when: 'PR 12（認証）。9.7 の表には無いが 9.8 が求めている' },
  { path: 'GET /api/admin/v/{venue}/audit', from: null, when: 'PR 12（監査ログの閲覧）' },
];

/** `core` のコマンドのうち、どれかの入口から出せるもの。 */
function reachableCommands(): ReadonlySet<CommandType> {
  return new Set(ROUTES.flatMap((route) => route.commands));
}

/** どの入口からも出せないコマンド。**あってはならない。** */
export function unreachableCommands(): readonly CommandType[] {
  const reachable = reachableCommands();
  return COMMAND_TYPES.filter((command) => !reachable.has(command));
}

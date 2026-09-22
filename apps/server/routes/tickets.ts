/**
 * 利用者の入口（9.7 の 1〜3）。
 *
 * **ハンドラがしてよいのは 5 つだけである**（CLAUDE.md 3.1）。
 *
 * 1. 入力の検証（Zod）
 * 2. 実行者の特定（`identity.ts`）
 * 3. コマンドの組み立て
 * 4. アクターへ委譲（`dispatch` が権限を見る）
 * 5. 結果の整形（`views.ts`・`respond.ts`）
 *
 * **業務判断・整合性の検査・DB への直接書き込みは書かない。** ここに
 * `if (ticket.state === 'CALLED')` が現れたら、それは設計の誤りである。
 */

import { ANONYMOUS, type Command, type Ticket, type VenueState } from '@openseat/core';
import {
  JoinRequest,
  TICKET_ACTIONS,
  TicketActionRequest,
  type JoinResponse,
  type TicketResponse,
} from '@openseat/shared';
import { Hono, type Context } from 'hono';
import type { CommandOutcome } from '../venue/actor.js';
import type { Deps, TicketHandle, VenueHandle } from './deps.js';
import { actorFor, clientTokenOf, keepClientToken } from './identity.js';
import { idempotencyKeyOf, paramOf } from './request.js';
import { problem, rejected } from './respond.js';
import { hashOf } from './secrets.js';
import { ticketView } from './views.js';

export function ticketRoutes(deps: Deps): Hono {
  const app = new Hono();
  app.post('/api/v/:venue/tickets', (c) => handleJoin(deps, c));
  app.get('/api/t/:ticket', (c) => handleRead(deps, c));
  app.post('/api/t/:ticket/actions', (c) => handleAction(deps, c));
  return app;
}

// ---- 受付（7.5） ----

async function handleJoin(deps: Deps, c: Context): Promise<Response> {
  {
    const venue: VenueHandle | null = deps.findVenue(paramOf(c, 'venue'));
    if (venue === null) return problem(c, 'NOT_FOUND', deps.defaultLocale);

    const key: string | null = idempotencyKeyOf(c);
    const input = JoinRequest.safeParse(await body(c));
    if (key === null || !input.success) return problem(c, 'INVALID_REQUEST', venue.locale);

    const token: string = clientTokenOf(c);
    if (!deps.mayJoin(venue.actor.state(), hashOf(token)))
      return problem(c, 'RATE_LIMITED', venue.locale);

    keepClientToken(c, token);
    return respondToJoin(c, deps, venue, await join(deps, venue, input.data, token, key));
  }
}

// ---- 状態（7.3） ----

function handleRead(deps: Deps, c: Context): Response {
  {
    const ticketId: string = paramOf(c, 'ticket');
    const found: TicketHandle | null = deps.findTicket(ticketId);
    if (found === null) return problem(c, 'TICKET_NOT_FOUND', deps.defaultLocale);
    // **「本人ではない」は 1 つの理由にまとめる。** 操作のほうは権限表が
    // `FORBIDDEN` を返すので（ADR-0014）、読み取りだけ別の理由にすると、
    // 呼ぶ側が同じことに 2 通りの分岐を書くことになる。
    if (actorFor(c, ticketId, found.secretHash).role !== 'ticket_owner')
      return problem(c, 'FORBIDDEN', found.locale);

    return c.json(seen(deps, found.actor.state(), ticketId));
  }
}

// ---- 操作（7.7、7.9、7.10） ----

async function handleAction(deps: Deps, c: Context): Promise<Response> {
  {
    const ticketId: string = paramOf(c, 'ticket');
    const found: TicketHandle | null = deps.findTicket(ticketId);
    if (found === null) return problem(c, 'TICKET_NOT_FOUND', deps.defaultLocale);

    const key: string | null = idempotencyKeyOf(c);
    const input = TicketActionRequest.safeParse(await body(c));
    if (key === null || !input.success) return problem(c, 'INVALID_REQUEST', found.locale);

    const command: Command | null = commandOf(deps, found, input.data, ticketId);
    if (command === null) return problem(c, 'TABLE_NOT_FOUND', found.locale);

    const outcome: CommandOutcome = await found.actor.send({
      actor: actorFor(c, ticketId, found.secretHash),
      command,
      key,
      identity: null,
    });
    if (outcome.kind === 'rejected') return rejected(c, outcome.rejection, found.locale);
    return c.json(seen(deps, found.actor.state(), ticketId));
  }
}

/** 受付のコマンドを組み立てて送る。**秘密パラメータはハッシュにしてから渡す。** */
async function join(
  deps: Deps,
  venue: VenueHandle,
  input: JoinRequest,
  token: string,
  key: string,
): Promise<CommandOutcome> {
  const ticketId: string = deps.newId();
  const command: Command = {
    type: 'JOIN',
    ticketId,
    partySize: input.partySize,
    requiredTags: input.requiredTags,
    hasNotificationChannel: false,
  };
  const identity = { ticketId, clientTokenHash: hashOf(token), secretHash: hashOf(input.secret) };
  return venue.actor.send({ actor: ANONYMOUS, command, key, identity });
}

/**
 * 受付の返し。
 *
 * **送り直しには、1 回目に作られたチケットを返す**（ADR-0015）。中身はそのときの
 * 状態から作り直すので、30 秒前の姿ではなく**いまの姿**が返る。
 */
function respondToJoin(
  c: Context,
  deps: Deps,
  venue: VenueHandle,
  outcome: CommandOutcome,
): Response {
  if (outcome.kind === 'rejected') return rejected(c, outcome.rejection, venue.locale);

  const ticketId: string | null =
    outcome.kind === 'replayed' ? outcome.record.ticketId : newestTicketId(outcome.state);
  if (ticketId === null) return problem(c, 'INTERNAL', venue.locale);

  return c.json(seen(deps, venue.actor.state(), ticketId) satisfies JoinResponse);
}

/** いま作られたチケット。**行は書いた順に返る**ので、末尾が新しい（ADR-0013）。 */
function newestTicketId(state: VenueState): string | null {
  return state.tickets.at(-1)?.id ?? null;
}

// ---- 操作 ----

/**
 * 操作の名前を、`core` のコマンドに直す。
 *
 * **1 対 1 の表を引くだけである**（`packages/shared` の `TICKET_ACTIONS`）。
 * どれにするかを考えない。引数の形だけが操作ごとに違う。
 *
 * **席は座席 QR のトークンで指す。** 読み取ったトークンをここで内部 ID に直す
 * （**内部 ID を受け取る入口は作らない**。QR を読まずに他人の席を指せてしまう）。
 * 引けなければ `null` を返し、呼ぶ側が断る。
 */
function commandOf(
  deps: Deps,
  found: TicketHandle,
  input: TicketActionRequest,
  ticketId: string,
): Command | null {
  return atTable(input) ? withTable(deps, found, input, ticketId) : plain(input, ticketId);
}

/** 席を指す操作か。 */
function atTable(input: TicketActionRequest): input is AtTable {
  return 'tableToken' in input;
}

type AtTable = Extract<TicketActionRequest, { readonly tableToken: string }>;

/** 読み取ったトークンを、席の内部 ID に直す。引けなければ `null`。 */
function withTable(
  deps: Deps,
  found: TicketHandle,
  input: AtTable,
  ticketId: string,
): Command | null {
  const tableId: string | null = deps.findTable(found.actor.venueId, input.tableToken);
  return tableId === null ? null : { type: TICKET_ACTIONS[input.action], ticketId, tableId };
}

/** 席を指さない操作。 */
function plain(input: Exclude<TicketActionRequest, AtTable>, ticketId: string): Command {
  switch (input.action) {
    case 'cancel':
      return { type: 'CANCEL', ticketId, by: 'user', reason: input.reason };
    case 'change_party_size':
      return { type: 'CHANGE_PARTY_SIZE', ticketId, partySize: input.partySize };
    case 'check_out':
      return { type: 'CHECK_OUT', ticketId, by: 'user' };
    case 'pause':
    case 'ready':
    case 'extend':
    case 'pass':
    case 'still_here':
    case 'heartbeat':
      return { type: TICKET_ACTIONS[input.action], ticketId };
  }
}

// ---- 返し ----

/** いまの状態から、返す中身を作り直す（ADR-0015）。 */
function seen(deps: Deps, state: VenueState, ticketId: string): TicketResponse {
  const now = deps.clock();
  const ticket: Ticket | undefined = state.tickets.find((item) => item.id === ticketId);
  if (ticket === undefined) throw new Error('適用したはずのチケットが見つかりません');
  return { serverNow: now, ticket: ticketView(state, ticket, now) };
}

/** 本文。**壊れていても投げない** —— 断りは Zod の検証が出す。 */
async function body(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}

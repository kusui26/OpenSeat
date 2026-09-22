/**
 * サーバとの話し方。
 *
 * **契約は `packages/shared` が唯一の出典である**（CLAUDE.md 3.2(5)）。返ってきた
 * ものは、必ずそこで検証してから画面へ渡す —— **形が違えば、描く前に気づきたい。**
 */

import {
  JoinResponse,
  ProblemResponse,
  TicketResponse,
  VenueStatusResponse,
  type JoinRequest,
  type TicketActionRequest,
} from '@openseat/shared';
import { clientToken, newIdempotencyKey } from './device.ts';

/**
 * 返しを確かめるもの。
 *
 * **形だけで受ける。** `packages/shared` の Zod のスキーマがそのまま当てはまるが、
 * ここで `zod` を直に import すると、**画面が契約の実装に縛られる。** 使うのは
 * 「確かめて中身を出す」という 1 つの働きだけである。
 */
interface Checks<T> {
  readonly safeParse: (value: unknown) => { readonly success: true; readonly data: T } | { readonly success: false };
}

/** サーバが断ったこと。**理由は `code` で分岐し、`message` はそのまま出せる。** */
export class ApiError extends Error {
  readonly problem: ProblemResponse;

  constructor(problem: ProblemResponse) {
    super(problem.message);
    this.name = 'ApiError';
    this.problem = problem;
  }
}

async function call<T>(
  path: string,
  schema: Checks<T>,
  init?: { readonly body: unknown },
): Promise<T> {
  const response = await fetch(path, requestOf(init));
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(problemOf(payload));

  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error('サーバの返しが契約と合っていません');
  return parsed.data;
}

function requestOf(init?: { readonly body: unknown }): RequestInit {
  if (init === undefined) return { headers: { accept: 'application/json' } };
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // **送り直しで二度適用しない**（9.4、ADR-0015）。操作のたびに新しく作る。
      'idempotency-key': newIdempotencyKey(),
      'x-openseat-client': clientToken(),
    },
    body: JSON.stringify(init.body),
  };
}

/** 断りの形にならない答え（proxy の障害など）も、同じ形に均しておく。 */
function problemOf(payload: unknown): ProblemResponse {
  const parsed = ProblemResponse.safeParse(payload);
  return parsed.success
    ? parsed.data
    : { code: 'INTERNAL', message: '通信できませんでした。', retryAfterSec: null };
}

// ---- 入口（9.7） ----

export function venueStatus(venue: string, partySize?: number): Promise<VenueStatusResponse> {
  const query: string = partySize === undefined ? '' : `?partySize=${String(partySize)}`;
  return call(`/api/v/${encodeURIComponent(venue)}/status${query}`, VenueStatusResponse);
}

export function join(venue: string, body: JoinRequest): Promise<JoinResponse> {
  return call(`/api/v/${encodeURIComponent(venue)}/tickets`, JoinResponse, { body });
}

export function readTicket(ticketId: string, secret: string): Promise<TicketResponse> {
  return call(ticketPath(ticketId, secret), TicketResponse);
}

export function act(
  ticketId: string,
  secret: string,
  body: TicketActionRequest,
): Promise<TicketResponse> {
  return call(ticketPath(ticketId, secret, '/actions'), TicketResponse, { body });
}

function ticketPath(ticketId: string, secret: string, suffix = ''): string {
  return `/api/t/${encodeURIComponent(ticketId)}${suffix}?k=${encodeURIComponent(secret)}`;
}

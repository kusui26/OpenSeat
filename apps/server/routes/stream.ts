/**
 * 配信の口（開発プラン 9.5、[ADR-0018](../../../docs/adr/0018-server-sent-events.md)）。
 *
 * **開きっぱなしにして、変わるたびに現在の姿を流す。** 流すのは `GET` で取る
 * ときとまったく同じ形なので、画面は同じ描き方を使い回せる（CLAUDE.md 3.1 の
 * 「ビューは状態を描くだけ」）。
 *
 * **ここに業務判断は無い。** 誰が見てよいかは `GET` と同じ手続きで確かめ、
 * 姿の組み立ては [`views.ts`](views.ts) に任せる。
 *
 * ## つないでいるあいだに流れるもの
 *
 * | | いつ | 中身 |
 * |---|---|---|
 * | `ticket` / `venue` | **つないだ直後**と、姿が変わったとき | `GET` と同じ形 |
 * | `ping` | 何も流れない時間が続いたとき | サーバ時刻。**切られないため**と、生きていることの合図 |
 *
 * **前と同じ姿は流さない**（`stream/hub.ts`）。呼び出しが 1 件あるたびに数百台を
 * 起こすと、待っている人の電池が減る。
 */

import {
  STREAM_HEARTBEAT_MS,
  STREAM_PING_MS,
  VenueStatusQuery,
  type StreamEvent,
  type TicketResponse,
  type VenueStatusResponse,
} from '@openseat/shared';
import { Hono, type Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Rendered } from '../stream/hub.js';
import type { Deps, TicketHandle, VenueHandle } from './deps.js';
import { actorFor } from './identity.js';
import { paramOf } from './request.js';
import { problem } from './respond.js';
import { sizeOf, sizesOf } from './venue.js';
import { ticketResponse, venueStatus } from './views.js';

export function streamRoutes(deps: Deps): Hono {
  const app = new Hono();
  app.get('/api/t/:ticket/stream', (c) => ticketStream(deps, c));
  app.get('/api/v/:venue/stream', (c) => venueStream(deps, c));
  return app;
}

/** 流し続けるものの作り方。**姿の組み立てと、生きている合図。** */
interface Feed {
  readonly event: StreamEvent;
  readonly render: () => TicketResponse | VenueStatusResponse | null;
  /** 画面が開いていることを伝える（7.9）。**本人の画面だけが持つ。** */
  readonly beat: (() => void) | null;
}

// ---- 本人の画面（`ticket:{id}`） ----

/**
 * **確かめ方は `GET /api/t/{ticket}` と同じである。**
 *
 * 秘密パラメータが合わなければ匿名として扱われ、ここで断られる（`identity.ts`）。
 */
function ticketStream(deps: Deps, c: Context): Response {
  const ticketId: string = paramOf(c, 'ticket');
  const found: TicketHandle | null = deps.findTicket(ticketId);
  if (found === null) return problem(c, 'TICKET_NOT_FOUND', deps.defaultLocale);

  const who = actorFor(c, ticketId, found.secretHash);
  if (who.role !== 'ticket_owner') return problem(c, 'FORBIDDEN', found.locale);

  return live(deps, c, found, {
    event: 'ticket',
    render: () => ticketResponse(found.actor.state(), ticketId, deps.clock()),
    beat: () => {
      void found.actor.touch(who, ticketId);
    },
  });
}

// ---- ボードと空き状況（`venue:{id}:public`） ----

/**
 * **登録せずに見られる**（`GET /api/v/{venue}/status` と同じ）。
 *
 * スタッフ向けの配信（`venue:{id}:staff`。9.5）はここに無い。**認証が PR 12 で
 * 入るまで、誰がスタッフかを確かめる手段が無い**ためである（ADR-0018）。
 */
function venueStream(deps: Deps, c: Context): Response {
  const venue: VenueHandle | null = deps.findVenue(paramOf(c, 'venue'));
  if (venue === null) return problem(c, 'NOT_FOUND', deps.defaultLocale);

  const wanted = VenueStatusQuery.safeParse({ partySize: sizeOf(c.req.query('partySize')) });
  if (!wanted.success) return problem(c, 'INVALID_REQUEST', venue.locale);

  const sizes: readonly number[] = sizesOf(wanted.data.partySize);
  return live(deps, c, venue, {
    event: 'venue',
    render: () => venueStatus(venue, venue.actor.state(), sizes, deps.clock()),
    beat: null,
  });
}

// ---- 開きっぱなしにする ----

/**
 * 相手が去るまで流し続ける。
 *
 * **1 通目は `watch` が出す**（`stream/hub.ts`）。つないだ相手に必ず現在の姿を
 * 渡すので、切れているあいだの変化は、次につないだ時点の姿がすべて含んでいる。
 */
function live(deps: Deps, c: Context, venue: VenueHandle, feed: Feed): Response {
  return streamSSE(c, async (stream) => {
    const write = (event: StreamEvent, data: string): void => {
      void stream.writeSSE({ event, data, id: String(venue.actor.revision()) });
    };
    const stop = deps.watch(venue.actor.venueId, {
      render: () => serialise(feed.render()),
      send: (payload) => {
        write(feed.event, payload);
      },
    });
    const timers: readonly NodeJS.Timeout[] = beating(feed, () => {
      // **中身を空にしない。** 空の通は配送されない（SSE の仕様）。どうせ何か
      // 入れるなら、画面が時計のずれを直せるものにする（9.4）。
      write('ping', String(deps.clock()));
    });
    feed.beat?.();

    await gone(c, stream);
    stop();
    for (const timer of timers) clearInterval(timer);
  });
}

/** 間を持たせる合図と、生きている合図。 */
function beating(feed: Feed, ping: () => void): readonly NodeJS.Timeout[] {
  const timers: NodeJS.Timeout[] = [setInterval(ping, STREAM_PING_MS)];
  if (feed.beat !== null) timers.push(setInterval(feed.beat, STREAM_HEARTBEAT_MS));
  return timers;
}

/**
 * 相手が去るのを待つ。
 *
 * **2 つの合図を両方見る。** Hono は自分の流れが打ち切られたときに `onAbort` を
 * 出し、`@hono/node-server` は接続が切れたときに要求の合図を落とす。**どちらが
 * 先に来るかは置き場による**ので、片方だけを見ていると、去った相手に向かって
 * 数分ごとに書き続けることになる。
 */
function gone(c: Context, stream: SSEStreamingApi): Promise<void> {
  return new Promise<void>((resolve) => {
    stream.onAbort(resolve);
    c.req.raw.signal.addEventListener('abort', () => {
      resolve();
    }, { once: true });
  });
}

/**
 * 送るものが無ければ `null`。
 *
 * **比べる鍵からサーバ時刻を外す。** どの姿にも `serverNow` が入っているので、
 * そのまま比べると**時計が動いただけで「変わった」ことになる。** そうなると
 * 重複を落とせず、呼び出しが 1 件あるたびに、関係のない数百台まで起きる。
 */
function serialise(value: TicketResponse | VenueStatusResponse | null): Rendered | null {
  if (value === null) return null;
  const { serverNow: _at, ...rest } = value;
  return { payload: JSON.stringify(value), same: JSON.stringify(rest) };
}

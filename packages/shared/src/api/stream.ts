/**
 * 配信の契約（9.5、[ADR-0018](../../../../docs/adr/0018-server-sent-events.md)）。
 *
 * **流すのは「起きたこと」ではなく「いまの姿」である。** サーバが送るのは、
 * 同じものを `GET` で取ったときとまったく同じ形（`TicketResponse` /
 * `VenueStatusResponse`）で、画面はそれを描き替えるだけでよい。
 *
 * ## なぜイベントを流さないのか
 *
 * イベント（`TicketCalled` など）を流すと、**画面がそれを状態に畳み込むことに
 * なる。** それは状態機械を画面に置くことであり、CLAUDE.md 3.1 が禁じている。
 * サーバと画面で畳み込み方がずれた瞬間に、**画面だけが嘘をつく。**
 *
 * ## 取りこぼしが起きない理由
 *
 * **つながるたびに、サーバが現在の姿を必ず先に送る。** 切れているあいだに
 * 何が起きていても、次につながった時点の姿がすべてを含んでいる。だから
 * 「どこから追いつくか」を決める必要がない。
 *
 * ## 古い姿で新しい姿を上書きしないために
 *
 * 退避（ポーリング）と配信が重なると、**先に投げた古い応答があとから届く**
 * ことがある。どちらの形にも `serverNow`（サーバが組み立てた時刻）が入って
 * いるので、**それより古いものは捨てる。** 新しい欄を足す必要はない。
 */

import type { z } from 'zod';
import { TicketResponse } from './tickets.js';
import { VenueStatusResponse } from './venue.js';

/**
 * 配信で使う名前（SSE の `event:`）。
 *
 * ## `ping` について
 *
 * 間に何も流れない時間が続くと、途中の proxy が接続を切る。切られても退避と
 * 再接続で戻るが、**切られないほうが速い。**
 *
 * **中身はサーバ時刻（`serverNow` と同じもの）である。** 2 つ理由がある。
 *
 * - **空にできない。** SSE は `data` が空の通を配送しない（仕様）。
 *   空で送ると、画面の側に何も届かず、**生きていることを確かめられない**
 * - どうせ何か入れるなら、**時計のずれを直せるもの**がよい（9.4）。呼び出しの
 *   残り時間は端末の時計で数えているので、長くつないでいるほどずれが効く
 */
export const STREAM_EVENTS = ['ticket', 'venue', 'ping'] as const;

export type StreamEvent = (typeof STREAM_EVENTS)[number];

/** 本人の画面へ（`ticket:{id}`）。**`GET /api/t/{ticket}` と同じ形。** */
export const TicketStreamMessage = TicketResponse;

export type TicketStreamMessage = z.infer<typeof TicketStreamMessage>;

/** ボードと空き状況へ（`venue:{id}:public`）。**`GET /api/v/{venue}/status` と同じ形。** */
export const VenueStreamMessage = VenueStatusResponse;

export type VenueStreamMessage = z.infer<typeof VenueStreamMessage>;

/**
 * 何も流れない時間の上限。
 *
 * proxy の既定の待ち時間（多くは 60 秒）より短くしておく。**短くしすぎない** ——
 * 息をするだけの通信で、待っている人の電池を削ることになる。
 */
export const STREAM_PING_MS = 20_000;

/**
 * 画面が開いていることを伝える間隔（9.5、7.9 の放置判定）。
 *
 * **接続が開いていること自体が合図である。** 一方向の配信でも、接続は
 * クライアントから張るので、サーバは「まだ見ている」ことを知っている。
 *
 * **`abandonTimeoutMin`（既定 10 分）より十分に短くしておくこと。** 長いと、
 * 画面を開いたまま待っている人が放置とみなされて順番を失う ——
 * **利用者に厳しくしない**（CLAUDE.md 2 の 5）。余裕は `stream.test.ts` が見ている。
 */
export const STREAM_HEARTBEAT_MS = 60_000;

/**
 * 配信が使えないときに取り直す間隔（9.5 の「5 秒ポーリング」）。
 *
 * **配信がつながっているあいだは止める。** 二重に取りに行っても、新しいことは
 * 何も分からない。
 */
export const STREAM_FALLBACK_POLL_MS = 5_000;

/**
 * 切れたあと、つなぎ直すまで待つ時間。
 *
 * **倍にしていく**（9.5）。施設の機械が落ちているときに、数百台が 1 秒ごとに
 * 叩き続けると、**戻ってきた瞬間にまた落ちる。**
 */
export const STREAM_RETRY_MS = { first: 1_000, max: 30_000 } as const;

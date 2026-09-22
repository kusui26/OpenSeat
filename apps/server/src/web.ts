/**
 * 組み上がった画面を配る（開発プラン 9.2）。
 *
 * **成果物は 1 つのコンテナのままにする**（[ADR-0005](../../../docs/adr/0005-single-container-sqlite.md)）。
 * 画面を別のホスティングに置くと、施設が引き取るときに「Docker が動く環境が 1 つ」
 * では済まなくなる。**それは運用費の問題を解く唯一の道を塞ぐ**（14.4）。
 *
 * 同じ入口から配ると、ついでに 2 つ得がある。
 *
 * - **同一オリジンになる。** `connect-src 'self'` で API を呼べる。CORS が要らない
 * - **時計が揃う。** 画面とサーバの時差は、同じ返しの中で測れる（9.10）
 *
 * ## 手元では Vite が配る
 *
 * `pnpm dev` でサーバだけを動かすとき、画面は Vite の開発サーバが配り、`/api` は
 * こちらへ回ってくる（`apps/web/vite.config.ts`）。**画面が組み上がっていない
 * ことは異常ではない**ので、無ければ静かに何も配らない。
 */

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { API_PREFIX } from '../routes/index.js';

/** 名前に中身の指紋が入っているファイルの置き場（Vite が付ける）。 */
const FINGERPRINTED = '/assets/';

/** 指紋つきに付ける期限。**中身が変われば名前が変わる**ので、いくら置いてもよい。 */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * 名前が固定のものに付ける期限。
 *
 * **古い画面を配り続けないこと**が、実証実験でいちばん効く（12.5）。`no-cache` は
 * 「使う前に必ず確かめる」であって「溜めるな」ではないので、変わっていなければ
 * 304 で済む。
 */
const REVALIDATE = 'no-cache';

/** 画面の 1 枚目。起動時に読んで持っておく。 */
interface Page {
  readonly html: string;
  readonly etag: string;
}

/**
 * 画面を配るアプリ。**組み上がっていなければ `null`。**
 *
 * 呼ぶ側（`main.ts`）が `null` を見て、配らないことを決める。
 */
export function webApp(directory: string): Hono | null {
  const page: Page | null = readPage(directory);
  if (page === null) return null;

  const app = new Hono();
  app.use('*', exceptApi(appSecurity()));
  // **画面を求める要求は、ファイルを探すより先に片づける。** `/` も
  // `/v/yokohama` も同じ 1 枚なので、置き場を分けると札（ETag）も分かれる。
  app.use('*', exceptApi(pageFor(page)));
  app.use('*', exceptApi(keepFor(serveStatic({ root: fromCwd(directory) }))));
  return app;
}

/**
 * API には手を出さない。
 *
 * **画面とサーバは同じ入口を使う**（9.2）ので、ここを開けておくと 2 つ壊れる。
 *
 * - API の返しに、画面向けの緩い CSP が上書きされる
 * - **`/api/...` の取りこぼしに、HTML が返る。** 契約では JSON の断りが返るはずの
 *   ところに `<!doctype html>` が来ると、画面は「読めない答え」として扱うしかない
 */
function exceptApi(inner: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => (c.req.path.startsWith(API_PREFIX) ? next() : inner(c, next));
}

/**
 * 画面が読んでよいもの。
 *
 * **API とは別の CSP を張る。** あちらは `default-src 'none'` で済むが、画面は
 * 自分の JavaScript と CSS を読む必要がある。**読ませるのは自分のものだけ**で、
 * 外部の配信網も解析も 1 つも許さない（CLAUDE.md 7 章の「外部送信」）。
 *
 * | 指示 | 何のために開けているか |
 * |---|---|
 * | `script-src 'self'` | 組み上がった 1 本の JavaScript。**inline は 1 つも無い**ので開けない |
 * | `style-src 'self'` | Tailwind が出した 1 枚の CSS。`style=` 属性も使っていない |
 * | `img-src 'self' data:` | アイコン。`data:` は将来の QR 表示（PR 13 の台紙）に要る |
 * | `connect-src 'self'` | 自分の API。**同一オリジンだから、これで足りる** |
 * | `worker-src 'self'` | Service Worker（`sw.js`）。古い画面を配らないための仕掛け |
 * | `manifest-src 'self'` | ホーム画面に追加するための宣言（6.6） |
 *
 * 残りは `default-src 'none'` のまま塞いである。**`form-action 'none'`** は、
 * 画面がフォームを送らない（すべて `fetch`）ので、**送り先を作らせない**ために置く。
 *
 * **`as const` にしない。** Hono は書き換え可能な配列で受け取る。
 */
const APP_CSP: Readonly<Record<string, string[]>> = {
  defaultSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  manifestSrc: ["'self'"],
  workerSrc: ["'self'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
  objectSrc: ["'none'"],
};

/** 画面の返しに付ける守り。 */
function appSecurity(): MiddlewareHandler {
  return secureHeaders({
    // チケット URL の秘密パラメータを、外部のログに残さない（9.8）。
    referrerPolicy: 'no-referrer',
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    crossOriginOpenerPolicy: 'same-origin',
    contentSecurityPolicy: { ...APP_CSP },
  });
}

/**
 * 見つかったファイルに、どれだけ置いてよいかを付ける。
 *
 * **`serveStatic` の `onFound` では付かない。** あちらは返しを組み立て**終えて
 * から**呼ぶので、そこで足したヘッダはどこにも乗らない（`@hono/node-server`
 * 1.19。テストで確かめてある）。
 *
 * **取りこぼしに期限を付けないためにも、後ろから付ける。** 消えた資材の 404 を
 * 1 年間覚え込ませると、戻したときに直らない。`serveStatic` は**見つけたときだけ**
 * 返しを作るので、ここに来た時点で「ある」ことが分かっている。
 */
function keepFor(files: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    // **見つからなかったときは `Response` が返らない。** `serveStatic` は先へ
    // 送る（`next()`）ので、そこで返ってくるのは Hono の文脈であって返しではない。
    const served: unknown = await files(c, next);
    if (!(served instanceof Response)) return undefined;
    const path: string = c.req.path;
    served.headers.set('Cache-Control', path.startsWith(FINGERPRINTED) ? IMMUTABLE : REVALIDATE);
    return served;
  };
}

/**
 * どの道も、同じ 1 枚に落とす（SPA）。
 *
 * `/` も `/v/yokohama` も `/t/abc?k=...` も、同じ画面が受け持つ。**サーバの道
 * ではなく、画面の中の道である**（`apps/web/src/app.tsx`）。
 */
function pageFor(page: Page): MiddlewareHandler {
  return async (c, next) => {
    if (!wantsPage(c)) return next();
    c.header('Cache-Control', REVALIDATE);
    c.header('ETag', page.etag);
    if (c.req.header('if-none-match') === page.etag) return c.body(null, 304);
    if (c.req.method === 'HEAD') return c.body(null, 200, { 'Content-Type': HTML });
    return c.html(page.html);
  };
}

const HTML = 'text/html; charset=utf-8';

/**
 * 画面を求めている要求か。
 *
 * **取りこぼしに HTML を返さない。** 配り直したあと、古い端末が消えた
 * `/assets/index-<古い指紋>.js` を取りに来ることがある。そこに HTML を返すと、
 * ブラウザは JavaScript として読もうとして「予期しない `<`」で止まり、
 * **原因の見当がつかない壊れ方**をする。404 のほうがはるかに親切である。
 *
 * 見分けは `Accept` で足りる。画面の移動は `text/html` を求め、`fetch` や
 * `<script>` は求めない。
 */
function wantsPage(c: Context): boolean {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return false;
  return (c.req.header('accept') ?? '').includes('text/html');
}

/**
 * 1 枚目を読む。**無ければ `null`（画面が組み上がっていないだけ）。**
 *
 * 中身から札（ETag）を作るので、**配り直すまで札は変わらない。** 端末は
 * 毎回確かめに来るが、変わっていなければ 304 で終わる。
 */
function readPage(directory: string): Page | null {
  try {
    const html: string = readFileSync(join(directory, 'index.html'), 'utf8');
    return { html, etag: `"${createHash('sha256').update(html).digest('base64url')}"` };
  } catch {
    return null;
  }
}

/**
 * `serveStatic` は**作業ディレクトリからの相対**しか受け取らない。
 *
 * 設定（`WEB_DIR`）には絶対パスも書けるようにしてあるので、ここで直す。
 */
function fromCwd(directory: string): string {
  return relative(process.cwd(), resolve(process.cwd(), directory));
}

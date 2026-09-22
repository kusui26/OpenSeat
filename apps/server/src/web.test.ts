/**
 * 画面の静的配信（開発プラン 9.2）。
 *
 * **確かめたいのは 3 つ。**
 *
 * 1. **画面と API が同じ入口に載っても、互いを壊さない**（道も CSP も混ざらない）
 * 2. **配り直したときに、古いものが残らない**（名前が固定のものは毎回確かめる）
 * 3. **取りこぼしに HTML を返さない**（原因の見当がつかない壊れ方をさせない）
 */

import { minutes, type Timestamp } from '@openseat/core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, seed, type Harness } from '../db/fixtures.js';
import { openRegistry } from '../venue/registry.js';
import { buildApp, type Health } from './app.js';
import { webApp } from './web.js';

const OPENED: Timestamp = Date.UTC(2027, 2, 6, 2, 0, 0);

/** 組み上がった画面の代わり。**Vite が出す形をまねる。** */
const INDEX = '<!doctype html><html lang="ja"><body><div id="root"></div></body></html>';
const FINGERPRINTED = 'assets/index-Abc123.js';

let box: Harness;
let dist: string;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'openseat-web-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, FINGERPRINTED), 'console.log(1)\n');
  writeFileSync(join(dist, 'sw.js'), 'self.addEventListener("install", () => {})\n');

  box = harness();
  seed(box.db, { capacities: [2, 4], now: OPENED });
  app = buildApp({
    db: box.db,
    registry: openRegistry({ db: box.db, clock: () => OPENED }),
    clock: () => OPENED,
    web: webApp(dist),
    health: () => HEALTHY,
  });
});

afterEach(() => {
  box.dispose();
  rmSync(dist, { recursive: true, force: true });
});

const HEALTHY: Health = { ok: true, venue: 'demo' };

/** ブラウザが画面を開くときの求め方。**ここが分かれ目になる。** */
const AS_BROWSER = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

/** `fetch` や `<script>` の求め方。 */
const AS_FETCH = { accept: '*/*' };

async function get(
  path: string,
  headers: Readonly<Record<string, string>> = AS_BROWSER,
): Promise<Response> {
  return app.request(path, { headers });
}

// ---- 画面を配る ----

describe('組み上がった画面', () => {
  it('1 枚目を返す', async () => {
    const response = await get('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe(INDEX);
  });

  it('画面の中の道も、同じ 1 枚に落とす（SPA）', async () => {
    for (const path of ['/v/yokohama', '/v/yokohama/status', '/t/abc?k=secret']) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(INDEX);
    }
  });

  it('組み上がっていなければ、何も配らない', () => {
    expect(webApp(join(dist, 'ありません'))).toBeNull();
  });
});

// ---- 置いてよい期間 ----

describe('どれだけ端末に置いてよいか', () => {
  it('指紋が名前に入っているものは、いくら置いてもよい', async () => {
    const response = await get(`/${FINGERPRINTED}`, AS_FETCH);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('content-type')).toContain('text/javascript');
  });

  it('名前が固定のものは、使う前に必ず確かめさせる', async () => {
    // **古い Service Worker が残ると、直した画面が誰にも届かない**（12.5）。
    for (const path of ['/sw.js', '/']) {
      expect((await get(path, AS_FETCH)).headers.get('cache-control'), path).toBe('no-cache');
    }
  });

  it('1 枚目が変わっていなければ 304 で済ませる', async () => {
    const first = await get('/');
    const etag: string | null = first.headers.get('etag');
    expect(etag).not.toBeNull();

    const again = await get('/', { ...AS_BROWSER, 'if-none-match': etag ?? '' });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });
});

// ---- 取りこぼし ----

describe('取りこぼしたとき', () => {
  it('消えた資材に HTML を返さない', async () => {
    // 配り直したあと、古い端末が消えた指紋を取りに来る。ここで HTML を返すと
    // 「予期しない `<`」で止まり、**原因の見当がつかない壊れ方**をする。
    const response = await get('/assets/index-Old999.js', AS_FETCH);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it('書き込みに 1 枚目を返さない', async () => {
    const response = await app.request('/v/yokohama', { method: 'POST', headers: AS_BROWSER });
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toBe(INDEX);
  });
});

// ---- 混ざらないこと ----

describe('画面と API が混ざらない', () => {
  it('API の取りこぼしは、HTML ではなく契約どおりの断りで返る', async () => {
    const response = await get('/api/v/ありません/status');
    expect(response.status).toBe(404);
    expect(await response.text()).not.toBe(INDEX);
  });

  it('API はいまも JSON を返す', async () => {
    const response = await get('/api/v/test/status');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('CSP が別である（API は何も許さない。画面は自分のものだけ）', async () => {
    const api: string = (await get('/api/v/test/status')).headers.get('content-security-policy') ?? '';
    const page: string = (await get('/')).headers.get('content-security-policy') ?? '';

    expect(api).toContain("default-src 'none'");
    expect(api).not.toContain('script-src');

    expect(page).toContain("default-src 'none'");
    expect(page).toContain("script-src 'self'");
    expect(page).toContain("connect-src 'self'");
    expect(page).toContain("worker-src 'self'");
    // **外へは出さない**（CLAUDE.md 7 章）。開けてあるのは自分と `data:` だけ。
    expect(page).not.toContain('http');
    expect(page).toContain("frame-ancestors 'none'");
  });

  it('どちらも参照元を送らない（チケット URL の秘密を漏らさない）', async () => {
    for (const path of ['/', '/t/abc?k=secret', '/api/v/test/status']) {
      expect((await get(path)).headers.get('referrer-policy'), path).toBe('no-referrer');
    }
  });
});

// ---- 監視の目を塞がない ----

describe('/healthz', () => {
  it('ブラウザから開いても、画面ではなく健康の答えが返る', async () => {
    // **画面はどの道も 1 枚目に落とす。** 順序を違えると、監視の目が塞がれて
    // いることに誰も気づけない（`app.ts` の「載せる順序」）。
    const response = await get('/healthz');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual(HEALTHY);
  });

  it('答えられないときは 200 を返さない', async () => {
    const ailing = buildApp({
      db: box.db,
      registry: openRegistry({ db: box.db, clock: () => OPENED }),
      clock: () => OPENED + minutes(1),
      web: webApp(dist),
      health: () => ({ ok: false }),
    });
    expect((await ailing.request('/healthz', { headers: AS_BROWSER })).status).toBe(503);
  });
});

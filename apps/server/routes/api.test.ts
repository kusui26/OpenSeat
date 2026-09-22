/**
 * 利用者の API（9.7 の 1〜3・6）。
 *
 * **本物を通す。** 記録はファイル、施設アクターは本物、契約は `packages/shared` の
 * Zod で検証する。**返した形が契約に合っていること**を、毎回そこで確かめる。
 */

import { minutes, type Timestamp } from '@openseat/core';
import {
  JoinResponse,
  ProblemResponse,
  TicketResponse,
  VenueStatusResponse,
} from '@openseat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import { harness, seed, type Harness } from '../db/fixtures.js';
import { userApi } from '../src/api.js';
import { openRegistry } from '../venue/registry.js';
import { CLIENT_HEADER } from './identity.js';
import type { AccessRecord } from './log.js';

const OPENED: Timestamp = Date.UTC(2027, 2, 6, 2, 0, 0);
const at = (min: number): Timestamp => OPENED + minutes(min);

/** 画面が作る値（9.8、ADR-0015）。**サーバは作らない。** */
const DEVICE = 'device-token-0123456789';
const SECRET = 'secret-0123456789abcdef';

let box: Harness;
let db: Db;
let now: Timestamp;
let app: ReturnType<typeof userApi>;
/** 記録に残ったもの。**秘密が混ざっていないことを確かめる。** */
let logged: AccessRecord[];

beforeEach(() => {
  box = harness();
  db = box.db;
  now = OPENED;
  seed(db, { capacities: [2, 4], now: OPENED });
  logged = [];
  app = userApi(
    { db, registry: openRegistry({ db, clock: () => now }), clock: () => now },
    (record) => logged.push(record),
  );
});

afterEach(() => {
  box.dispose();
});

// ---- 呼ぶ ----

let keySeq = 0;

function headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  keySeq += 1;
  return {
    'content-type': 'application/json',
    'idempotency-key': `key-${String(keySeq)}0000000`,
    [CLIENT_HEADER]: DEVICE,
    ...extra,
  };
}

async function post(
  path: string,
  body: unknown,
  extra?: Readonly<Record<string, string>>,
): Promise<Response> {
  return app.request(path, { method: 'POST', headers: headers(extra), body: JSON.stringify(body) });
}

async function get(path: string): Promise<Response> {
  return app.request(path);
}

/** 施設を開ける。**API にスタッフの入口はまだ無い**ので、アクターから直に。 */
async function open(): Promise<void> {
  const registry = openRegistry({ db, clock: () => now });
  const actor = registry.find('test');
  if (actor === null) throw new Error('施設が引けません');
  await actor.send({
    actor: { role: 'staff', ticketId: null, userId: 'u-1' },
    command: { type: 'OPEN', closesAt: at(480), by: 'staff' },
    key: 'open-0000000',
    identity: null,
  });
}

/** 受付して、そのチケットの識別子を返す。 */
async function join(partySize = 2, secret = SECRET): Promise<string> {
  const res = await post('/api/v/test/tickets', { partySize, secret });
  const parsed = JoinResponse.parse(await res.json());
  return parsed.ticket.id;
}

// ---- 受付（7.5） ----

describe('受付', () => {
  it('並ぶと、チケットが返る', async () => {
    await open();
    const res = await post('/api/v/test/tickets', { partySize: 2, secret: SECRET });

    expect(res.status).toBe(200);
    const parsed = JoinResponse.parse(await res.json());
    expect(parsed.ticket.state).toBe('CALLED');
    expect(parsed.ticket.code).toMatch(/^[A-Z]-\d{2}$/);
  });

  /** **秘密パラメータは返さない**（画面が作って送っている。9.8）。 */
  it('返しに秘密パラメータが混ざっていない', async () => {
    await open();
    const res = await post('/api/v/test/tickets', { partySize: 2, secret: SECRET });
    expect(JSON.stringify(await res.json())).not.toContain(SECRET);
  });

  it('運用していなければ断る', async () => {
    const res = await post('/api/v/test/tickets', { partySize: 2, secret: SECRET });
    expect(res.status).toBe(409);
    expect(ProblemResponse.parse(await res.json()).code).toBe('JOIN_CLOSED');
  });

  it('人数が無ければ断る', async () => {
    await open();
    const res = await post('/api/v/test/tickets', { secret: SECRET });
    expect(res.status).toBe(400);
    expect(ProblemResponse.parse(await res.json()).code).toBe('INVALID_REQUEST');
  });

  it('無い施設は 404', async () => {
    const res = await post('/api/v/nope/tickets', { partySize: 2, secret: SECRET });
    expect(res.status).toBe(404);
  });

  /** **送り直しで 2 枚目を作らない**（ADR-0015）。 */
  it('同じ鍵で送り直しても、1 枚しか作られない', async () => {
    await open();
    const sent = { partySize: 2, secret: SECRET };
    const key = { 'idempotency-key': 'same-00000000' };

    const first = JoinResponse.parse(await (await post('/api/v/test/tickets', sent, key)).json());
    const second = JoinResponse.parse(await (await post('/api/v/test/tickets', sent, key)).json());

    expect(second.ticket.id).toBe(first.ticket.id);
  });

  /** 端末あたり 1 時間に 5 回（7.16 の `join_rate_limit_per_hour`）。 */
  it('同じ端末から続けて並ぶと、6 回目で断られる', async () => {
    await open();
    for (let i = 0; i < 5; i += 1) {
      const res = await post('/api/v/test/tickets', { partySize: 1, secret: SECRET });
      expect(res.status).toBe(200);
    }
    const sixth = await post('/api/v/test/tickets', { partySize: 1, secret: SECRET });
    expect(sixth.status).toBe(429);
    expect(ProblemResponse.parse(await sixth.json()).code).toBe('RATE_LIMITED');
  });

  it('端末が違えば、制限は別に数える', async () => {
    await open();
    for (let i = 0; i < 5; i += 1) await post('/api/v/test/tickets', { partySize: 1, secret: SECRET });

    const other = await post('/api/v/test/tickets', { partySize: 1, secret: SECRET }, {
      [CLIENT_HEADER]: 'another-device-0123456789',
    });
    expect(other.status).toBe(200);
  });
});

// ---- 状態（7.3） ----

describe('チケットの状態', () => {
  it('秘密パラメータが合えば読める', async () => {
    await open();
    const id = await join();

    const res = await get(`/api/t/${id}?k=${SECRET}`);
    expect(res.status).toBe(200);
    expect(TicketResponse.parse(await res.json()).ticket.id).toBe(id);
  });

  /** **他人のチケットは覗けない。** 秘密パラメータが本人性のすべてである（9.8）。 */
  it('秘密パラメータが違えば読めない', async () => {
    await open();
    const id = await join();

    const res = await get(`/api/t/${id}?k=wrong-secret-0123456`);
    expect(res.status).toBe(403);
  });

  it('秘密パラメータが無ければ読めない', async () => {
    await open();
    const id = await join();
    expect((await get(`/api/t/${id}`)).status).toBe(403);
  });

  it('無いチケットは 404', async () => {
    expect((await get('/api/t/nope?k=secret-0123456789abcdef')).status).toBe(404);
  });

  it('返しにサーバ時刻が入っている（画面が時計差を知るため）', async () => {
    await open();
    const id = await join();
    now = at(3);

    const parsed = TicketResponse.parse(await (await get(`/api/t/${id}?k=${SECRET}`)).json());
    expect(parsed.serverNow).toBe(at(3));
  });
});

// ---- 操作（7.7、7.9） ----

describe('操作', () => {
  it('取り消せる', async () => {
    await open();
    const id = await join();

    const res = await post(`/api/t/${id}/actions?k=${SECRET}`, { action: 'cancel', reason: 'leaving' });
    expect(res.status).toBe(200);
    expect(TicketResponse.parse(await res.json()).ticket.state).toBe('CANCELLED');
  });

  /** **他人のチケットは動かせない。** 権限表が `FORBIDDEN` で断る（ADR-0014）。 */
  it('秘密パラメータが違えば操作できない', async () => {
    await open();
    const id = await join();

    const res = await post(`/api/t/${id}/actions?k=wrong-secret-0123456`, { action: 'cancel', reason: null });
    expect(res.status).toBe(403);
    expect(ProblemResponse.parse(await res.json()).code).toBe('FORBIDDEN');
  });

  it('いまできない操作は、理由つきで断られる', async () => {
    await open();
    const id = await join();

    // 呼ばれている人は「準備OK」を押せない（保留していない）。
    const res = await post(`/api/t/${id}/actions?k=${SECRET}`, { action: 'ready' });
    expect(res.status).toBe(409);
    expect(ProblemResponse.parse(await res.json()).code).toBe('NOT_ALLOWED_IN_STATE');
  });

  it('知らない操作は断られる', async () => {
    await open();
    const id = await join();

    const res = await post(`/api/t/${id}/actions?k=${SECRET}`, { action: 'explode' });
    expect(res.status).toBe(400);
  });

  it('鍵を付けなければ断られる', async () => {
    await open();
    const id = await join();

    const res = await app.request(`/api/t/${id}/actions?k=${SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', reason: null }),
    });
    expect(res.status).toBe(400);
  });
});

// ---- 空き状況（10.1） ----

describe('空き状況', () => {
  it('登録せずに見られる', async () => {
    await open();
    const res = await get('/api/v/test/status');

    expect(res.status).toBe(200);
    const parsed = VenueStatusResponse.parse(await res.json());
    expect(parsed.venue.operating).toBe(true);
    expect(parsed.managedTables).toBe(2);
    expect(parsed.estimates).toHaveLength(4);
  });

  it('人数を添えると、その 1 行だけが返る', async () => {
    await open();
    const parsed = VenueStatusResponse.parse(await (await get('/api/v/test/status?partySize=4')).json());
    expect(parsed.estimates.map((row) => row.partySize)).toEqual([4]);
  });

  it('どの席が空いているかは出さない', async () => {
    await open();
    const body: string = await (await get('/api/v/test/status')).text();
    expect(body).not.toContain('T-01');
  });
});

// ---- 守り（CLAUDE.md 7 章） ----

describe('どの返しにも付く守り', () => {
  /**
   * **チケットの URL には秘密パラメータが乗っている。** 参照元として外部へ
   * 送られると、相手のログに残る（9.8）。
   */
  it('参照元を送らない', async () => {
    await open();
    const res = await get('/api/v/test/status');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('種別を推測させず、枠にも入れさせない', async () => {
    const res = await get('/api/v/test/status');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  /** 端末の控えは `SameSite=Lax`。**他所のサイトからの書き込みには乗らない。** */
  it('端末の控えを Cookie に置く', async () => {
    await open();
    const res = await post('/api/v/test/tickets', { partySize: 2, secret: SECRET });
    const cookie: string = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('openseat_client=');
    expect(cookie).toContain('SameSite=Lax');
  });
});

// ---- 記録（CLAUDE.md 7 章） ----

describe('記録に秘密が出ていない', () => {
  /**
   * **チケットの秘密パラメータも、端末の匿名トークンも、記録に残さない。**
   * エラーの文脈情報にも入れない（CLAUDE.md 7 章）。
   */
  it('秘密パラメータも端末トークンも、1 文字も出ていない', async () => {
    await open();
    const id = await join();
    await get(`/api/t/${id}?k=${SECRET}`);
    await post(`/api/t/${id}/actions?k=${SECRET}`, { action: 'cancel', reason: null });
    await get(`/api/t/${id}?k=wrong-secret-0123456`);

    const dumped: string = JSON.stringify(logged);
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain(DEVICE);
    expect(dumped).not.toContain('wrong-secret');
  });

  /** **識別子ごと出さない。** 残すのは道の形であって、通った URL ではない。 */
  it('チケットの識別子も出ていない', async () => {
    await open();
    const id = await join();
    await get(`/api/t/${id}?k=${SECRET}`);

    expect(JSON.stringify(logged)).not.toContain(id);
    expect(logged.map((record) => record.route)).toContain('/api/t/:ticket');
  });

  it('それでも、どの入口がどう答えたかは分かる', async () => {
    await open();
    await post('/api/v/test/tickets', { partySize: 2, secret: SECRET });

    expect(logged.at(-1)).toEqual({
      method: 'POST',
      route: '/api/v/:venue/tickets',
      status: 200,
      ms: 0,
    });
  });
});

// ---- よそのサイトから書き込ませない（CSRF） ----

describe('よそからの書き込み', () => {
  /**
   * **端末の控えは Cookie にも置いてある**（9.8）。Cookie は行き先へ自動で付くので、
   * よそのサイトのフォーム 1 つで、身に覚えのない順番待ちを作られかねない。
   */
  it('別のサイトからの受付は断る', async () => {
    await open();
    const res = await post('/api/v/test/tickets', { partySize: 2, secret: SECRET }, {
      origin: 'https://evil.example',
      host: 'openseat.example',
    });
    expect(res.status).toBe(403);
  });

  it('同じサイトからなら通る', async () => {
    await open();
    const res = await post('/api/v/test/tickets', { partySize: 2, secret: SECRET }, {
      origin: 'https://openseat.example',
      host: 'openseat.example',
    });
    expect(res.status).toBe(200);
  });

  /** **読み取りは見ない。** 状態を変えないし、`?k=` を知らなければ何も見えない。 */
  it('読み取りは、よそからでも断らない', async () => {
    await open();
    const res = await app.request('/api/v/test/status', {
      headers: { origin: 'https://evil.example', host: 'openseat.example' },
    });
    expect(res.status).toBe(200);
  });

  /** ブラウザ以外の呼び出しには `Origin` が付かない。**締め出しても守れない。** */
  it('Origin が付いていなければ通す', async () => {
    await open();
    expect((await post('/api/v/test/tickets', { partySize: 2, secret: SECRET })).status).toBe(200);
  });
});

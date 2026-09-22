/**
 * 配信（9.5、[ADR-0018](../../../docs/adr/0018-server-sent-events.md)）。
 *
 * **本物を通す。** 記録はファイル、施設アクターは本物、流れてきた中身は
 * `packages/shared` の Zod で検証する。
 *
 * 確かめたいのは 4 つ。
 *
 * 1. **つないだら、すぐ現在の姿が届く**（取りこぼしが起きない理由そのもの）
 * 2. **変わったら、取りに行かなくても届く**（9.1 の「数秒以内」）
 * 3. **変わっていなければ届かない**（数百台を無駄に起こさない）
 * 4. **見てよい人にしか流れない**（9.8）
 */

import { DEFAULT_POLICY, minutes, type Timestamp } from '@openseat/core';
import {
  JoinResponse,
  STREAM_HEARTBEAT_MS,
  TicketResponse,
  VenueStatusResponse,
} from '@openseat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.js';
import { harness, seatToken, seed, type Harness } from '../db/fixtures.js';
import { openHub, type Hub } from '../stream/hub.js';
import { userApi } from '../src/api.js';
import { openRegistry, type Registry } from '../venue/registry.js';
import { CLIENT_HEADER } from './identity.js';

const OPENED: Timestamp = Date.UTC(2027, 2, 6, 2, 0, 0);

/** 画面が作る値（9.8、ADR-0015）。 */
const DEVICE = 'device-token-0123456789';
const SECRET = 'secret-0123456789abcdef';

let box: Harness;
let db: Db;
let now: Timestamp;
let hub: Hub;
let registry: Registry;
let app: ReturnType<typeof userApi>;
let taps: Tap[];

beforeEach(() => {
  box = harness();
  db = box.db;
  now = OPENED;
  taps = [];
  seed(db, { capacities: [2, 4], now: OPENED });
  hub = openHub();
  registry = openRegistry({
    db,
    clock: () => now,
    onOpen: (opened) => {
      opened.onCommitted(() => {
        hub.wake(opened.venueId);
      });
    },
  });
  app = userApi({ db, registry, clock: () => now, hub });
});

/** どの筋書きも、運用中から始める（7.14）。 */
beforeEach(open);

afterEach(() => {
  for (const tap of taps) tap.close();
  box.dispose();
});

// ---- 配信を覗く ----

interface Frame {
  readonly event: string;
  readonly data: string;
  readonly id: string;
}

interface Tap {
  readonly frames: Frame[];
  /** `count` 通そろうまで待つ。そろわなければ落とす。 */
  readonly until: (count: number) => Promise<void>;
  readonly close: () => void;
}

/**
 * 開きっぱなしの応答を読み続ける。
 *
 * **本物の `Response` の本体を読む。** ブラウザの `EventSource` がしていることを、
 * そのままなぞっている。
 */
async function tap(path: string, headers: Readonly<Record<string, string>> = {}): Promise<Tap> {
  const control = new AbortController();
  const response = await app.request(path, { headers, signal: control.signal });
  if (!response.ok) throw new Error(`つながりません（${String(response.status)}）`);

  const frames: Frame[] = [];
  void read(response, frames);
  const opened: Tap = {
    frames,
    until: (count) => waitFor(() => frames.length >= count, `${String(count)} 通`),
    close: () => {
      control.abort();
    },
  };
  taps.push(opened);
  return opened;
}

async function read(response: Response, into: Frame[]): Promise<void> {
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) return;
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) return;
      rest += decoder.decode(step.value, { stream: true });
      const blocks: string[] = rest.split('\n\n');
      rest = blocks.pop() ?? '';
      for (const block of blocks) into.push(parse(block));
    }
  } catch {
    // 切ったときは読み取りも終わる。**それは異常ではない。**
  }
}

function parse(block: string): Frame {
  const lines: readonly string[] = block.split('\n');
  const field = (name: string): string =>
    lines
      .filter((line) => line.startsWith(`${name}: `))
      .map((line) => line.slice(name.length + 2))
      .join('\n');
  return { event: field('event'), data: field('data'), id: field('id') };
}

/** 条件が成り立つまで待つ。**時計は偽装しているので、実時間で短く回す。** */
async function waitFor(ready: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${what} が届きませんでした`);
}

// ---- 動かす ----

let keySeq = 0;

/** 施設を開ける。**API にスタッフの入口はまだ無い**ので、アクターから直に。 */
async function open(): Promise<void> {
  const actor = registry.find('test');
  if (actor === null) throw new Error('施設が引けません');
  await actor.send({
    actor: { role: 'staff', ticketId: null, userId: 'u-1' },
    command: { type: 'OPEN', closesAt: OPENED + minutes(480), by: 'staff' },
    key: 'open-0000000',
    identity: null,
  });
}

/**
 * 受付する。
 *
 * **席が空いていれば、その場で呼び出される**（7.7）。だからここで返るチケットは
 * `CALLED` から始まる —— テストで送る操作も、その状態から通るものを選ぶこと。
 */
async function join(partySize = 2): Promise<string> {
  keySeq += 1;
  const response = await app.request('/api/v/test/tickets', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `key-${String(keySeq)}0000000`,
      [CLIENT_HEADER]: DEVICE,
    },
    body: JSON.stringify({ partySize, secret: SECRET }),
  });
  const payload: unknown = await response.json();
  const parsed = JoinResponse.safeParse(payload);
  if (!parsed.success) throw new Error(`受付できません: ${JSON.stringify(payload)}`);
  return parsed.data.ticket.id;
}

async function act(ticketId: string, body: Readonly<Record<string, unknown>>): Promise<Response> {
  keySeq += 1;
  return app.request(`/api/t/${ticketId}/actions?k=${SECRET}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `key-${String(keySeq)}0000000`,
      [CLIENT_HEADER]: DEVICE,
    },
    body: JSON.stringify(body),
  });
}

const ticketIn = (frame: Frame): TicketResponse => TicketResponse.parse(JSON.parse(frame.data));

// ---- つないだ直後 ----

describe('つないだとき', () => {
  it('いまの姿が 1 通目として届く（取りに行かなくてよい）', async () => {
    const ticketId: string = await join();
    const seen = await tap(`/api/t/${ticketId}/stream?k=${SECRET}`);
    await seen.until(1);

    const first = seen.frames[0];
    expect(first?.event).toBe('ticket');
    expect(ticketIn(first!).ticket.id).toBe(ticketId);
  });

  it('施設の姿も、つないだ直後に届く', async () => {
    const seen = await tap('/api/v/test/stream');
    await seen.until(1);
    const first = seen.frames[0];
    expect(first?.event).toBe('venue');
    expect(VenueStatusResponse.parse(JSON.parse(first!.data)).managedTables).toBe(2);
  });

  it('切れているあいだに変わっても、つなぎ直せば現在の姿が届く', async () => {
    // **これが「追いつき」の代わりである。** どこから追うかを決める必要がない。
    const ticketId: string = await join();
    const before = await tap(`/api/t/${ticketId}/stream?k=${SECRET}`);
    await before.until(1);
    before.close();

    await act(ticketId, { action: 'pass' });

    const after = await tap(`/api/t/${ticketId}/stream?k=${SECRET}`);
    await after.until(1);
    expect(ticketIn(after.frames[0]!).ticket.state).toBe('PAUSED');
  });
});

// ---- 変わったとき ----

describe('姿が変わったとき', () => {
  it('取りに行かなくても届く（9.1 の「数秒以内」）', async () => {
    const ticketId: string = await join();
    const seen = await tap(`/api/t/${ticketId}/stream?k=${SECRET}`);
    await seen.until(1);

    await act(ticketId, { action: 'pass' });
    await seen.until(2);
    expect(ticketIn(seen.frames[1]!).ticket.state).toBe('PAUSED');
  });

  it('呼び出しから画面の更新まで 3 秒以内（9.1）', async () => {
    // **9.1 の「数秒以内」を、検査できる数字にしたもの。** ここで測るのは
    // サーバの中だけだが、**取りに行く往復が挟まらない**ことは確かめられる。
    const ticketId: string = await join();
    const seen = await tap(`/api/t/${ticketId}/stream?k=${SECRET}`);
    await seen.until(1);

    const from: number = Date.now();
    await act(ticketId, { action: 'pass' });
    await seen.until(2);
    expect(Date.now() - from).toBeLessThan(3_000);
  });

  it('待っている人にも、施設の様子の変化が届く', async () => {
    const watching: string = await join(4);
    const seen = await tap(`/api/v/test/stream`);
    await seen.until(1);

    await act(watching, { action: 'cancel' });
    await seen.until(2);
    const after = VenueStatusResponse.parse(JSON.parse(seen.frames[1]!.data));
    expect(after.waiting).toBe(0);
  });

  it('変わっていなければ、同じものを送らない', async () => {
    const ticketId: string = await join();
    const seen = await tap(`/api/t/${ticketId}/stream?k=${SECRET}`);
    await seen.until(1);

    // **通らない操作は状態を変えない。** 断られたことは配信に現れない
    //（「準備OK」は保留中の人のもので、呼ばれている人は押せない）。
    const refused = await act(ticketId, { action: 'ready' });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.frames).toHaveLength(1);
  });

  it('自分の姿が変わっていなければ、ほかの人の出入りで起こされない', async () => {
    // **これがいちばん効く場面である。** 1 人が呼ばれたとき、座っている数百人の
    // 姿は何も変わらない。そこへ送ると、待ってもいない人の電池を削る。
    const seatedId: string = await join();
    expect((await act(seatedId, { action: 'check_in', tableToken: seatToken(1) })).status).toBe(200);

    const seen = await tap(`/api/t/${seatedId}/stream?k=${SECRET}`);
    await seen.until(1);
    expect(ticketIn(seen.frames[0]!).ticket.state).toBe('SEATED');

    // **時計を進める。** サーバ時刻だけが違う姿を「変わった」と見なしていたら、
    // ここで送られてしまう。
    now = OPENED + minutes(3);
    const other: string = await join();
    await act(other, { action: 'cancel' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.frames).toHaveLength(1);
  });

  it('版が進む（古い姿で新しい姿を上書きさせないため）', async () => {
    const ticketId: string = await join();
    const seen = await tap(`/api/t/${ticketId}/stream?k=${SECRET}`);
    await seen.until(1);
    await act(ticketId, { action: 'pass' });
    await seen.until(2);

    expect(Number(seen.frames[1]?.id)).toBeGreaterThan(Number(seen.frames[0]?.id));
  });
});

// ---- 見てよい人だけ ----

describe('誰に流すか', () => {
  it('秘密が合わなければ、つながらない', async () => {
    const ticketId: string = await join();
    const response = await app.request(`/api/t/${ticketId}/stream?k=wrong-secret-000000`);
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('秘密を添えなければ、つながらない', async () => {
    const ticketId: string = await join();
    expect((await app.request(`/api/t/${ticketId}/stream`)).status).toBe(403);
  });

  it('無い施設には、つながらない', async () => {
    expect((await app.request('/api/v/ありません/stream')).status).toBe(404);
  });

  it('流れてくる中身に、秘密が混ざらない', async () => {
    const ticketId: string = await join();
    const seen = await tap(`/api/t/${ticketId}/stream?k=${SECRET}`);
    await seen.until(1);
    expect(seen.frames[0]?.data).not.toContain(SECRET);
    expect(seen.frames[0]?.data).not.toContain(DEVICE);
  });
});

// ---- 去ったとき ----

describe('相手が去ったとき', () => {
  it('見ている人の数が戻る（去った相手に書き続けない）', async () => {
    const seen = await tap('/api/v/test/stream');
    await seen.until(1);
    expect(hub.watching()).toBe(1);

    seen.close();
    await waitFor(() => hub.watching() === 0, '接続の後始末');
  });
});

// ---- 生きている合図 ----

describe('放置とみなされないこと（7.9）', () => {
  it('心拍の間隔が、放置とみなすまでの時間より十分に短い', () => {
    // **画面を開いたまま待っている人が、順番を失ってはならない**
    // （CLAUDE.md 2 の 5「利用者に厳しくしない」）。
    const abandon: number = minutes(DEFAULT_POLICY.abandonTimeoutMin);
    expect(STREAM_HEARTBEAT_MS * 3).toBeLessThanOrEqual(abandon);
  });

  it('つないだ時点で、見ていることが伝わる', async () => {
    const ticketId: string = await join();
    now = OPENED + minutes(5);
    const seen = await tap(`/api/t/${ticketId}/stream?k=${SECRET}`);
    await seen.until(1);

    await waitFor(() => lastSeen(ticketId) === now, '心拍');
  });
});

function lastSeen(ticketId: string): Timestamp | null {
  const state = registry.find('test')?.state();
  return state?.tickets.find((ticket) => ticket.id === ticketId)?.lastSeenAt ?? null;
}

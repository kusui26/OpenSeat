import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Timestamp, VenueState } from '@openseat/core';
import { createTable, createVenueState, DEFAULT_POLICY, minutes } from '@openseat/core';
import { Hub } from './hub.js';
import { createApp } from './routes.js';
import { Store } from './store.js';
import { Venue } from './venue.js';

/**
 * 1 日スパイクの通し確認（開発プラン 9.13）。
 *
 * **製品のテストではない。** 確かめるのは「Hono と SQLite と `packages/core` を
 * 繋いだものが、受付から退席まで通り、落ちても取り戻せる」ことだけである。
 * ドメインの正しさは `packages/core` の 1,613 本が見ている。
 */

const START: Timestamp = 1_700_000_000_000;

function emptyVenue(now: Timestamp): VenueState {
  return createVenueState({
    venueId: 'test',
    policy: DEFAULT_POLICY,
    tables: [
      createTable({ id: 'a1', label: 'A-1', capacity: 2, now }),
      createTable({ id: 'b1', label: 'B-1', capacity: 4, now }),
    ],
  });
}

/** 記録を置く一時ディレクトリ。再起動を試すのでファイルが要る。 */
let directory = '';

function open(): { readonly store: Store; readonly venue: Venue } {
  const store = new Store(join(directory, 'spike.db'));
  const venue: Venue = Venue.restore(store, emptyVenue(START));
  return { store, venue };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'openseat-spike-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('受付から退席まで通る', () => {
  it('並んだ組に席が割り当てられ、着席して退席できる', () => {
    const { store, venue } = open();
    expect(venue.dispatch({ type: 'OPEN', closesAt: null, by: 'staff' }, START).ok).toBe(true);

    const joined = venue.dispatch(
      { type: 'JOIN', ticketId: 'k1', partySize: 2, requiredTags: [], hasNotificationChannel: true },
      START + minutes(1),
    );
    expect(joined.ok).toBe(true);

    // 受付のうちに割当まで走る（`apply` の出口で `settle` が動く。PR 6）。
    const ticket = venue.state.tickets.find((item) => item.id === 'k1');
    expect(ticket?.state).toBe('CALLED');
    // 2 名なので、ロス最小で 2 名席が選ばれる（7.6）。
    expect(ticket?.tableId).toBe('a1');

    expect(
      venue.dispatch({ type: 'CHECK_IN', ticketId: 'k1', tableId: 'a1' }, START + minutes(2)).ok,
    ).toBe(true);
    expect(venue.state.tables.find((item) => item.id === 'a1')?.status).toBe('OCCUPIED');

    expect(
      venue.dispatch({ type: 'CHECK_OUT', ticketId: 'k1', by: 'user' }, START + minutes(30)).ok,
    ).toBe(true);
    expect(venue.state.tables.find((item) => item.id === 'a1')?.status).toBe('FREE');
    store.close();
  });

  /** 拒否は `core` の言葉でそのまま返る。境界が言い換えない。 */
  it('通らないコマンドは、理由つきで断られる', () => {
    const { store, venue } = open();
    const rejected = venue.dispatch({ type: 'CHECK_OUT', ticketId: 'いない', by: 'user' }, START);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code.length).toBeGreaterThan(0);
    store.close();
  });
});

describe('落ちても取り戻せる', () => {
  /**
   * **これがスパイクのいちばん大事な確認である。**
   *
   * `apply` と `tick` は純粋関数なので、同じ入力を同じ順に流せば同じ状態が出る
   * （ADR-0004）。記録に残すのは入力だけで、新しい形式を 1 つも決めていない。
   * 本物のイベントログとスナップショットは Phase 2 で決める。
   */
  it('入力を流し直すと、まったく同じ状態に戻る', () => {
    const first = open();
    first.venue.dispatch({ type: 'OPEN', closesAt: null, by: 'staff' }, START);
    first.venue.dispatch(
      { type: 'JOIN', ticketId: 'k1', partySize: 4, requiredTags: [], hasNotificationChannel: true },
      START + minutes(1),
    );
    first.venue.dispatch({ type: 'CHECK_IN', ticketId: 'k1', tableId: 'b1' }, START + minutes(2));
    const before: VenueState = first.venue.state;
    first.store.close();

    const again = open();
    expect(again.venue.state).toEqual(before);
    again.store.close();
  });

  it('何も起きなかった刻みは記録しない（記録を小さく保つ）', () => {
    const { store, venue } = open();
    venue.dispatch({ type: 'OPEN', closesAt: null, by: 'staff' }, START);
    const before: number = store.size;
    for (let step = 1; step <= 10; step += 1) venue.advance(START + step * 1000);
    expect(store.size).toBe(before);
    store.close();
  });

  it('期限で状態が動いた刻みは記録し、流し直しでも再現する', () => {
    const first = open();
    first.venue.dispatch({ type: 'OPEN', closesAt: null, by: 'staff' }, START);
    first.venue.dispatch(
      { type: 'JOIN', ticketId: 'k1', partySize: 2, requiredTags: [], hasNotificationChannel: true },
      START + minutes(1),
    );
    // ホールドの期限（受付の 7 分後 ＝ +8 分）だけを過ぎるまで進める。
    // 誰も来ないので保留になる（保留の期限 +18 分はまだ来ていない）。
    const late: Timestamp = START + minutes(10);
    expect(first.venue.advance(late).length).toBeGreaterThan(0);
    const before: VenueState = first.venue.state;
    expect(before.tickets.find((item) => item.id === 'k1')?.state).toBe('PAUSED');
    first.store.close();

    const again = open();
    expect(again.venue.state).toEqual(before);
    again.store.close();
  });
});

describe('HTTP の入口', () => {
  function app(): ReturnType<typeof createApp> {
    const { store, venue } = open();
    venue.dispatch({ type: 'OPEN', closesAt: null, by: 'staff' }, START);
    let issued = 0;
    return createApp({
      venue,
      store,
      hub: new Hub(),
      now: () => START + minutes(1),
      newId: () => `k${String((issued += 1))}`,
      startedAt: START,
      version: 'test',
    });
  }

  it('生きているかを答える', async () => {
    const response = await app().request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('画面を返し、それがスパイクだと断っている', async () => {
    const html: string = await (await app().request('/')).text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('1 日スパイク');
    expect(html).toContain('製品の画面ではありません');
  });

  it('受付できる', async () => {
    const response = await app().request('/join', {
      method: 'POST',
      body: new URLSearchParams({ partySize: '2' }),
    });
    expect(response.status).toBe(303);
  });

  /** **打ち間違いを受け流さない。** 既定値で動いたものを結果だと思い込ませない。 */
  it('人数が範囲の外なら断る', async () => {
    for (const partySize of ['0', '7', 'たくさん', '']) {
      const response = await app().request('/join', {
        method: 'POST',
        body: new URLSearchParams({ partySize }),
      });
      expect(response.status, partySize).toBe(400);
    }
  });

  it('通らないコマンドは 409 と理由を返す', async () => {
    const response = await app().request('/tickets/いない/check-out', { method: 'POST' });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('NOT_FOUND');
  });
});

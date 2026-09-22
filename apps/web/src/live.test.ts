/**
 * つなぎ続ける仕組み（9.5 の階段、[ADR-0018](../../../docs/adr/0018-server-sent-events.md)）。
 *
 * **React を通さずに試す。** つなぎ直しも見張りも画面の都合とは関係が無いので、
 * 偽の接続を渡して、時計を偽装して確かめる。
 *
 * 確かめたいのは 4 つ。
 *
 * 1. **届いたものが、そのまま渡る**
 * 2. **切れたら、時間を倍にしながらつなぎ直す**（戻ってきた瞬間に落とさない）
 * 3. **黙り込んだら切れたとみなす**（携帯回線では、切れたと知らされないことがある）
 * 4. **やめたら、もう何もしない**
 */

import { STREAM_PING_MS, STREAM_RETRY_MS } from '@openseat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, type Socket } from './live.ts';

/** 偽の接続。**開いた回数と、閉じたかどうかを覚えている。** */
class FakeSocket implements Socket {
  closed = false;
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  /** サーバから 1 通届いたことにする。 */
  fire(type: string, data = ''): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data }));
  }
}

let opened: FakeSocket[];
let heard: string[];
let live: boolean[];
let stop: () => void;

function start(url = '/api/t/tk_1/stream?k=s'): void {
  stop = connect({
    url,
    event: 'ticket',
    open: () => {
      const socket = new FakeSocket();
      opened.push(socket);
      return socket;
    },
    onMessage: (data) => heard.push(data),
    onLive: (now) => live.push(now),
  });
}

const last = (): FakeSocket => {
  const socket = opened.at(-1);
  if (socket === undefined) throw new Error('まだつないでいません');
  return socket;
};

beforeEach(() => {
  vi.useFakeTimers();
  opened = [];
  heard = [];
  live = [];
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

// ---- 届く ----

describe('届いたもの', () => {
  it('そのまま渡る', () => {
    start();
    last().fire('ticket', '{"serverNow":1}');
    expect(heard).toEqual(['{"serverNow":1}']);
  });

  it('1 通目が届いた時点で、つながっているとみなす', () => {
    // `open` を待たない。**順序は置き場によって前後する。**
    start();
    last().fire('ticket', '{}');
    expect(live.at(-1)).toBe(true);
  });

  it('`ping` は渡さない（中身が無い）', () => {
    start();
    last().fire('ping', '1772000000000');
    expect(heard).toEqual([]);
    expect(live.at(-1)).toBe(true);
  });
});

describe('配信を持たない環境（9.5 の退避）', () => {
  it('つながらないままにしておく（落ちない）', () => {
    // `EventSource` を持たないブラウザや、描き出しの途中。**ここで落ちると、
    // 画面そのものが出ない。** つながらなければ、画面が 5 秒ごとに取りに行く。
    const quiet: boolean[] = [];
    const stopHere = connect({
      url: '/api/probe/stream',
      event: 'ticket',
      onMessage: () => {
        throw new Error('届くはずがない');
      },
      onLive: (now) => quiet.push(now),
    });

    expect(quiet).toEqual([]);
    vi.advanceTimersByTime(STREAM_RETRY_MS.max * 2);
    stopHere();
  });
});

// ---- つなぎ直す ----

describe('切れたとき', () => {
  it('時間を倍にしながらつなぎ直す', () => {
    start();
    expect(opened).toHaveLength(1);

    last().fire('error');
    expect(live.at(-1)).toBe(false);

    vi.advanceTimersByTime(STREAM_RETRY_MS.first);
    expect(opened).toHaveLength(2);

    // **2 回目は倍待つ。** 1 回目と同じ時間では、まだつなぎ直さない。
    last().fire('error');
    vi.advanceTimersByTime(STREAM_RETRY_MS.first);
    expect(opened).toHaveLength(2);
    vi.advanceTimersByTime(STREAM_RETRY_MS.first);
    expect(opened).toHaveLength(3);
  });

  it('待つ時間に上限がある（延々と伸びない）', () => {
    start();
    for (let tries = 0; tries < 12; tries += 1) {
      last().fire('error');
      vi.advanceTimersByTime(STREAM_RETRY_MS.max);
    }
    const before: number = opened.length;
    last().fire('error');
    vi.advanceTimersByTime(STREAM_RETRY_MS.max);
    expect(opened.length).toBe(before + 1);
  });

  it('つながり直したら、待ち時間が元に戻る', () => {
    start();
    last().fire('error');
    vi.advanceTimersByTime(STREAM_RETRY_MS.first);
    last().fire('open');

    last().fire('error');
    vi.advanceTimersByTime(STREAM_RETRY_MS.first);
    expect(opened).toHaveLength(3);
  });

  it('前の接続を閉じてからつなぎ直す', () => {
    start();
    const first: FakeSocket = last();
    first.fire('error');
    vi.advanceTimersByTime(STREAM_RETRY_MS.first);
    expect(first.closed).toBe(true);
  });
});

// ---- 黙り込んだとき ----

describe('黙り込んだとき', () => {
  it('切れたとみなしてつなぎ直す（切れたと知らされないことがある）', () => {
    start();
    last().fire('ticket', '{}');
    expect(live.at(-1)).toBe(true);

    vi.advanceTimersByTime(STREAM_PING_MS * 2);
    expect(live.at(-1)).toBe(false);

    vi.advanceTimersByTime(STREAM_RETRY_MS.first);
    expect(opened).toHaveLength(2);
  });

  it('`ping` が届いているあいだは、切れたとみなさない', () => {
    start();
    for (let beats = 0; beats < 5; beats += 1) {
      vi.advanceTimersByTime(STREAM_PING_MS);
      last().fire('ping', '1');
    }
    expect(live.at(-1)).toBe(true);
    expect(opened).toHaveLength(1);
  });
});

// ---- やめたとき ----

describe('やめたとき', () => {
  it('閉じて、もうつなぎ直さない', () => {
    start();
    const socket: FakeSocket = last();
    stop();

    expect(socket.closed).toBe(true);
    vi.advanceTimersByTime(STREAM_RETRY_MS.max * 2);
    expect(opened).toHaveLength(1);
  });

  it('やめたあとに切れても、何も起こさない', () => {
    // **閉じる瞬間に切断が届くことがある。** そこで知らせを出すと、もう居ない
    // 画面に向かって状態を変えにいくことになる（React の警告になる）。
    start();
    const socket: FakeSocket = last();
    stop();
    const quiet: number = live.length;

    socket.fire('error');
    expect(live).toHaveLength(quiet);

    vi.advanceTimersByTime(STREAM_RETRY_MS.max * 2);
    expect(opened).toHaveLength(1);
  });
});

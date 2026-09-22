// @vitest-environment happy-dom
/**
 * 配信で届いたものを、画面の手元に差し替える（9.5、[ADR-0018](../../../docs/adr/0018-server-sent-events.md)）。
 *
 * 確かめたいのは 3 つ。
 *
 * 1. **届いたら、取りに行かずに描き替わる**（9.1 の「数秒以内」）
 * 2. **古い姿で新しい姿を上書きしない**（退避と配信は重なる）
 * 3. **契約に合わないものは描かない**
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from './live.ts';
import { LIVE_QUERY, useLive } from './use-live.ts';

/** 試すための、いちばん小さな形。 */
interface Shown {
  readonly serverNow: number;
  readonly label: string;
}

/** 契約の代わり。**`safeParse` という 1 つの働きしか使っていない。** */
const CHECKS = {
  safeParse: (value: unknown): { success: true; data: Shown } | { success: false } => {
    if (typeof value !== 'object' || value === null) return { success: false };
    const held: Record<string, unknown> = { ...value };
    if (typeof held['serverNow'] !== 'number' || typeof held['label'] !== 'string') {
      return { success: false };
    }
    return { success: true, data: { serverNow: held['serverNow'], label: held['label'] } };
  },
};

class FakeSocket implements Socket {
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.listeners.clear();
  }

  fire(data: string): void {
    this.listeners.get('shown')?.(new MessageEvent('shown', { data }));
  }
}

const KEY: readonly unknown[] = ['probe'];

let socket: FakeSocket;
/** 張られた接続の数。**描き直しのたびに増えてはいけない。** */
let connections: number;

/** **描くたびに作り直さない**（`useLive` の約束）。ここで作り直すと、測れない。 */
function openSocket(): FakeSocket {
  connections += 1;
  return socket;
}
/** 取りに行った回数。**つながっているあいだは増えないはず。** */
let fetched: number;

function Probe({ url }: { readonly url: string | null }): React.JSX.Element {
  const live: boolean = useLive({
    url,
    event: 'shown',
    // **どちらも、描くたびに作り直される。** 繋ぎ直しの理由にしてはいけない。
    checks: CHECKS,
    queryKey: [...KEY],
    open: openSocket,
  });
  const shown = useQuery({
    ...LIVE_QUERY,
    queryKey: KEY,
    queryFn: (): Shown => {
      fetched += 1;
      return { serverNow: 100, label: '取りに行った' };
    },
    refetchInterval: live ? false : 20,
  });
  return (
    <p>
      {live ? 'つながっている' : 'つながっていない'} / {shown.data?.label ?? '…'}
    </p>
  );
}

function show(url: string | null = '/api/probe/stream'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Probe url={url} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  socket = new FakeSocket();
  fetched = 0;
  connections = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('届いたとき', () => {
  it('取りに行かずに描き替わる', async () => {
    show();
    await screen.findByText(/取りに行った/);

    socket.fire('{"serverNow":200,"label":"届いた"}');
    await screen.findByText(/届いた/);
  });

  it('つながったと分かる', async () => {
    show();
    socket.fire('{"serverNow":200,"label":"届いた"}');
    await screen.findByText(/つながっている/);
  });
});

describe('繋ぎ直し', () => {
  it('描き直しても、接続は 1 本のまま', async () => {
    // **届いた 1 通が描き直しを起こし、それがまた繋ぎ直しを起こす**、という輪に
    // なりやすい。実際になっていた —— 1 つの筋書きで 127 本張られていた（PR 8）。
    show();
    await screen.findByText(/取りに行った/);

    for (const at of [200, 300, 400, 500]) {
      socket.fire(`{"serverNow":${String(at)},"label":"${String(at)}"}`);
      await screen.findByText(new RegExp(String(at)));
    }
    expect(connections).toBe(1);
  });
});

describe('古い姿で上書きしないこと', () => {
  it('前より古い時刻のものは捨てる', async () => {
    // **退避と配信は重なる。** 先に投げた古い応答が、あとから届くことがある。
    show();
    socket.fire('{"serverNow":300,"label":"新しい"}');
    await screen.findByText(/新しい/);

    socket.fire('{"serverNow":200,"label":"古い"}');
    await new Promise((resolve) => setTimeout(resolve, 30));
    screen.getByText(/新しい/);
  });

  it('同じ時刻なら、あとから来たほうを採る', async () => {
    show();
    socket.fire('{"serverNow":300,"label":"さいしょ"}');
    await screen.findByText(/さいしょ/);
    socket.fire('{"serverNow":300,"label":"あとから"}');
    await screen.findByText(/あとから/);
  });
});

describe('描く前に確かめること', () => {
  it('契約に合わないものは描かない', async () => {
    show();
    await screen.findByText(/取りに行った/);

    socket.fire('{"serverNow":"文字列","label":123}');
    await new Promise((resolve) => setTimeout(resolve, 30));
    screen.getByText(/取りに行った/);
  });

  it('読めない中身でも落ちない', async () => {
    show();
    await screen.findByText(/取りに行った/);
    socket.fire('これは JSON ではない');
    await new Promise((resolve) => setTimeout(resolve, 30));
    screen.getByText(/取りに行った/);
  });
});

describe('退避（9.5）', () => {
  it('つながっていないあいだは、取りに行き続ける', async () => {
    show(null);
    await screen.findByText(/つながっていない/);
    await waitFor(() => {
      expect(fetched).toBeGreaterThan(1);
    });
  });

  it('つながったら、取りに行くのをやめる', async () => {
    show();
    socket.fire('{"serverNow":200,"label":"届いた"}');
    await screen.findByText(/つながっている/);

    const before: number = fetched;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fetched).toBe(before);
  });
});

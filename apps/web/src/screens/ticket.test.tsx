// @vitest-environment happy-dom
/**
 * チケットの画面（10.1）。
 *
 * **確かめたいのは「画面が業務判断をしていない」こと**（CLAUDE.md 3.1）。
 *
 * - 押せる操作は**サーバが返した `actions` のとおり**で、足しも引きもしない
 * - 押したボタンが、**そのボタンの操作**を送る（別の操作に読み替えない）
 * - 状態は**色だけでなく文字**で出る（10.4）
 *
 * 文言は鍵で引く。**テストに日本語を直書きしない** —— 文言を直したときに、
 * テストが「壊れた」のか「変えた」のか分からなくなる。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TICKET_STATES, type TicketState } from '@openseat/core';
import { TicketActionRequest, type TicketResponse, type TicketView } from '@openseat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, tAction, tState } from '../i18n.ts';
import { TicketScreen } from './ticket.tsx';

const SERVER_NOW = Date.UTC(2027, 2, 6, 3, 0, 0);

/** 待っている人。ここから状態ごとに差し替える。 */
const WAITING: TicketView = {
  id: 'tk_1',
  code: 'A-23',
  state: 'WAITING',
  partySize: 2,
  requiredTags: [],
  tableLabel: null,
  holdDeadline: null,
  pauseDeadline: null,
  extensionsLeft: 1,
  eta: { kind: 'estimate', minutes: 12, fromMin: 10, toMin: 15, ahead: 3 },
  timeLimit: null,
  endReason: null,
  actions: ['PAUSE', 'CHANGE_PARTY_SIZE', 'CANCEL'],
};

/** サーバが受け取った操作。**何を送ったかを確かめる。** */
let sent: TicketActionRequest[];

/**
 * サーバの代わり。
 *
 * **本物の `api.ts` を通す。** 契約（Zod）の検証も `?k=` の組み立ても、
 * ここを通らないと確かめたことにならない。
 */
function serve(ticket: TicketView): void {
  const body: TicketResponse = { serverNow: SERVER_NOW, ticket };
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && typeof init.body === 'string') sent.push(actionIn(init.body));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

/**
 * 送られてきた操作。
 *
 * **契約（`packages/shared`）で受ける。** ここを素通しにすると、画面が
 * 契約に無い形を送っていても、テストは気づかないまま通ってしまう。
 */
function actionIn(body: string): TicketActionRequest {
  const parsed = TicketActionRequest.safeParse(JSON.parse(body));
  if (!parsed.success) throw new Error(`契約に無い操作が送られました: ${body}`);
  return parsed.data;
}

/** その画面が出し終わるまで待つ。 */
async function shown(ticket: TicketView): Promise<void> {
  serve(ticket);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/t/tk_1?k=secret-value']}>
        <Routes>
          <Route path="/t/:ticket" element={<TicketScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText(t('ticket.heading', { code: ticket.code }));
}

function press(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---- 7.3 の 8 状態 ----

describe('どの状態でも読める（7.3）', () => {
  it.each(TICKET_STATES)('%s を文字で伝える（色だけに意味を持たせない）', async (state) => {
    await shown({ ...WAITING, state, actions: [] });
    screen.getByText(tState(state));
  });

  it('8 状態すべてに文言がある', () => {
    const said: string[] = TICKET_STATES.map((state: TicketState) => tState(state));
    expect(said).toHaveLength(8);
    expect(new Set(said).size).toBe(8);
  });
});

// ---- 押せる操作 ----

describe('押せる操作', () => {
  it('サーバが返したものだけを出す', async () => {
    await shown({ ...WAITING, actions: ['PAUSE', 'CANCEL'] });
    screen.getByRole('button', { name: tAction('PAUSE') });
    screen.getByRole('button', { name: tAction('CANCEL') });
    // 返っていない操作のボタンは無い。**画面が足さない。**
    expect(screen.queryByRole('button', { name: tAction('EXTEND') })).toBeNull();
    expect(screen.queryByRole('button', { name: tAction('READY') })).toBeNull();
  });

  it('何も返っていなければ、操作のボタンは 1 つも出ない', async () => {
    await shown({ ...WAITING, state: 'DONE', endReason: 'checked_out', actions: [] });
    // 残るのは「URL をコピー」だけである（閉じても戻れる案内。10.4）。
    const buttons: HTMLElement[] = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe(t('ticket.copyLink', {}));
  });

  it('押したボタンの操作を、そのまま送る', async () => {
    await shown({ ...WAITING, state: 'CALLED', tableLabel: 'T-12', actions: ['READY', 'PASS'] });
    press(tAction('READY'));
    await waitFor(() => {
      expect(sent).toEqual([{ action: 'ready' }]);
    });
  });

  it('呼ばれていれば、席の番号を出す', async () => {
    await shown({ ...WAITING, state: 'CALLED', tableLabel: 'T-12', actions: [] });
    screen.getByText(t('ticket.table', { table: 'T-12' }));
  });
});

// ---- 人数の変更 ----

describe('人数を変える（7.6）', () => {
  const CHANGE: string = tAction('CHANGE_PARTY_SIZE');

  it('「人数を変える」が取り消しにならない', async () => {
    // **読み替えると、押した人の順番が消える。** 送るのは人数の変更だけである。
    await shown({ ...WAITING, actions: ['CHANGE_PARTY_SIZE', 'CANCEL'] });
    press(t('join.increase', {}));
    press(CHANGE);

    await waitFor(() => {
      expect(sent).toEqual([{ action: 'change_party_size', partySize: 3 }]);
    });
  });

  it('いまと同じ人数では送れない', async () => {
    await shown({ ...WAITING, actions: ['CHANGE_PARTY_SIZE'] });
    expect(screen.getByRole('button', { name: CHANGE })).toHaveProperty('disabled', true);
  });

  it('1 名より減らせない', async () => {
    await shown({ ...WAITING, partySize: 1, actions: ['CHANGE_PARTY_SIZE'] });
    expect(screen.getByRole('button', { name: t('join.decrease', {}) })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('その操作が返っていなければ、人数を変える枠ごと出ない', async () => {
    await shown({ ...WAITING, actions: ['CANCEL'] });
    expect(screen.queryByRole('button', { name: CHANGE })).toBeNull();
  });
});
